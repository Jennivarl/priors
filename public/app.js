const $ = (s) => document.querySelector(s);
const pct = (x) => `${Math.round(x * 100)}%`;
const pts = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x * 100))} pts`;
const short = (s) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('en-GB');
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const SUISCAN = 'https://suiscan.xyz/mainnet/checkpoint/';
const form = $('#pick-form');

let ownerToken = '';
try { ownerToken = localStorage.getItem('priors-owner') || ''; } catch { /* storage blocked */ }

async function api(path, body) {
  const headers = { 'Content-Type': 'application/json', ...(ownerToken ? { 'x-owner-token': ownerToken } : {}) };
  const res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}
const formData = () => Object.fromEntries(new FormData(form).entries());

// ---------- Sports and politics: live Polymarket feed, typed odds as the fallback ----------
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
  } catch (e) {
    delete form.dataset.feed;
    $('#odds-src').textContent = 'market feed unavailable, typed by you';
  }
}

function applyEventOdds() {
  if (!form.dataset.feed) { delete form.dataset.market; form.elements.odds.readOnly = false; return; }
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

// ---------- Crypto: live onchain price ----------
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

// ---------- The correction: second opinion before you commit ----------
function placeRule(gut, coach, market) {
  const rule = $('#o-rule');
  rule.classList.add('on');
  $('#r-gut').style.left = `${gut * 100}%`;
  $('#r-coach').style.left = `${coach * 100}%`;
  $('#r-mkt').style.left = `${market * 100}%`;
  const lo = Math.min(gut, coach);
  $('#r-span').style.left = `${lo * 100}%`;
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
      const o = await api('/api/opinion', d);
      const corrected = Math.abs(o.adjusted - o.gut) >= 0.01;
      $('#opinion').classList.toggle('has', corrected);
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
          : d.reason?.length >= 8 ? '<span class="head-line">Walrus recall: no past reasoning like this yet</span>' : '';
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
  if (t.name === 'asset') { form.elements.target.value = ''; loadPrice(); }
  refreshOpinion();
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#submit');
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Sealing on Sui';
  try {
    const r = await api('/api/picks', formData());
    const s = r.pick.stamp;
    $('#receipt').innerHTML = `Sealed at checkpoint <a href="${SUISCAN}${s.checkpoint}" target="_blank" rel="noopener">${nf.format(s.checkpoint)}</a> · ${esc(s.timestamp.slice(11, 19))} UTC · commitment ${esc(short(r.pick.commitment))} · writing to Walrus`;
    render(r);
    ['event', 'subject', 'reason', 'target'].forEach((n) => (form.elements[n].value = ''));
    if (!form.elements.odds.readOnly) form.elements.odds.value = '';
    if (form.dataset.kind === 'crypto') loadPrice();
  } catch (e) {
    $('#receipt').textContent = e.message;
  } finally {
    btn.disabled = false;
    label.textContent = 'Seal on Sui and remember';
  }
});

// ---------- Render ----------
const how = (p) => (!p.verified ? 'self-reported' : p.crypto ? 'verified onchain' : 'market resolved');
const proof = (p) => (!p.verified ? '' : p.crypto ? ` · settled at $${p.evidence.usd.toFixed(4)}, checkpoint ${nf.format(p.evidence.checkpoint)}` : ` · Polymarket ${esc(p.evidence.marketId)}`);
const cleanMemory = (t) => { const x = String(t).replace(/^(Gut Check|Priors)\s+(coach\s+)?/i, ''); return x.charAt(0).toUpperCase() + x.slice(1); };
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
  $('#st-ver-of').textContent = done.length ? `of ${done.length} settled` : 'settled by chain or market';
  $('#st-open').textContent = String(open.length);
  const first = v.picks.map((p) => p.createdAt).sort()[0];
  $('#head-sub').textContent = first ? `${v.picks.length} picks sealed on Sui since ${day(first)}` : 'The coach that remembers how you are wrong';
}

function render(v) {
  $('#demo-banner').hidden = !v.readOnly || Boolean(ownerToken);
  $('#owner-box').hidden = !v.readOnly;
  renderStats(v);

  const fp = v.fingerprint;
  $('#fp-sub').textContent = `${fp.settledCount} settled`;
  const maxBias = Math.max(0.2, ...fp.insights.map((i) => Math.abs(i.bias)));
  $('#insights').innerHTML = fp.insights.length
    ? fp.insights
        .map((i) => {
          const figure = i.kind === 'market' ? `${Math.round((0.5 - i.bias) * 100)}% right` : pts(i.bias);
          return `<li class="insight"><h3>${esc(i.title)}</h3><span class="pts">${figure}</span><p>${esc(i.detail.replace(/.$/, ''))}</p>
            <div class="bar"><i style="width:${Math.round((Math.abs(i.bias) / maxBias) * 100)}%"></i></div></li>`;
        })
        .join('')
    : `<li class="empty">Nothing learned yet. Settle three picks and the coach starts finding your blind spots</li>`;

  const open = v.picks.filter((p) => p.status === 'open');
  $('#open-count').textContent = open.length ? `${open.length} open` : '';
  $('#open-list').innerHTML = open.length
    ? open
        .map((p) => `<li class="row"><span class="t">${esc(p.subject)}</span>
          <span class="r">${gutToCoach(p)}${p.crypto
            ? `<span class="wait">settles ${esc(p.crypto.deadline.slice(11, 16))} UTC</span>`
            : p.market
              ? `<span class="wait">on resolution</span>`
              : `<button class="btn quiet small" data-settle="won" data-id="${p.id}">Won</button><button class="btn quiet small" data-settle="lost" data-id="${p.id}">Lost</button>`}</span>
          <span class="s">${esc(p.event || p.category)}</span>
          <span class="m">market ${pct(p.marketProb)} · ${p.oddsSource?.kind === 'market' ? 'Polymarket price' : 'typed odds'} · checkpoint ${nf.format(p.stamp?.checkpoint || 0)}</span></li>`)
        .join('')
    : `<li class="empty">No open picks</li>`;

  const settled = v.picks.filter((p) => p.status !== 'open');
  $('#settled-count').textContent = String(settled.length);
  $('#settled-list').innerHTML = settled
    .map((p) => `<li class="row"><span class="t">${esc(p.subject)}</span>
      <span class="r"><span class="result ${p.status}">${p.status}</span></span>
      <span class="s">${esc(p.event || p.category)}</span>
      <span class="m">said ${pct(p.confidence)} · market ${pct(p.marketProb)} · ${how(p)}${proof(p)}</span></li>`)
    .join('');
  if (open.some((p) => p.crypto)) { clearTimeout(window.__pollT); window.__pollT = setTimeout(poll, 8000); }

  $('#mem-list').innerHTML = v.memories.length
    ? v.memories
        .map((m) => `<li class="row"><span class="kind k-${esc(m.kind)}">${esc(m.kind)}</span><span class="s">${esc(cleanMemory(m.sentence))}</span>
          <span class="m">${m.status === 'stored' ? (m.blob_id ? `blob ${esc(short(m.blob_id))}` : 'stored') : m.status === 'failed' ? `failed · ${esc(m.error)}` : 'writing to Walrus'}</span></li>`)
        .join('')
    : `<li class="empty">No memories yet</li>`;

  drawCalibration(v.calibration);
  if (v.memories.some((m) => m.status === 'pending')) setTimeout(poll, 2500);
}

// Main chart: what you said (x) against what happened (y). Each band gets a red-pen stroke from the
// perfect-calibration line down (or up) to what really happened. Points grow with the number of picks.
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
    const pts = buckets.map((b) => ({ cx: x(b.conf), cy: y(b.hit), dy: y(b.conf), over: b.hit < b.conf, b }));
    svg += pts.map((p) => `<line class="stroke ${p.over ? '' : 'under'} ${p.b.n < 3 ? 'thin' : ''}" x1="${p.cx}" y1="${p.dy}" x2="${p.cx}" y2="${p.cy}"/>`).join('');
    svg += pts
      .map((p) => `<circle class="pt ${p.over ? '' : 'under'}" cx="${p.cx}" cy="${p.cy}" r="${4 + Math.min(4, p.b.n / 2)}"><title>Said ${pct(p.b.conf)}, happened ${pct(p.b.hit)} · ${p.b.n} picks</title></circle><text class="n" x="${p.cx + 12}" y="${p.cy + 4}">${p.b.n}</text>`)
      .join('');
    const heavy = pts.filter((p) => p.b.n >= 3 && p.over);
    const lead = heavy.sort((a, b) => (b.b.conf - b.b.hit) * Math.sqrt(b.b.n) - (a.b.conf - a.b.hit) * Math.sqrt(a.b.n))[0];
    if (lead && lead.b.conf - lead.b.hit > 0.1) {
      // Note sits low in the plot, right of the band it explains, with a short leader from the point.
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
  }
  $('#calib-chart').innerHTML = svg;
  $('#bands').innerHTML = rows.join('') || '<tr><td colspan="4" class="empty">No settled picks yet</td></tr>';
}

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-settle]');
  if (!b) return;
  b.disabled = true;
  try {
    render(await api(`/api/picks/${b.dataset.id}/settle`, { result: b.dataset.settle }));
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
    const hits = await api('/api/recall', { query: q });
    $('#ask-results').innerHTML = hits.length
      ? hits.map((h) => `<li class="row"><span class="s quote">${esc(h.text)}</span><span class="m">${Math.round((1 - h.distance) * 100)}% match · blob ${esc(short(h.blob_id))}</span></li>`).join('')
      : `<li class="empty">Nothing in memory matches that yet</li>`;
  } catch (e) {
    $('#ask-results').innerHTML = `<li class="empty">${esc(e.message)}</li>`;
  }
});

$('#ask-suggest').addEventListener('click', (ev) => {
  const c = ev.target.closest('[data-q]');
  if (!c) return;
  const f = $('#ask-form');
  f.q.value = c.dataset.q;
  f.requestSubmit();
});

$('#restore').addEventListener('click', async () => {
  const btn = $('#restore');
  btn.disabled = true;
  $('#restore-msg').textContent = 'Wiping local data and rebuilding from Walrus Memory';
  try {
    const r = await api('/api/restore', {});
    $('#restore-msg').textContent = `Rebuilt from ${r.restored} memories on Walrus`;
    render(r);
  } catch (e) {
    $('#restore-msg').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$('#owner-save').addEventListener('click', () => {
  ownerToken = $('#owner-token').value.trim();
  try { localStorage.setItem('priors-owner', ownerToken); } catch { /* storage blocked */ }
  $('#owner-msg').textContent = ownerToken ? 'Saved' : 'Cleared';
  poll();
});

async function poll() {
  render(await api('/api/state'));
}

async function header() {
  try {
    const r = await api('/api/memory-count');
    $('#stored').textContent = nf.format(r.count);
    $('#mem-dot').classList.add('ok');
  } catch {
    $('#mem-dot').classList.add('bad');
  }
  try {
    const p = await api('/api/price/SUI');
    $('#sui-cp').textContent = `checkpoint ${nf.format(p.checkpoint)}`;
    $('#sui-dot').classList.add('ok');
  } catch {
    $('#sui-dot').classList.add('bad');
  }
}

setKind();
poll().then(() => {
  refreshOpinion();
  header();
  // Show live Walrus recall to every visitor: run the first example question once on load.
  const first = $('#ask-suggest [data-q]');
  if (first) { $('#ask-form').q.value = first.dataset.q; $('#ask-form').requestSubmit(); }
});
