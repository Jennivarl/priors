import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import { getStamp } from './lib/sui.js';
import * as memory from './lib/memory.js';
import * as store from './lib/store.js';
import { fingerprint, calibration, secondOpinion, reasoningEcho } from './lib/coach.js';
import { getPrice } from './lib/oracle.js';
import * as odds from './lib/odds.js';
import { onchainPrice, selfReported, sourceFor, parseCrypto, commitment } from './lib/settle.js';

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static('public'));

let state = store.load();
const persist = () => store.save(state);
const pct = (x) => `${Math.round(x * 100)}%`;

// ---- Walrus write pool: a few writes in flight (each takes ~25s on Mainnet), status visible in the UI ----
const WRITE_CONCURRENCY = Number(process.env.WALRUS_CONCURRENCY || 3);
const jobs = [];
let running = 0;
let idleWaiters = [];
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

// The entry keeps its payload until stored, so a restart can resume it. entry.id doubles as the
// idempotency key, so a write that was in flight during a crash is never stored twice.
function runWrite(entry) {
  return async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await memory.remember(entry.sentence, entry.payload, entry.namespace, entry.id);
        Object.assign(entry, { status: 'stored', blob_id: r.blob_id });
        delete entry.payload;
        break;
      } catch (e) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt)); // relayer is busy on deadline day
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

function writeMemory(kind, sentence, payload, namespace = memory.NAMESPACE) {
  const entry = { id: crypto.randomUUID(), kind, sentence, payload, namespace, status: 'pending', at: new Date().toISOString() };
  state.memories.unshift(entry);
  persist();
  enqueue(runWrite(entry));
  return entry;
}

// Resume writes that were still pending when the server last stopped.
for (const entry of state.memories.filter((m) => m.status === 'pending' && m.payload)) enqueue(runWrite(entry));

// After a result, store any lesson that is new or changed, so the coach's learning is itself memory.
function learn() {
  for (const ins of fingerprint(state.picks).insights) {
    if (state.learned[ins.id] === ins.title) continue;
    state.learned[ins.id] = ins.title;
    writeMemory('lesson', `Gut Check coach learned a lesson about my bias: ${ins.title}. ${ins.detail}`, { kind: 'lesson', insight: ins, at: new Date().toISOString() });
  }
}

const DRAFT_ERROR = 'Fill in pick, category, confidence and decimal odds (> 1).';
/** Returns a clean draft pick, or throws an Error with a message the user can act on. */
function parseDraft(b) {
  const odds = Number(b.odds);
  const confidence = Number(b.confidence) / (Number(b.confidence) > 1 ? 100 : 1);
  const crypto = b.kind === 'crypto' ? parseCrypto(b) : null;
  const subject = crypto ? `${crypto.asset} ${crypto.direction} $${crypto.target}` : String(b.subject || '').trim();
  const category = crypto ? 'Crypto' : String(b.category || '').trim();
  if (!subject || !category || !(odds > 1) || !(confidence > 0 && confidence < 1)) throw new Error(DRAFT_ERROR);
  return {
    subject,
    category,
    event: crypto ? `by ${crypto.deadline.slice(11, 16)} UTC` : String(b.event || '').trim(),
    reason: String(b.reason || '').trim().slice(0, 400),
    odds,
    confidence,
    marketProb: 1 / odds,
    ...(crypto ? { crypto } : {}),
  };
}

/** Apply a settlement from any ResultSource, remember it on Walrus, and let the coach learn. */
function applySettlement(pick, s) {
  Object.assign(pick, { status: s.status, settledAt: new Date().toISOString(), verified: s.verified, evidence: s.evidence });
  const proof = s.verified
    ? `Verified onchain: ${pick.crypto.asset} was $${s.evidence.usd.toFixed(4)} at Sui checkpoint ${s.evidence.checkpoint} (target ${s.evidence.direction} $${s.evidence.target}).`
    : 'Self-reported, unverified.';
  writeMemory(
    'result',
    `Gut Check result settled: my pick on ${pick.subject}${pick.event ? ` (${pick.event})` : ''} ${s.status}. I had said ${pct(pick.confidence)}. ${proof}`,
    { kind: 'result', id: pick.id, status: s.status, settledAt: pick.settledAt, verified: s.verified, evidence: s.evidence },
  );
  learn();
  persist();
}

// Crypto picks settle themselves once their deadline passes. No human in the loop.
let settling = false;
async function autoSettle() {
  if (settling) return;
  settling = true;
  try {
    for (const pick of state.picks.filter((p) => p.status === 'open' && p.crypto)) {
      try {
        const s = await onchainPrice.settle(pick);
        if (s) applySettlement(pick, s);
      } catch (e) {
        console.error(`Auto-settle failed for ${pick.subject}:`, e.message);
      }
    }
  } finally {
    settling = false;
  }
}
setInterval(autoSettle, 15_000);

// Reasoning echo: ask Walrus Memory which past REASONS mean the same thing as this one,
// then look up how those picks ended. Semantic recall is what makes this possible.
const ECHO_MAX_DISTANCE = Number(process.env.ECHO_MAX_DISTANCE || 0.75);
async function echoFor(draft) {
  if (draft.reason.length < 8) return null;
  const hits = await memory.recall(draft.reason, 12, memory.REASONS, ECHO_MAX_DISTANCE);
  const byId = new Map(state.picks.map((p) => [p.id, p]));
  const matches = [];
  for (const h of hits) {
    const p = byId.get(h.payload?.pickId);
    if (p && (p.status === 'won' || p.status === 'lost')) matches.push({ pick: p, distance: h.distance, reason: p.reason });
  }
  return reasoningEcho(matches);
}

const view = () => ({
  picks: state.picks,
  memories: state.memories.slice(0, 60),
  fingerprint: fingerprint(state.picks),
  calibration: calibration(state.picks),
  stored: state.memories.filter((m) => m.status === 'stored').length,
});

app.get('/api/state', (_req, res) => res.json(view()));

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

app.post('/api/opinion', async (req, res) => {
  let draft;
  try {
    draft = parseDraft(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json(await opinionFor(draft));
});

app.get('/api/events/:category', async (req, res) => {
  if (!odds.enabled()) return res.json({ enabled: false, events: [] });
  try {
    res.json({ enabled: true, events: await odds.upcoming(req.params.category) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/price/:asset', async (req, res) => {
  try {
    res.json(await getPrice(req.params.asset.toUpperCase()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/picks', async (req, res) => {
  let draft;
  try {
    draft = parseDraft(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (draft.reason.length < 8) return res.status(400).json({ error: 'Say why you like this pick (at least a few words). The coach learns from your reasoning.' });
  // Price source: live bookmaker odds when an event was chosen from the feed, otherwise manual (labelled).
  draft.oddsSource = { kind: 'manual' };
  if (!draft.crypto && req.body.eventId && odds.enabled()) {
    try {
      const live = await odds.priceFor(draft.category, req.body.eventId, draft.subject);
      Object.assign(draft, { odds: live.odds, marketProb: 1 / live.odds, event: live.event, commence: live.commence });
      draft.oddsSource = { kind: 'bookmaker', bookmaker: live.bookmaker, eventId: live.eventId };
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  } else if (draft.crypto) {
    draft.oddsSource = { kind: 'manual', note: 'your own price for this crypto call' };
  }
  try {
    const [stamp, opinion, startPrice] = await Promise.all([
      getStamp(),
      opinionFor(draft),
      draft.crypto ? getPrice(draft.crypto.asset) : null,
    ]);
    if (startPrice) draft.crypto.startPrice = startPrice.usd;
    const pick = { id: crypto.randomUUID(), ...draft, createdAt: new Date().toISOString(), status: 'open', stamp, coach: { adjusted: opinion.adjusted, verdict: opinion.verdict } };
    pick.commitment = commitment(pick);
    state.picks.unshift(pick);
    writeMemory(
      'pick',
      `Gut Check pick logged: I backed ${pick.subject}${pick.event ? ` in ${pick.event}` : ''} (${pick.category}) at ${pct(pick.confidence)} confidence. ${pick.oddsSource.kind === 'bookmaker' ? `${pick.oddsSource.bookmaker} odds` : 'My own typed odds'} implied ${pct(pick.marketProb)} (odds ${pick.odds}).${pick.crypto ? ` ${pick.crypto.asset} was $${pick.crypto.startPrice?.toFixed(4)} onchain when I called it.` : ''} Why: ${pick.reason}. Commitment sha256 ${pick.commitment}, Sui checkpoint digest ${stamp.digest}. Coach said ${pct(opinion.adjusted)}. Sealed at Sui checkpoint ${stamp.checkpoint}.`,
      { kind: 'pick', pick },
    );
    writeMemory('reason', `My reason for backing ${pick.subject} (${pick.category}): ${pick.reason}`, { kind: 'reason', pickId: pick.id }, memory.REASONS);
    enqueue(async () => {
      // Walrus Analyze turns the free-text reason into stored facts the coach can recall later.
      try {
        pick.facts = await memory.analyze(`I am backing ${pick.subject} in ${pick.event || pick.category} because ${pick.reason}`);
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
    res.status(502).json({ error: `Could not stamp the pick on Sui: ${e.message}` });
  }
});

app.post('/api/picks/:id/settle', (req, res) => {
  const pick = state.picks.find((p) => p.id === req.params.id);
  if (!pick) return res.status(404).json({ error: 'Unknown pick.' });
  if (pick.status !== 'open') return res.status(409).json({ error: 'Already settled.' });
  if (sourceFor(pick) !== selfReported) return res.status(409).json({ error: 'Crypto picks settle automatically from the onchain price at the deadline.' });
  try {
    applySettlement(pick, selfReported.settle(pick, req.body.result));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json(view());
});

// Semantic search over your own memory on Walrus: "ask your past self".
app.post('/api/recall', async (req, res) => {
  try {
    const hits = await memory.recall(String(req.body.query || ''), 6);
    res.json(hits.map(({ text, blob_id, distance }) => ({ text: text.split('\n##GC')[0], blob_id, distance })));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/memory-count', async (_req, res) => {
  try {
    res.json({ count: await memory.countMemories(), namespace: memory.NAMESPACE });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Wipe local state and rebuild the whole app from Walrus Memory alone.
app.post('/api/restore', async (_req, res) => {
  try {
    await whenIdle();
    const mems = await memory.restoreAll();
    const next = { picks: [], memories: [], learned: {} };
    const byId = new Map();
    for (const m of mems) if (m.payload.kind === 'pick') byId.set(m.payload.pick.id, { ...m.payload.pick });
    for (const m of mems) {
      const p = m.payload;
      if (p.kind === 'result' && byId.has(p.id)) Object.assign(byId.get(p.id), { status: p.status, settledAt: p.settledAt, verified: Boolean(p.verified), evidence: p.evidence });
      if (p.kind === 'lesson') next.learned[p.insight.id] = p.insight.title;
      next.memories.push({ id: m.blob_id, kind: p.kind, sentence: m.text.split('\n##GC')[0], status: 'stored', blob_id: m.blob_id, at: p.at || p.settledAt || p.pick?.createdAt || '' });
    }
    next.picks = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    next.memories.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    state = next;
    persist();
    res.json({ restored: mems.length, ...view() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// The server holds your Walrus delegate key and Tatum key, so it only listens on this computer by default.
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Gut Check running at http://localhost:${port}`));
