import { fingerprint, calibration, secondOpinion, reasoningEcho } from './coach.js';

const $ = (s) => document.querySelector(s);
const pct = (x) => `${Math.round(x * 100)}%`;
const pts = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x * 100))} pts`;
const short = (s) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : '');
const shortAddr = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('en-GB');
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SUISCAN = 'https://suiscan.xyz/mainnet/checkpoint/';
const form = $('#pick-form');

const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k) || 'null');
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage blocked: the session lasts until the tab closes */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage blocked */
    }
  },
};

let ownerToken = store.get('priors-owner') || '';
// A wallet session: { address, accountId, key, publicKey, via }. The key is the delegate key the
// user's wallet authorised for Priors. It can read and write their memories, never move funds.
let session = store.get('priors-session');

async function request(path, body, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  const res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status });
  return json;
}
const api = (path, body) => request(path, body, ownerToken ? { 'x-owner-token': ownerToken } : {});
const userHeaders = (s = session) => ({ 'x-memwal-key': s.key, 'x-memwal-account': s.accountId });
const uapi = (path, body) => request(`/api/u${path}`, body, userHeaders());
const formData = () => Object.fromEntries(new FormData(form).entries());

// ======================================================================================
// Records: whose picks are on screen
// ======================================================================================
// Operator record: lives on the server (the local app, or the read-only demo when hosted).
const operator = {
  readOnly: false,
  async view() {
    const v = await api('/api/state');
    this.readOnly = v.readOnly;
    return v;
  },
  opinion: (d) => api('/api/opinion', d),
  async seal(d) {
    const r = await api('/api/picks', d);
    return { pick: r.pick, view: r };
  },
  async settle(id, result) {
    return api(`/api/picks/${id}/settle`, { result });
  },
  recall: (query) => api('/api/recall', { query }),
  async restore() {
    const r = await api('/api/restore', {});
    return { restored: r.restored, view: r };
  },
};

// Wallet record: lives in this browser and in the user's own Walrus Memory, so it can be rebuilt anywhere.
const wallet = {
  key: () => `priors-record-${session.accountId}`,
  load() {
    return { picks: [], memories: [], learned: {}, ...(store.get(this.key()) || {}) };
  },
  save(s) {
    store.set(this.key(), s);
  },
  async view() {
    const s = this.load();
    return {
      picks: s.picks,
      memories: s.memories.slice(0, 60),
      fingerprint: fingerprint(s.picks),
      calibration: calibration(s.picks),
      stored: s.memories.filter((m) => m.status === 'stored').length,
      readOnly: false,
    };
  },
  async opinion(d) {
    const s = this.load();
    const draft = draftOf(d);
    let echo = null;
    let echoError;
    if (draft.reason.length >= 8) {
      try {
        const hits = await uapi('/echo', { reason: draft.reason });
        const byId = new Map(s.picks.map((p) => [p.id, p]));
        const matches = hits
          .map((h) => ({ pick: byId.get(h.pickId), distance: h.distance }))
          .filter((m) => m.pick && (m.pick.status === 'won' || m.pick.status === 'lost'))
          .map((m) => ({ ...m, reason: m.pick.reason }));
        echo = reasoningEcho(matches);
      } catch (e) {
        echoError = e.message;
      }
    }
    return { ...secondOpinion(s.picks, draft, echo), echoError };
  },
  async seal(d) {
    const o = await this.opinion(d);
    const r = await uapi('/picks', { ...d, coach: { adjusted: o.adjusted, verdict: o.verdict } });
    const s = this.load();
    s.picks.unshift(r.pick);
    addJobs(s, r.jobs);
    if (r.facts?.length) s.memories.unshift({ id: crypto.randomUUID(), kind: 'analyze', sentence: `Walrus Analyze extracted ${r.facts.length} fact(s): ${r.facts.join(' · ')}`, status: 'stored', at: new Date().toISOString() });
    this.save(s);
    return { pick: r.pick, view: await this.view() };
  },
  async settle(id, result) {
    const s = this.load();
    const pick = s.picks.find((p) => p.id === id);
    if (!pick) throw new Error('Unknown pick.');
    const r = await uapi('/settle', { pick, result });
    if (!r.pending) await this.applySettled(r);
    return this.view();
  },
  async applySettled(r) {
    const s = this.load();
    const i = s.picks.findIndex((p) => p.id === r.pick.id);
    if (i < 0) return;
    s.picks[i] = r.pick;
    addJobs(s, r.jobs);
    const changed = fingerprint(s.picks).insights.filter((ins) => s.learned[ins.id] !== ins.title);
    this.save(s);
    if (changed.length) {
      const l = await uapi('/lessons', { lessons: changed }).catch(() => null);
      const s2 = this.load();
      for (const ins of changed) s2.learned[ins.id] = ins.title;
      if (l) addJobs(s2, l.jobs);
      this.save(s2);
    }
  },
  recall: (query) => uapi('/recall', { query }),
  async restore() {
    const r = await uapi('/restore', {});
    this.save(r.state);
    return { restored: r.restored, view: await this.view() };
  },
};

const record = () => (session ? wallet : operator);

function addJobs(s, jobs = []) {
  for (const j of jobs) s.memories.unshift({ id: j.jobId, jobId: j.jobId, kind: j.kind, sentence: j.sentence, status: 'pending', at: new Date().toISOString() });
}

/** The same draft the server builds, so the coach can run in the browser for wallet users. */
function draftOf(d) {
  const odds = Number(d.odds);
  const confidence = Number(d.confidence) / 100;
  const crypto = d.kind === 'crypto';
  return {
    subject: crypto ? `${d.asset} ${d.direction} $${d.target}` : String(d.subject || '').trim(),
    category: crypto ? 'Crypto' : String(d.category || '').trim(),
    reason: String(d.reason || '').trim(),
    odds,
    confidence,
    marketProb: odds > 1 ? 1 / odds : 0.5,
  };
}

// Background work for wallet users: memory jobs finishing, picks settling, while the page is open.
async function pollJobs() {
  if (!session) return;
  const s = wallet.load();
  const pending = s.memories.filter((m) => m.status === 'pending' && m.jobId).slice(0, 40);
  if (!pending.length) return;
  try {
    const res = await uapi('/jobs', { ids: pending.map((m) => m.jobId) });
    const s2 = wallet.load();
    for (const r of res) {
      const m = s2.memories.find((x) => x.jobId === r.id);
      if (!m) continue;
      if (r.status === 'done') Object.assign(m, { status: 'stored', blob_id: r.blob_id });
      if (r.status === 'failed' || r.status === 'not_found') Object.assign(m, { status: 'failed', error: r.error || r.status });
    }
    wallet.save(s2);
    render(await wallet.view());
  } catch {
    /* try again on the next tick */
  }
}

const lastMarketCheck = new Map();
async function settleDue() {
  if (!session) return;
  const now = Date.now();
  const due = wallet.load().picks.filter((p) => {
    if (p.status !== 'open') return false;
    if (p.crypto) return new Date(p.crypto.deadline).getTime() <= now;
    if (p.market) return now - (lastMarketCheck.get(p.id) || 0) > 5 * 60_000;
    return false;
  });
  let changed = false;
  for (const p of due) {
    if (p.market) lastMarketCheck.set(p.id, now);
    try {
      const r = await uapi('/settle', { pick: p });
      if (!r.pending) {
        await wallet.applySettled(r);
        changed = true;
      }
    } catch {
      /* the chain or the market may be slow; next tick retries */
    }
  }
  if (changed) render(await wallet.view());
}
setInterval(() => {
  pollJobs();
  settleDue();
}, 4000);

// ======================================================================================
// Form: sports and politics (Polymarket), crypto (onchain price), the live second opinion
// ======================================================================================
let events = [];
async function loadEvents() {
  const cat = form.elements.category.value;
  try {
    const r = await api(`/api/events/${encodeURIComponent(cat)}`);
    events = r.events || [];
    if (events.length) {
      form.dataset.feed = '1';
      form.elements.marketId.innerHTML =
        `<option value="">Not listed, type it yourself</option>` +
        events.map((e) => `<option value="${esc(e.marketId)}">${esc(e.label === e.event ? e.event : `${e.label} · ${e.event}`)} · ${esc(e.starts.slice(5, 16).replace('T', ' '))}</option>`).join('');
      form.elements.side.innerHTML = '';
    } else {
      delete form.dataset.feed;
      $('#odds-src').textContent = 'no open markets here, typed by you';
    }
  } catch {
    delete form.dataset.feed;
    $('#odds-src').textContent = 'market feed unavailable, typed by you';
  }
}

function applyEventOdds() {
  if (!form.dataset.feed) {
    delete form.dataset.market;
    form.elements.odds.readOnly = false;
    return;
  }
  const ev = events.find((e) => e.marketId === form.elements.marketId.value);
  if (!ev) {
    delete form.dataset.market;
    form.elements.side.innerHTML = '';
    form.elements.odds.readOnly = false;
    $('#odds-src').textContent = 'decimal, typed by you';
    return;
  }
  form.dataset.market = '1';
  const keep = form.elements.side.value;
  form.elements.side.innerHTML = ev.options.map((o) => `<option value="${esc(o.side)}">${esc(o.subject)} · ${pct(o.prob)}</option>`).join('');
  if (ev.options.some((o) => o.side === keep)) form.elements.side.value = keep;
  const o = ev.options.find((x) => x.side === form.elements.side.value) || ev.options[0];
  form.elements.subject.value = o.subject;
  form.elements.event.value = ev.event;
  form.elements.odds.value = (1 / o.prob).toFixed(2);
  form.elements.odds.readOnly = true;
  $('#odds-src').textContent = `live Polymarket price, ${pct(o.prob)}`;
}

async function loadPrice() {
  const asset = form.elements.asset.value;
  $('#live-price').textContent = `Reading ${asset} from Sui`;
  try {
    const p = await api(`/api/price/${asset}`);
    $('#live-price').textContent = `${asset} $${p.usd.toFixed(4)} now · Cetus pool · checkpoint ${nf.format(p.checkpoint)} · settles from this source`;
    if (!form.elements.target.value) form.elements.target.value = (p.usd * 1.002).toPrecision(4);
  } catch {
    $('#live-price').textContent = 'Onchain price unavailable right now';
  }
}

function setKind() {
  form.dataset.kind = form.elements.kind.value;
  if (form.dataset.kind === 'crypto') {
    form.elements.odds.readOnly = false;
    $('#odds-src').textContent = 'your own price for this call';
    loadPrice();
  } else {
    loadEvents().then(applyEventOdds);
  }
}

function placeRule(gut, coach, market) {
  $('#o-rule').classList.add('on');
  $('#r-gut').style.left = `${gut * 100}%`;
  $('#r-coach').style.left = `${coach * 100}%`;
  $('#r-mkt').style.left = `${market * 100}%`;
  $('#r-span').style.left = `${Math.min(gut, coach) * 100}%`;
  $('#r-span').style.width = `${Math.abs(gut - coach) * 100}%`;
}

let opinionTimer;
function refreshOpinion() {
  clearTimeout(opinionTimer);
  const d = formData();
  $('#conf-val').textContent = `${d.confidence}%`;
  $('#o-gut').textContent = `${d.confidence}%`;
  opinionTimer = setTimeout(async () => {
    const ready = d.kind === 'crypto' ? Number(d.target) > 0 : d.subject;
    if (!ready || !(Number(d.odds) > 1)) return;
    $('#o-verdict').textContent = 'Checking your record on Walrus';
    try {
      const o = await record().opinion(d);
      $('#opinion').classList.toggle('has', Math.abs(o.adjusted - o.gut) >= 0.01);
      $('#o-adj').textContent = pct(o.adjusted);
      $('#o-mkt').textContent = pct(o.market);
      placeRule(o.gut, o.adjusted, o.market);
      $('#o-reasons').innerHTML = o.reasons
        .map((r) => {
          const i = r.lastIndexOf(': ');
          const label = i > 0 ? r.slice(0, i) : r;
          const delta = i > 0 ? r.slice(i + 2) : '';
          return `<li><span>${esc(label)}</span><span class="d ${delta.startsWith('+') ? 'up' : ''}">${esc(delta)}</span></li>`;
        })
        .join('');
      const e = o.echo;
      $('#o-echo').innerHTML = o.echoError
        ? `<span class="head-line">Walrus recall unavailable</span>`
        : e
          ? `<span class="head-line">Walrus found ${e.n} past pick${e.n === 1 ? '' : 's'} where you argued the same way</span>` +
            e.examples.map((x) => `<div class="qr"><span class="txt">“${esc(x.reason)}” · ${esc(x.subject)}</span><span class="m"><span class="l">${x.status}</span> · ${Math.round(x.similarity * 100)}% alike</span></div>`).join('')
          : d.reason?.length >= 8
            ? '<span class="head-line">Walrus recall: no past reasoning like this yet</span>'
            : '';
      $('#o-verdict').textContent = o.verdict;
    } catch (err) {
      $('#o-verdict').textContent = err.message;
    }
  }, 450);
}

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.form !== form) return;
  if (t.name === 'kind') setKind();
  if (t.name === 'category') loadEvents().then(applyEventOdds);
  if (t.name === 'marketId' || t.name === 'side') applyEventOdds();
  if (t.name === 'asset') {
    form.elements.target.value = '';
    loadPrice();
  }
  refreshOpinion();
});

// Signed-out visitors on the hosted site see the sample record: they can try the coach on it,
// and sealing a pick of their own starts with connecting a wallet.
const isSample = () => !session && operator.readOnly && !ownerToken;
const sealLabel = () => (isSample() ? 'Connect wallet to seal your pick' : 'Seal on Sui and remember');

/** Scroll to a pick in Open picks and light it up briefly, so a new pick is easy to find. */
function showPick(id) {
  const row = document.querySelector(`#open-list [data-pick="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('fresh');
  void row.offsetWidth;
  row.classList.add('fresh');
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (isSample()) return openConnect();
  const btn = $('#submit');
  const label = btn.querySelector('span');
  const receiptBox = $('#receipt');
  btn.disabled = true;
  label.textContent = 'Sealing on Sui, a few seconds';
  receiptBox.className = 'receipt';
  receiptBox.textContent = '';
  try {
    const { pick, view } = await record().seal(formData());
    const s = pick.stamp;
    receiptBox.className = 'receipt ok';
    receiptBox.innerHTML =
      `<b>Sealed: ${esc(pick.subject)}</b> <button type="button" class="link" id="see-pick">See it in open picks</button>` +
      `<span class="mono">Sui checkpoint <a href="${SUISCAN}${s.checkpoint}" target="_blank" rel="noopener">${nf.format(s.checkpoint)}</a> · ${esc(s.timestamp.slice(11, 19))} UTC · commitment ${esc(short(pick.commitment))} · saving to Walrus</span>`;
    render(view);
    $('#see-pick').addEventListener('click', () => showPick(pick.id));
    ['event', 'subject', 'reason', 'target'].forEach((n) => (form.elements[n].value = ''));
    if (!form.elements.odds.readOnly) form.elements.odds.value = '';
    if (form.dataset.kind === 'crypto') loadPrice();
  } catch (e) {
    receiptBox.className = 'receipt err';
    receiptBox.textContent = e.message;
  } finally {
    btn.disabled = false;
    label.textContent = sealLabel();
  }
});

// ======================================================================================
// Render
// ======================================================================================
const how = (p) => (!p.verified ? 'self-reported' : p.crypto ? 'verified onchain' : 'market resolved');
const proof = (p) => (!p.verified ? '' : p.crypto ? ` · settled at $${p.evidence.usd.toFixed(4)}, checkpoint ${nf.format(p.evidence.checkpoint)}` : ` · Polymarket ${esc(p.evidence.marketId)}`);
// The first memories were written under the app's working name, so both prefixes are trimmed.
const cleanMemory = (t) => {
  const x = String(t).replace(/^(Gut Check|Priors)\s+(coach\s+)?/i, '');
  return x.charAt(0).toUpperCase() + x.slice(1);
};
const gutToCoach = (p) => `<span class="cmp-figs"><span class="pen struck">${pct(p.confidence)}</span> <span class="to">${pct(p.coach?.adjusted ?? p.confidence)}</span></span>`;

function renderStats(v) {
  const done = v.picks.filter((p) => p.status === 'won' || p.status === 'lost');
  const open = v.picks.filter((p) => p.status === 'open');
  const said = done.length ? done.reduce((a, p) => a + p.confidence, 0) / done.length : 0;
  const hit = done.length ? done.filter((p) => p.status === 'won').length / done.length : 0;
  $('#st-said').textContent = done.length ? pct(said) : '–';
  $('#st-hit').textContent = done.length ? pct(hit) : '–';
  $('#st-gap').innerHTML = done.length ? `<span class="${hit < said ? 'bad' : ''}">${pts(hit - said)}</span> vs what you said` : 'hit rate';
  $('#st-ver').textContent = done.length ? String(done.filter((p) => p.verified).length) : '–';
  $('#st-ver-of').textContent = done.length ? `of ${done.length} settled` : 'by chain or market';
  $('#st-open').textContent = String(open.length);
  const first = v.picks.map((p) => p.createdAt).sort()[0];
  const sample = isSample();
  $('#head-title').textContent = sample ? 'Sample record' : 'Your record';
  $('#head-sub').textContent = first
    ? `${sample ? 'A sample forecaster · ' : ''}${v.picks.length} picks sealed on Sui since ${day(first)}`
    : session
      ? 'Log your first pick below'
      : 'The coach that remembers how you are wrong';
  if (sample) {
    const lessons = v.fingerprint.insights.length;
    $('#intro-facts').textContent = `${v.picks.length} picks sealed on Sui, ${done.filter((p) => p.verified).length} results settled onchain, ${lessons} lessons kept in Walrus Memory`;
  }
}

function renderWho() {
  const demo = !session && operator.readOnly;
  $('#demo-banner').hidden = !isSample();
  $('#owner-box').hidden = !demo;
  $('#coach-label').textContent = isSample() ? 'Coach, from the sample record' : 'Coach, from your record';
  $('#submit span').textContent = sealLabel();
  $('#wallet-btn').hidden = Boolean(session);
  $('#account-btn').hidden = !session;
  if (session) $('#account-addr').textContent = shortAddr(session.address || session.accountId);
  $('#restore-msg').textContent = session
    ? 'Your record lives in this browser and in your Walrus Memory. Rebuild brings it back on any device'
    : 'Every pick, reason, result and lesson is a memory on Walrus Mainnet';
}

function render(v) {
  renderWho();
  renderStats(v);

  const fp = v.fingerprint;
  $('#fp-sub').textContent = `${fp.settledCount} settled`;
  const maxBias = Math.max(0.2, ...fp.insights.map((i) => Math.abs(i.bias)));
  $('#insights').innerHTML = fp.insights.length
    ? fp.insights
        .map((i) => {
          const figure = i.kind === 'market' ? `${Math.round((0.5 - i.bias) * 100)}% right` : pts(i.bias);
          return `<li class="insight"><h3>${esc(i.title)}</h3><span class="pts">${figure}</span><p>${esc(i.detail.replace(/\.$/, ''))}</p>
            <div class="bar"><i style="width:${Math.round((Math.abs(i.bias) / maxBias) * 100)}%"></i></div></li>`;
        })
        .join('')
    : `<li class="empty">Nothing learned yet. Settle three picks and the coach starts finding your blind spots</li>`;

  const open = v.picks.filter((p) => p.status === 'open');
  $('#open-count').textContent = open.length ? `${open.length} open` : '';
  $('#open-list').innerHTML = open.length
    ? open
        .map(
          (p) => `<li class="row" data-pick="${esc(p.id)}"><span class="t">${esc(p.subject)}</span>
          <span class="r">${gutToCoach(p)}${
            p.crypto
              ? `<span class="wait">settles ${esc(p.crypto.deadline.slice(11, 16))} UTC</span>`
              : p.market
                ? `<span class="wait">on resolution</span>`
                : `<button class="btn quiet small" data-settle="won" data-id="${p.id}">Won</button><button class="btn quiet small" data-settle="lost" data-id="${p.id}">Lost</button>`
          }</span>
          <span class="s">${esc(p.event || p.category)}</span>
          <span class="m">market ${pct(p.marketProb)} · ${p.oddsSource?.kind === 'market' ? 'Polymarket price' : 'typed odds'} · checkpoint ${nf.format(p.stamp?.checkpoint || 0)}</span></li>`,
        )
        .join('')
    : `<li class="empty">No open picks</li>`;

  const settled = v.picks.filter((p) => p.status !== 'open');
  $('#settled-count').textContent = String(settled.length);
  $('#settled-list').innerHTML = settled
    .map(
      (p) => `<li class="row"><span class="t">${esc(p.subject)}</span>
      <span class="r"><span class="result ${p.status}">${p.status}</span></span>
      <span class="s">${esc(p.event || p.category)}</span>
      <span class="m">said ${pct(p.confidence)} · market ${pct(p.marketProb)} · ${how(p)}${proof(p)}</span></li>`,
    )
    .join('');

  $('#mem-list').innerHTML = v.memories.length
    ? v.memories
        .map(
          (m) => `<li class="row"><span class="kind k-${esc(m.kind)}">${esc(m.kind)}</span><span class="s">${esc(cleanMemory(m.sentence))}</span>
          <span class="m">${m.status === 'stored' ? (m.blob_id ? `blob ${esc(short(m.blob_id))}` : 'stored') : m.status === 'failed' ? `failed · ${esc(m.error)}` : 'writing to Walrus'}</span></li>`,
        )
        .join('')
    : `<li class="empty">No memories yet</li>`;

  drawCalibration(v.calibration);

  if (!session) {
    clearTimeout(window.__pollT);
    if (open.some((p) => p.crypto) || v.memories.some((m) => m.status === 'pending')) window.__pollT = setTimeout(poll, 4000);
  }
}

// Main chart: what you said (x) against what happened (y). Each band gets a red-pen stroke from the
// perfect-calibration line to what really happened. Points grow with the number of picks.
function drawCalibration(buckets) {
  const W = 760, H = 340, L = 48, R = 24, T = 24, B = 40;
  const x = (p) => L + ((p - 0.5) / 0.5) * (W - L - R);
  const y = (p) => T + (1 - p) * (H - T - B);
  let svg = '';
  for (const t of [0, 0.25, 0.5, 0.75, 1]) svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${L - 12}" y="${y(t) + 4}" text-anchor="end">${t * 100}</text>`;
  for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 1]) svg += `<text class="axis" x="${x(t)}" y="${H - 16}" text-anchor="middle">${Math.round(t * 100)}</text>`;
  svg += `<text class="title" x="${W - R}" y="${H - 2}" text-anchor="end">Said, %</text><text class="title" x="${L - 12}" y="${T - 10}" text-anchor="start">Happened, %</text>`;
  svg += `<line class="diag" x1="${x(0.5)}" y1="${y(0.5)}" x2="${x(1)}" y2="${y(1)}"/>`;
  const rows = [];
  if (buckets.length) {
    const marks = buckets.map((b) => ({ cx: x(b.conf), cy: y(b.hit), dy: y(b.conf), over: b.hit < b.conf, b }));
    svg += marks.map((p) => `<line class="stroke ${p.over ? '' : 'under'} ${p.b.n < 3 ? 'thin' : ''}" x1="${p.cx}" y1="${p.dy}" x2="${p.cx}" y2="${p.cy}"/>`).join('');
    svg += marks
      .map((p) => `<circle class="pt ${p.over ? '' : 'under'}" cx="${p.cx}" cy="${p.cy}" r="${4 + Math.min(4, p.b.n / 2)}"><title>Said ${pct(p.b.conf)}, happened ${pct(p.b.hit)} · ${p.b.n} picks</title></circle><text class="n" x="${p.cx + 12}" y="${p.cy + 4}">${p.b.n}</text>`)
      .join('');
    const lead = marks.filter((p) => p.b.n >= 3 && p.over).sort((a, b) => (b.b.conf - b.b.hit) * Math.sqrt(b.b.n) - (a.b.conf - a.b.hit) * Math.sqrt(a.b.n))[0];
    if (lead && lead.b.conf - lead.b.hit > 0.1) {
      const ny = y(0.07);
      const nx = Math.min(lead.cx + 12, W - R - 210);
      svg += `<line class="lead-line" x1="${lead.cx}" y1="${lead.cy + 8}" x2="${lead.cx}" y2="${ny - 4}"/>`;
      svg += `<text class="note" x="${nx}" y="${ny}">You said <tspan class="note-num">${pct(lead.b.conf)}</tspan> and <tspan class="note-num">${pct(lead.b.hit)}</tspan> happened</text>`;
    }
    for (const b of buckets) {
      const lo = Math.round(b.from * 100);
      rows.push(`<tr class="${b.n < 3 ? 'thin' : ''}"><td>${lo}–${lo + 10}</td><td>${pct(b.conf)}</td><td class="${b.conf - b.hit > 0.1 && b.n >= 3 ? 'off' : ''}">${pct(b.hit)}</td><td>${b.n}</td></tr>`);
    }
    const all = buckets.reduce((a, b) => ({ n: a.n + b.n, c: a.c + b.conf * b.n, h: a.h + b.hit * b.n }), { n: 0, c: 0, h: 0 });
    $('#cal-lede').textContent = `Across ${all.n} settled picks you said ${pct(all.c / all.n)} on average and ${pct(all.h / all.n)} happened`;
  } else {
    svg += `<text class="axis" x="${W / 2}" y="${H / 2}" text-anchor="middle">Settle picks to draw your curve</text>`;
    $('#cal-lede').textContent = 'What you said against what happened, per 10 point band';
  }
  $('#calib-chart').innerHTML = svg;
  $('#bands').innerHTML = rows.join('') || '<tr><td colspan="4" class="empty">No settled picks yet</td></tr>';
}

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-settle]');
  if (!b) return;
  b.disabled = true;
  try {
    render(await record().settle(b.dataset.id, b.dataset.settle));
    refreshOpinion();
  } catch (e) {
    $('#open-count').textContent = e.message;
    b.disabled = false;
  }
});

$('#ask-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = ev.target.q.value.trim();
  if (!q) return;
  $('#ask-results').innerHTML = `<li class="empty">Recalling from Walrus</li>`;
  try {
    const hits = await record().recall(q);
    $('#ask-results').innerHTML = hits.length
      ? hits.map((h) => `<li class="row"><span class="s quote">${esc(cleanMemory(h.text))}</span><span class="m">${Math.round((1 - h.distance) * 100)}% match · blob ${esc(short(h.blob_id))}</span></li>`).join('')
      : `<li class="empty">Nothing in memory matches that yet</li>`;
  } catch (e) {
    $('#ask-results').innerHTML = `<li class="empty">${esc(e.message)}</li>`;
  }
});

$('#ask-suggest').addEventListener('click', (ev) => {
  const c = ev.target.closest('[data-q]');
  if (!c) return;
  $('#ask-form').q.value = c.dataset.q;
  $('#ask-form').requestSubmit();
});

$('#restore').addEventListener('click', async () => {
  const btn = $('#restore');
  btn.disabled = true;
  $('#restore-msg').textContent = 'Rebuilding your record from Walrus Memory';
  try {
    const r = await record().restore();
    render(r.view);
    $('#restore-msg').textContent = `Rebuilt from ${r.restored} memories on Walrus`;
  } catch (e) {
    $('#restore-msg').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$('#owner-save').addEventListener('click', () => {
  ownerToken = $('#owner-token').value.trim();
  store.set('priors-owner', ownerToken);
  $('#owner-msg').textContent = ownerToken ? 'Saved' : 'Cleared';
  poll();
});

async function poll() {
  try {
    render(await record().view());
  } catch (e) {
    $('#head-sub').textContent = e.message;
  }
}

// ======================================================================================
// Connect wallet
// ======================================================================================
// 1. Connect a Sui wallet. 2. Find the wallet's Walrus Memory account, or create it (one wallet
// signature). 3. Make a delegate key in this browser and add it to the account (one signature).
// 4. Check the key with Walrus. The wallet never shares its own key with Priors.
const dlg = $('#connect');
let walletLib;
let walrusConfig;
const chainOf = (cfg) => `sui:${cfg.network}`;

function stepState(id, state, note = '') {
  const li = dlg.querySelector(`[data-step="${id}"]`);
  if (!li) return;
  li.dataset.state = state;
  li.querySelector('.note').textContent = note;
}

function showPane(name) {
  for (const p of dlg.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
}

function dialogError(message) {
  $('#connect-error').textContent = message;
  $('#connect-error').hidden = !message;
}

async function openConnect() {
  dialogError('');
  showPane('choose');
  dlg.showModal();
  $('#wallet-list').innerHTML = '<li class="empty">Looking for Sui wallets</li>';
  try {
    walletLib ??= await import('./vendor/wallet.js');
    walrusConfig ??= await request('/api/walrus/config');
    const draw = (list) => {
      $('#wallet-list').innerHTML = list.length
        ? list.map((w, i) => `<li><button type="button" class="wallet" data-wallet="${i}">${w.icon ? `<img src="${esc(w.icon)}" alt="" width="24" height="24" />` : ''}<span>${esc(w.name)}</span></button></li>`).join('')
        : '<li class="empty">No Sui wallet found in this browser. Install <a href="https://slush.app" target="_blank" rel="noopener">Slush</a>, then reload this page, or use an existing Walrus key below</li>';
      dlg.wallets = list;
    };
    draw(walletLib.listWallets(chainOf(walrusConfig), draw));
  } catch (e) {
    $('#wallet-list').innerHTML = `<li class="empty">${esc(e.message)}</li>`;
  }
}

/** A key that was just added onchain can take a few seconds to reach Walrus, so fresh keys get retries. */
async function checkSession(candidate, { fresh = false } = {}) {
  const attempts = fresh ? 10 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await request('/api/u/session', {}, userHeaders(candidate));
    } catch (e) {
      if (!fresh || ![401, 425].includes(e.status) || attempt >= attempts) throw e;
      await wait(2000);
    }
  }
}

async function startSession(s) {
  session = s;
  store.set('priors-session', s);
  store.set(`priors-key-${s.accountId}`, { key: s.key, publicKey: s.publicKey || null });
  dlg.close();
  $('#ask-results').innerHTML = '';
  await poll();
  refreshOpinion();
}

async function connectWallet(w) {
  showPane('progress');
  dialogError('');
  for (const id of ['connect', 'account', 'key', 'check']) stepState(id, 'waiting');
  try {
    stepState('connect', 'active', `Approve in ${w.name}`);
    const signer = await walletLib.connect(w, chainOf(walrusConfig));
    stepState('connect', 'done', shortAddr(signer.address));

    const cfg = walrusConfig;
    const suiClient = { waitForTransaction: ({ digest }) => request(`/api/sui/tx/${digest}`) };
    let { accountId, delegateKeys = [] } = await request(`/api/walrus/account/${signer.address}`);
    if (accountId) {
      stepState('account', 'done', `Found ${shortAddr(accountId)}`);
    } else {
      stepState('account', 'active', 'Approve in your wallet. Creating it needs a little SUI for gas');
      const created = await walletLib.createAccount({ packageId: cfg.packageId, registryId: cfg.registryId, walletSigner: signer, suiClient });
      accountId = created.accountId || (await request(`/api/walrus/account/${signer.address}`)).accountId;
      if (!accountId) throw new Error('The account was created but could not be found yet. Try again in a moment.');
      stepState('account', 'done', `Created ${shortAddr(accountId)}`);
    }

    // Reuse the key this browser already holds for this account, if it is still authorised onchain.
    const kept = store.get(`priors-key-${accountId}`);
    if (kept?.key && (!kept.publicKey || delegateKeys.includes(kept.publicKey))) {
      const candidate = { address: signer.address, accountId, key: kept.key, publicKey: kept.publicKey, via: 'wallet' };
      stepState('key', 'done', 'This browser already has a Priors key');
      stepState('check', 'active', 'Checking with Walrus');
      try {
        const ok = await checkSession(candidate);
        stepState('check', 'done');
        return startSession({ ...candidate, publicKey: ok.publicKey });
      } catch {
        store.del(`priors-key-${accountId}`);
        stepState('check', 'waiting');
      }
    }

    stepState('key', 'active', 'Approve in your wallet. The key can read and write memories only');
    const dk = await walletLib.generateDelegateKey();
    await walletLib.addDelegateKey({ packageId: cfg.packageId, registryId: cfg.registryId, accountId, publicKey: dk.publicKey, label: cfg.delegateLabel, walletSigner: signer, suiClient });
    stepState('key', 'done');

    const candidate = { address: signer.address, accountId, key: dk.privateKey, via: 'wallet' };
    stepState('check', 'active', 'Checking with Walrus');
    const ok = await checkSession(candidate, { fresh: true });
    stepState('check', 'done');
    await startSession({ ...candidate, publicKey: ok.publicKey });
  } catch (e) {
    const active = dlg.querySelector('[data-state="active"]');
    if (active) stepState(active.dataset.step, 'error');
    dialogError(/reject|denied|cancel/i.test(e.message) ? 'You declined in your wallet. Nothing was changed.' : e.message);
  }
}

async function useExistingKey(ev) {
  ev.preventDefault();
  dialogError('');
  const f = ev.target;
  const candidate = { accountId: f.account.value.trim().toLowerCase(), key: f.key.value.trim().toLowerCase().replace(/^0x/, ''), via: 'key' };
  if (!/^0x[0-9a-f]{64}$/.test(candidate.accountId) || !/^[0-9a-f]{64}$/.test(candidate.key)) {
    return dialogError('The account ID starts with 0x and has 64 characters after it. The delegate key is 64 characters.');
  }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const ok = await checkSession(candidate);
    f.reset();
    await startSession({ ...candidate, address: ok.owner, publicKey: ok.publicKey });
  } catch (e) {
    dialogError(e.message);
  } finally {
    btn.disabled = false;
  }
}

// Disconnecting removes every copy of the delegate key from this browser. Reconnecting the same
// wallet approves a fresh key, so nothing usable is left behind on a shared computer.
function disconnect() {
  if (session) store.del(`priors-key-${session.accountId}`);
  session = null;
  store.del('priors-session');
  $('#account-menu').hidden = true;
  $('#ask-results').innerHTML = '';
  poll();
  refreshOpinion();
}

$('#wallet-btn').addEventListener('click', openConnect);
$('#banner-connect').addEventListener('click', openConnect);
$('#wallet-list').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-wallet]');
  if (b) connectWallet(dlg.wallets[Number(b.dataset.wallet)]);
});
$('#key-form').addEventListener('submit', useExistingKey);
$('#show-key-form').addEventListener('click', () => showPane('key'));
for (const b of dlg.querySelectorAll('[data-back]')) b.addEventListener('click', () => showPane('choose'));
for (const b of dlg.querySelectorAll('[data-close]')) b.addEventListener('click', () => dlg.close());
$('#account-btn').addEventListener('click', () => {
  const m = $('#account-menu');
  m.hidden = !m.hidden;
  if (!m.hidden) $('#account-full').textContent = session.accountId;
});
$('#disconnect').addEventListener('click', disconnect);
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#account-menu, #account-btn')) $('#account-menu').hidden = true;
});

setKind();
poll().then(() => {
  refreshOpinion();
  // Run the first example question once on load, so every visitor sees live Walrus recall.
  const first = $('#ask-suggest [data-q]');
  if (first && (session ? wallet.load().picks.length : true)) {
    $('#ask-form').q.value = first.dataset.q;
    $('#ask-form').requestSubmit();
  }
});
