import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as memory from './lib/memory.js';
import * as store from './lib/store.js';
import * as receipt from './lib/receipt.js';
import { fingerprint, calibration, secondOpinion, reasoningEcho } from './lib/coach.js';
import { getPrice } from './lib/oracle.js';
import * as markets from './lib/markets.js';
import { selfReported, sourceFor } from './lib/settle.js';
import { parseDraft, sealPick, pickSentence, reasonSentence, analyzeText, resultSentence, resultPayload, lessonSentence } from './lib/picks.js';
import { WALRUS_MEMORY, accountIdFor, getAccount, waitForTransaction, normalizeAddress } from './lib/walrus-account.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// On Vercel the platform's proxy sets X-Forwarded-For to the real client, so rate limits apply per visitor.
if (process.env.VERCEL) app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(ROOT, 'public')));
// The coach is pure, so the browser runs the same code for wallet users.
app.get('/coach.js', (_req, res) => res.type('text/javascript').sendFile(path.join(ROOT, 'lib', 'coach.js')));

const ECHO_MAX_DISTANCE = Number(process.env.ECHO_MAX_DISTANCE || 0.6);
const fail = (res, e) => res.status(e.status || 502).json({ error: e.message });

// ---- Access control ----
// With OWNER_TOKEN set (hosted), the operator's record is read-only for visitors. Wallet users never
// touch it: they write to their own Walrus Memory with a delegate key their wallet authorised.
const OWNER_TOKEN = process.env.OWNER_TOKEN || '';
const READ_ONLY = Boolean(OWNER_TOKEN);
const sameToken = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Sliding-window counters per visitor, pruned so the map stays small.
const windows = new Map();
function tooMany(key, limit, windowMs) {
  const now = Date.now();
  const h = (windows.get(key) || []).filter((t) => now - t < windowMs);
  if (windows.size > 5000) for (const [k, v] of windows) if (!v.some((t) => now - t < windowMs)) windows.delete(k);
  if (h.length >= limit) {
    windows.set(key, h);
    return true;
  }
  h.push(now);
  windows.set(key, h);
  return false;
}

// Wrong passcodes are limited per visitor, so the owner passcode cannot be guessed by brute force.
const OWNER_FAILURES = { limit: 5, windowMs: 10 * 60_000 };
function ownerOnly(req, res, next) {
  if (!READ_ONLY) return next();
  const t = String(req.get('x-owner-token') || '');
  if (!t) return res.status(403).json({ error: 'This is the sample record. Connect your wallet to keep your own.' });
  const failKey = `owner-fail:${req.ip}`;
  const recent = (windows.get(failKey) || []).filter((x) => Date.now() - x < OWNER_FAILURES.windowMs);
  if (recent.length >= OWNER_FAILURES.limit) return res.status(429).json({ error: 'Too many wrong passcodes. Try again later.' });
  if (sameToken(t, OWNER_TOKEN)) return next();
  tooMany(failKey, Infinity, OWNER_FAILURES.windowMs);
  res.status(403).json({ error: 'Wrong owner passcode.' });
}

// Per-visitor limit on endpoints that spend Walrus or Tatum quota.
const rateLimit = (perMinute) => (req, res, next) => {
  if (tooMany(`${req.ip}:${req.path}`, perMinute, 60_000)) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  next();
};

// Live prices are shared by every visitor for a few seconds, so page loads cannot drain the Tatum quota.
// Settlement reads a fresh price directly.
const priceCache = new Map();
function cachedPrice(asset) {
  const hit = priceCache.get(asset);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  const value = getPrice(asset);
  priceCache.set(asset, { at: Date.now(), value });
  value.catch(() => priceCache.delete(asset));
  return value;
}

// ======================================================================================
// Operator record: the local app (npm start) and the public demo
// ======================================================================================
const OWNER = memory.ownerSpace();
let state = store.load();
const persist = () => store.save(state);

// Write pool: a few writes in flight (each takes 20 to 30 s on Mainnet), status visible in the UI.
const WRITE_CONCURRENCY = Number(process.env.WALRUS_CONCURRENCY || 3);
const jobs = [];
let running = 0;
const idleWaiters = [];
function pump() {
  while (running < WRITE_CONCURRENCY && jobs.length) {
    const job = jobs.shift();
    running++;
    job().finally(() => {
      running--;
      if (!running && !jobs.length) idleWaiters.splice(0).forEach((r) => r());
      pump();
    });
  }
}
function enqueue(job) {
  jobs.push(job);
  pump();
}
const whenIdle = () => (running || jobs.length ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve());

// The entry keeps its payload until stored, so a restart resumes it. entry.id is the idempotency key,
// so a write that was in flight during a crash is never stored twice.
function runWrite(entry) {
  return async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await memory.remember(OWNER, entry.sentence, entry.payload, { reasons: entry.reasons, idempotencyKey: entry.id });
        Object.assign(entry, { status: 'stored', blob_id: r.blob_id });
        delete entry.payload;
        break;
      } catch (e) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        Object.assign(entry, { status: 'failed', error: e.message.slice(0, 200) });
        console.error('Walrus write failed:', e.message);
        break;
      }
    }
    persist();
  };
}

function writeMemory(kind, sentence, payload, { reasons = false } = {}) {
  const entry = { id: crypto.randomUUID(), kind, sentence, payload, reasons, status: 'pending', at: new Date().toISOString() };
  state.memories.unshift(entry);
  persist();
  enqueue(runWrite(entry));
  return entry;
}

for (const entry of state.memories.filter((m) => m.status === 'pending' && m.payload)) enqueue(runWrite(entry));

// After a result, store any lesson that is new or changed, so the coach's learning is itself memory.
function learn() {
  for (const ins of fingerprint(state.picks).insights) {
    if (state.learned[ins.id] === ins.title) continue;
    state.learned[ins.id] = ins.title;
    writeMemory('lesson', lessonSentence(ins), { kind: 'lesson', insight: ins, at: new Date().toISOString() });
  }
}

function applySettlement(pick, s) {
  Object.assign(pick, { status: s.status, settledAt: new Date().toISOString(), verified: s.verified, evidence: s.evidence });
  writeMemory('result', resultSentence(pick, s), resultPayload(pick, s, pick.settledAt));
  learn();
  persist();
}

// Crypto calls and market picks settle themselves. Serverless hosts have no long-running loop.
let settling = false;
async function autoSettle() {
  if (settling) return;
  settling = true;
  try {
    for (const pick of state.picks.filter((p) => p.status === 'open' && (p.crypto || p.market))) {
      try {
        const s = await sourceFor(pick).settle(pick);
        if (s) applySettlement(pick, s);
      } catch (e) {
        console.error(`Auto-settle failed for ${pick.subject}:`, e.message);
      }
    }
  } finally {
    settling = false;
  }
}
if (!process.env.VERCEL) setInterval(autoSettle, 15_000);

// Reasoning echo: past REASONS that mean the same thing as this one (Walrus semantic recall),
// joined with how those picks ended.
async function echoFor(draft) {
  if (draft.reason.length < 8) return null;
  const hits = await memory.recall(OWNER, draft.reason, 12, { reasons: true, maxDistance: ECHO_MAX_DISTANCE });
  const byId = new Map(state.picks.map((p) => [p.id, p]));
  const matches = [];
  for (const h of hits) {
    const p = byId.get(h.payload?.pickId);
    if (p && (p.status === 'won' || p.status === 'lost')) matches.push({ pick: p, distance: h.distance, reason: p.reason });
  }
  return reasoningEcho(matches);
}

async function opinionFor(draft) {
  let echo = null;
  let echoError;
  try {
    echo = await echoFor(draft);
  } catch (e) {
    echoError = `Walrus recall unavailable: ${e.message.slice(0, 120)}`;
  }
  return { ...secondOpinion(state.picks, draft, echo), echoError };
}

const view = () => ({
  picks: state.picks,
  memories: state.memories.slice(0, 60),
  fingerprint: fingerprint(state.picks),
  calibration: calibration(state.picks),
  stored: state.memories.filter((m) => m.status === 'stored').length,
});

app.get('/api/state', (_req, res) => res.json({ ...view(), readOnly: READ_ONLY }));

app.post('/api/opinion', rateLimit(20), async (req, res) => {
  try {
    res.json(await opinionFor(parseDraft(req.body)));
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/picks', ownerOnly, async (req, res) => {
  try {
    let opinion;
    const pick = await sealPick(req.body, async (draft) => {
      opinion = await opinionFor(draft);
      return { adjusted: opinion.adjusted, verdict: opinion.verdict };
    });
    state.picks.unshift(pick);
    writeMemory('pick', pickSentence(pick), { kind: 'pick', pick });
    writeMemory('reason', reasonSentence(pick), { kind: 'reason', pickId: pick.id }, { reasons: true });
    enqueue(async () => {
      try {
        pick.facts = await memory.analyze(OWNER, analyzeText(pick));
        if (pick.facts.length) {
          state.memories.unshift({ id: crypto.randomUUID(), kind: 'analyze', sentence: `Walrus Analyze extracted ${pick.facts.length} fact(s): ${pick.facts.join(' · ')}`, status: 'stored', at: new Date().toISOString() });
        }
        persist();
      } catch (e) {
        console.error('Walrus analyze failed:', e.message);
      }
    });
    persist();
    res.json({ pick, opinion, ...view() });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/picks/:id/settle', ownerOnly, (req, res) => {
  const pick = state.picks.find((p) => p.id === req.params.id);
  if (!pick) return res.status(404).json({ error: 'Unknown pick.' });
  if (pick.status !== 'open') return res.status(409).json({ error: 'Already settled.' });
  if (sourceFor(pick) !== selfReported) return res.status(409).json({ error: 'This pick settles automatically from the chain or its market.' });
  try {
    applySettlement(pick, selfReported.settle(pick, req.body.result));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json(view());
});

app.post('/api/recall', rateLimit(20), async (req, res) => {
  try {
    const hits = await memory.recall(OWNER, String(req.body.query || '').slice(0, 300), 6);
    res.json(hits.map(({ text, blob_id, distance }) => ({ text: text.split('\n##GC')[0], blob_id, distance })));
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/memory-count', async (_req, res) => {
  try {
    res.json({ count: await memory.countMemories(OWNER) });
  } catch (e) {
    fail(res, e);
  }
});

// Wipe local state and rebuild the whole record from Walrus Memory alone.
app.post('/api/restore', ownerOnly, async (_req, res) => {
  try {
    await whenIdle();
    const mems = await memory.restoreAll(OWNER);
    state = store.fromMemories(mems);
    persist();
    res.json({ restored: mems.length, ...view() });
  } catch (e) {
    fail(res, e);
  }
});

// ======================================================================================
// Shared, read-only market and chain data
// ======================================================================================
app.get('/api/events/:category', rateLimit(30), async (req, res) => {
  try {
    res.json({ enabled: true, events: await markets.list(req.params.category) });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/price/:asset', rateLimit(30), async (req, res) => {
  try {
    res.json(await cachedPrice(req.params.asset.toUpperCase()));
  } catch (e) {
    fail(res, e);
  }
});

// ======================================================================================
// Wallet users: each person's record lives in their own Walrus Memory account
// ======================================================================================
app.get('/api/walrus/config', (_req, res) => res.json({ ...WALRUS_MEMORY, delegateLabel: 'Priors' }));

app.get('/api/walrus/account/:address', rateLimit(30), async (req, res) => {
  try {
    const address = normalizeAddress(req.params.address);
    if (!address) return res.status(400).json({ error: 'Not a Sui address.' });
    const accountId = await accountIdFor(address);
    if (!accountId) return res.json({ accountId: null, delegateKeys: [] });
    const account = await getAccount(accountId);
    res.json({ accountId, owner: account.owner, delegateKeys: account.delegateKeys.map((k) => k.publicKey) });
  } catch (e) {
    fail(res, e);
  }
});

// Lets the browser's Walrus Memory SDK wait for a wallet transaction through Tatum.
app.get('/api/sui/tx/:digest', rateLimit(30), async (req, res) => {
  try {
    res.json(await waitForTransaction(req.params.digest));
  } catch (e) {
    fail(res, e);
  }
});

/** Credentials arrive per request over HTTPS and are never stored or logged by the server. */
function walletUser(req, res, next) {
  const key = String(req.get('x-memwal-key') || '').toLowerCase();
  const accountId = normalizeAddress(req.get('x-memwal-account'));
  if (!/^[0-9a-f]{64}$/.test(key) || !accountId) return res.status(401).json({ error: 'Connect your wallet first.' });
  req.space = memory.userSpace({ key, accountId });
  next();
}

const u = express.Router();
u.use(walletUser);

// Is this delegate key authorised on that account onchain? Cached briefly per key, so a signed-in
// user's picks cost no extra lookups, while made-up credentials are refused before any Tatum call.
const authorised = new Map();
const NOT_AUTHORISED = 'This key is not authorised on that Walrus Memory account.';
async function authorisedKey(space) {
  const publicKey = await memory.publicKeyHex(space);
  const id = `${space.creds.accountId}:${publicKey}`;
  const hit = authorised.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  let account;
  try {
    account = await getAccount(space.creds.accountId);
  } catch (e) {
    if (e.code === 'NOT_FOUND' || /not a Walrus Memory account/.test(e.message)) return null;
    throw e;
  }
  const key = account.delegateKeys.find((k) => k.publicKey === publicKey);
  if (!key || !account.active || account.quarantined) return null;
  const value = { account, key, publicKey };
  authorised.set(id, { at: Date.now(), value });
  if (authorised.size > 1000) authorised.delete(authorised.keys().next().value);
  return value;
}

u.post('/session', rateLimit(20), async (req, res) => {
  try {
    const ok = await authorisedKey(req.space);
    if (!ok) return res.status(401).json({ error: NOT_AUTHORISED });
    const { account, key, publicKey } = ok;
    // The key is onchain; make sure the Walrus relayer accepts it too (it can lag a few seconds).
    let memories;
    try {
      memories = await memory.countMemories(req.space);
    } catch (e) {
      if (/401|AUTH/i.test(e.message)) return res.status(425).json({ error: 'Walrus is still registering this key. Try again in a moment.' });
      throw e;
    }
    res.json({ ok: true, owner: account.owner, label: key.label, publicKey, memories });
  } catch (e) {
    fail(res, e);
  }
});

const toJob = async (space, kind, sentence, payload, opts) => ({ kind, sentence, jobId: await memory.rememberAsync(space, sentence, payload, opts) });

u.post('/picks', rateLimit(20), async (req, res) => {
  try {
    if (!(await authorisedKey(req.space))) return res.status(401).json({ error: NOT_AUTHORISED });
    const c = req.body.coach || {};
    const adjusted = Number(c.adjusted);
    const coach = { adjusted: adjusted >= 0 && adjusted <= 1 ? adjusted : 0.5, verdict: String(c.verdict || '').slice(0, 200) };
    const pick = await sealPick(req.body, async () => coach);
    pick.receipt = receipt.sign(pick);
    const written = await Promise.all([
      toJob(req.space, 'pick', pickSentence(pick), { kind: 'pick', pick }, { idempotencyKey: `${pick.id}:pick` }),
      toJob(req.space, 'reason', reasonSentence(pick), { kind: 'reason', pickId: pick.id }, { reasons: true, idempotencyKey: `${pick.id}:reason` }),
    ]);
    const facts = await memory.analyze(req.space, analyzeText(pick)).catch(() => []);
    res.json({ pick, jobs: written, facts });
  } catch (e) {
    fail(res, e);
  }
});

u.post('/settle', rateLimit(60), async (req, res) => {
  try {
    const pick = req.body.pick;
    if (!receipt.verify(pick)) return res.status(400).json({ error: 'This pick does not match what Priors sealed, so it cannot be settled.' });
    if (pick.status !== 'open') return res.status(409).json({ error: 'Already settled.' });
    const source = sourceFor(pick);
    const s = source === selfReported ? selfReported.settle(pick, req.body.result) : await source.settle(pick);
    if (!s) return res.json({ pending: true });
    const settledAt = new Date().toISOString();
    const settled = { ...pick, status: s.status, settledAt, verified: s.verified, evidence: s.evidence };
    const job = await toJob(req.space, 'result', resultSentence(pick, s), resultPayload(pick, s, settledAt), { idempotencyKey: `${pick.id}:result` });
    res.json({ pick: settled, jobs: [job] });
  } catch (e) {
    fail(res, e);
  }
});

u.post('/lessons', rateLimit(20), async (req, res) => {
  try {
    const lessons = (Array.isArray(req.body.lessons) ? req.body.lessons : []).slice(0, 12).map((i) => ({
      id: String(i.id || '').slice(0, 80),
      kind: String(i.kind || '').slice(0, 20),
      title: String(i.title || '').slice(0, 160),
      detail: String(i.detail || '').slice(0, 300),
      bias: Number(i.bias) || 0,
      n: Number(i.n) || 0,
    }));
    const at = new Date().toISOString();
    const written = await Promise.all(
      lessons.filter((i) => i.id && i.title).map((i) => {
        const key = crypto.createHash('sha256').update(`${i.id}:${i.title}`).digest('hex').slice(0, 32);
        return toJob(req.space, 'lesson', lessonSentence(i), { kind: 'lesson', insight: i, at }, { idempotencyKey: `lesson:${key}` });
      }),
    );
    res.json({ jobs: written });
  } catch (e) {
    fail(res, e);
  }
});

u.post('/jobs', rateLimit(60), async (req, res) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).slice(0, 40).map(String);
    res.json(await Promise.all(ids.map(async (id) => ({ id, ...(await memory.jobStatus(req.space, id).catch((e) => ({ status: 'unknown', error: e.message }))) }))));
  } catch (e) {
    fail(res, e);
  }
});

u.post('/echo', rateLimit(60), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').slice(0, 400);
    if (reason.length < 8) return res.json([]);
    const hits = await memory.recall(req.space, reason, 12, { reasons: true, maxDistance: ECHO_MAX_DISTANCE });
    res.json(hits.filter((h) => h.payload?.pickId).map((h) => ({ pickId: h.payload.pickId, distance: h.distance })));
  } catch (e) {
    fail(res, e);
  }
});

u.post('/recall', rateLimit(20), async (req, res) => {
  try {
    const hits = await memory.recall(req.space, String(req.body.query || '').slice(0, 300), 6);
    res.json(hits.map(({ text, blob_id, distance }) => ({ text: text.split('\n##GC')[0], blob_id, distance })));
  } catch (e) {
    fail(res, e);
  }
});

u.post('/restore', rateLimit(6), async (req, res) => {
  try {
    const mems = await memory.restoreAll(req.space);
    res.json({ restored: mems.length, state: store.fromMemories(mems) });
  } catch (e) {
    fail(res, e);
  }
});

u.get('/count', rateLimit(20), async (req, res) => {
  try {
    res.json({ count: await memory.countMemories(req.space) });
  } catch (e) {
    fail(res, e);
  }
});

app.use('/api/u', u);

export default app;

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => console.log(`Priors running at http://localhost:${port}${READ_ONLY ? ' (demo record is read-only)' : ''}`));
}
