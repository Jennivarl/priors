import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import { getStamp } from './lib/sui.js';
import * as memory from './lib/memory.js';
import * as store from './lib/store.js';
import { fingerprint, calibration, secondOpinion } from './lib/coach.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

let state = store.load();
const persist = () => store.save(state);
const pct = (x) => `${Math.round(x * 100)}%`;

// ---- Walrus write queue: one write at a time, status visible in the UI ----
let queue = Promise.resolve();
function writeMemory(kind, sentence, payload) {
  const entry = { id: crypto.randomUUID(), kind, sentence, status: 'pending', at: new Date().toISOString() };
  state.memories.unshift(entry);
  persist();
  queue = queue.then(async () => {
    try {
      const r = await memory.remember(sentence, payload);
      Object.assign(entry, { status: 'stored', blob_id: r.blob_id });
    } catch (e) {
      Object.assign(entry, { status: 'failed', error: e.message.slice(0, 200) });
      console.error('Walrus write failed:', e.message);
    }
    persist();
  });
  return entry;
}

// After a result, store any lesson that is new or changed, so the coach's learning is itself memory.
function learn() {
  for (const ins of fingerprint(state.picks).insights) {
    if (state.learned[ins.id] === ins.title) continue;
    state.learned[ins.id] = ins.title;
    writeMemory('lesson', `Gut Check coach learned a lesson about my bias: ${ins.title}. ${ins.detail}`, { kind: 'lesson', insight: ins, at: new Date().toISOString() });
  }
}

const parseDraft = (b) => {
  const odds = Number(b.odds);
  const confidence = Number(b.confidence) / (Number(b.confidence) > 1 ? 100 : 1);
  if (!b.subject || !b.category || !(odds > 1) || !(confidence > 0 && confidence < 1)) return null;
  return { subject: String(b.subject).trim(), category: String(b.category).trim(), event: String(b.event || '').trim(), odds, confidence, marketProb: 1 / odds };
};

const view = () => ({
  picks: state.picks,
  memories: state.memories.slice(0, 60),
  fingerprint: fingerprint(state.picks),
  calibration: calibration(state.picks),
  stored: state.memories.filter((m) => m.status === 'stored').length,
});

app.get('/api/state', (_req, res) => res.json(view()));

app.post('/api/opinion', (req, res) => {
  const draft = parseDraft(req.body);
  if (!draft) return res.status(400).json({ error: 'Fill in pick, category, confidence and decimal odds (> 1).' });
  res.json(secondOpinion(state.picks, draft));
});

app.post('/api/picks', async (req, res) => {
  const draft = parseDraft(req.body);
  if (!draft) return res.status(400).json({ error: 'Fill in pick, category, confidence and decimal odds (> 1).' });
  try {
    const stamp = await getStamp();
    const opinion = secondOpinion(state.picks, draft);
    const pick = { id: crypto.randomUUID(), ...draft, createdAt: new Date().toISOString(), status: 'open', stamp, coach: { adjusted: opinion.adjusted, verdict: opinion.verdict } };
    state.picks.unshift(pick);
    writeMemory(
      'pick',
      `Gut Check pick logged: I backed ${pick.subject}${pick.event ? ` in ${pick.event}` : ''} (${pick.category}) at ${pct(pick.confidence)} confidence. Bookmaker implied ${pct(pick.marketProb)} (odds ${pick.odds}). Coach said ${pct(opinion.adjusted)}. Sealed at Sui checkpoint ${stamp.checkpoint}.`,
      { kind: 'pick', pick },
    );
    persist();
    res.json({ pick, opinion, ...view() });
  } catch (e) {
    res.status(502).json({ error: `Could not stamp the pick on Sui: ${e.message}` });
  }
});

app.post('/api/picks/:id/settle', (req, res) => {
  const pick = state.picks.find((p) => p.id === req.params.id);
  const result = req.body.result;
  if (!pick || !['won', 'lost'].includes(result)) return res.status(400).json({ error: 'Unknown pick or result.' });
  if (pick.status !== 'open') return res.status(409).json({ error: 'Already settled.' });
  Object.assign(pick, { status: result, settledAt: new Date().toISOString() });
  writeMemory(
    'result',
    `Gut Check result settled: my pick on ${pick.subject}${pick.event ? ` (${pick.event})` : ''} ${result}. I had said ${pct(pick.confidence)}.`,
    { kind: 'result', id: pick.id, status: result, settledAt: pick.settledAt },
  );
  learn();
  persist();
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
    await queue;
    const mems = await memory.restoreAll();
    const next = { picks: [], memories: [], learned: {} };
    const byId = new Map();
    for (const m of mems) if (m.payload.kind === 'pick') byId.set(m.payload.pick.id, { ...m.payload.pick });
    for (const m of mems) {
      const p = m.payload;
      if (p.kind === 'result' && byId.has(p.id)) Object.assign(byId.get(p.id), { status: p.status, settledAt: p.settledAt });
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

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Gut Check running at http://localhost:${port}`));
