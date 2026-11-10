const $ = (s) => document.querySelector(s);
const pct = (x) => `${Math.round(x * 100)}%`;
const short = (s) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SUISCAN = 'https://suiscan.xyz/mainnet/checkpoint/';

let known = new Set();

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

function formData() {
  return Object.fromEntries(new FormData($('#pick-form')).entries());
}

const form = $('#pick-form');

// ---------- Sports: live bookmaker feed (falls back to typed odds) ----------
let events = [];
async function loadEvents() {
  const cat = form.elements.category.value;
  try {
    const r = await api(`/api/events/${encodeURIComponent(cat)}`);
    events = r.events || [];
    if (r.enabled && events.length) {
      form.dataset.feed = '1';
      form.elements.eventId.innerHTML = `<option value="">Choose an upcoming event…</option>` +
        events.map((e) => `<option value="${esc(e.id)}">${esc(e.event)} · ${esc(e.commence.slice(5, 16).replace('T', ' '))} UTC</option>`).join('');
    } else {
      delete form.dataset.feed;
      $('#odds-src').textContent = r.enabled ? 'no live events in this category, typed by you' : 'typed by you (no odds feed key)';
    }
  } catch (e) {
    delete form.dataset.feed;
    $('#odds-src').textContent = `typed by you (feed error: ${e.message.slice(0, 60)})`;
  }
}
function applyEventOdds() {
  const ev = events.find((e) => e.id === form.elements.eventId.value);
  $('#outcomes').innerHTML = ev ? Object.keys(ev.outcomes).map((o) => `<option>${esc(o)}</option>`).join('') : '';
  const o = ev?.outcomes[form.elements.subject.value];
  form.elements.odds.readOnly = Boolean(o);
  if (o) {
    form.elements.odds.value = o.price;
    $('#odds-src').textContent = `best live price: ${o.bookmaker}`;
  } else if (form.dataset.feed) {
    $('#odds-src').textContent = ev ? 'pick one of the listed outcomes' : 'choose an event';
  }
}

// ---------- Crypto: live onchain price ----------
async function loadPrice() {
  const asset = form.elements.asset.value;
  $('#live-price').textContent = `Reading ${asset} price from Sui…`;
  try {
    const p = await api(`/api/price/${asset}`);
    $('#live-price').textContent = `${asset} is $${p.usd.toFixed(4)} right now (Cetus pool on Sui, checkpoint #${p.checkpoint}). It settles from this same source at the deadline.`;
    if (!form.elements.target.value) form.elements.target.value = (p.usd * 1.002).toPrecision(4);
  } catch (e) {
    $('#live-price').textContent = `Could not read onchain price: ${e.message}`;
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

// ---------- Second opinion (live, before you commit) ----------
let opinionTimer;
function refreshOpinion() {
  clearTimeout(opinionTimer);
  const d = formData();
  $('#conf-val').textContent = `${d.confidence}%`;
  $('#o-gut').textContent = `${d.confidence}%`;
  opinionTimer = setTimeout(async () => {
    const ready = d.kind === 'crypto' ? Number(d.target) > 0 : d.subject;
    if (!ready || !(Number(d.odds) > 1)) return;
    try {
      const o = await api('/api/opinion', d);
      $('#o-adj').textContent = pct(o.adjusted);
      $('#o-mkt').textContent = pct(o.market);
      $('#o-reasons').innerHTML = o.reasons.map((r) => `<li>${esc(r)}</li>`).join('');
      $('#o-verdict').textContent = o.verdict;
      const e = o.echo;
      $('#o-echo').innerHTML = o.echoError
        ? esc(o.echoError)
        : e
          ? `<b>Walrus recall:</b> you argued like this ${e.n} time${e.n === 1 ? '' : 's'} before and won ${e.won}.` +
            e.examples.map((x) => `<q>“${esc(x.reason)}” on ${esc(x.subject)}: <span class="tag ${x.status}">${x.status}</span> ${Math.round(x.similarity * 100)}% similar</q>`).join('')
          : d.reason?.length >= 8 ? 'Walrus recall: no past reasoning like this yet.' : '';
    } catch (e) {
      $('#o-verdict').textContent = e.message;
    }
  }, 500);
}
form.addEventListener('input', (ev) => {
  if (ev.target.name === 'kind') setKind();
  if (ev.target.name === 'category') loadEvents().then(applyEventOdds);
  if (ev.target.name === 'eventId' || ev.target.name === 'subject') applyEventOdds();
  if (ev.target.name === 'asset') { form.elements.target.value = ''; loadPrice(); }
  refreshOpinion();
});

$('#pick-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#submit');
  btn.disabled = true;
  btn.textContent = 'Sealing on Sui…';
  try {
    const r = await api('/api/picks', formData());
    const s = r.pick.stamp;
    $('#receipt').innerHTML = `Sealed at Sui checkpoint <a href="${SUISCAN}${s.checkpoint}" target="_blank" rel="noopener">#${s.checkpoint}</a> · ${esc(s.timestamp)}${s.digest ? ` · digest ${esc(short(s.digest))}` : ''} · commitment ${esc(short(r.pick.commitment))}. Writing to Walrus Memory…`;
    render(r);
    ['event', 'subject', 'reason', 'target'].forEach((n) => (form.elements[n].value = ''));
    if (!form.elements.odds.readOnly) form.elements.odds.value = '';
    if (form.dataset.kind === 'crypto') loadPrice();
  } catch (e) {
    $('#receipt').textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Seal on Sui & remember';
  }
});

// ---------- Render ----------
function render(v) {
  $('#stored').textContent = v.stored;
  $('#pill-memory').classList.toggle('ok', v.stored > 0);

  const fp = v.fingerprint;
  $('#fp-sub').textContent = `learned from ${fp.settledCount} settled pick${fp.settledCount === 1 ? '' : 's'}`;
  const maxBias = Math.max(0.2, ...fp.insights.map((i) => Math.abs(i.bias)));
  $('#insights').innerHTML = fp.insights.length
    ? fp.insights
        .map((i) => `<div class="insight ${known.size && !known.has(i.title) ? 'new' : ''}">
          <span class="n">${i.n} picks</span><h3>${esc(i.title)}</h3><p>${esc(i.detail)}</p>
          <div class="bar"><i style="width:${Math.round((Math.abs(i.bias) / maxBias) * 100)}%"></i></div></div>`)
        .join('')
    : `<p class="empty">Nothing learned yet. Settle at least 3 picks and the coach starts finding your blind spots.</p>`;
  known = new Set(fp.insights.map((i) => i.title));

  const priceTag = (p) => (p.oddsSource?.kind === 'bookmaker' ? `${esc(p.oddsSource.bookmaker)} odds` : 'typed odds');
  const open = v.picks.filter((p) => p.status === 'open');
  $('#open-list').innerHTML = open.length
    ? open.map((p) => `<div class="item"><div><b>${esc(p.subject)}</b> ${p.event ? `· ${esc(p.event)}` : ''} <span class="tag">${esc(p.category)}</span>
        <div class="meta">gut ${pct(p.confidence)} · coach ${pct(p.coach.adjusted)} · market ${pct(p.marketProb)} (${priceTag(p)}) · sealed #${esc(p.stamp?.checkpoint)}</div></div>
        <div class="acts">${p.crypto
          ? `<span class="tag verified">settles onchain ${esc(p.crypto.deadline.slice(11, 19))} UTC</span>`
          : `<button class="small win" data-settle="won" data-id="${p.id}">Won</button><button class="small loss" data-settle="lost" data-id="${p.id}">Lost</button>`}</div></div>`).join('')
    : `<p class="empty">No open picks.</p>`;

  $('#settled-list').innerHTML = v.picks
    .filter((p) => p.status !== 'open')
    .map((p) => `<div class="item"><div><span class="tag ${p.status}">${p.status}</span><span class="tag ${p.verified ? 'verified' : 'unverified'}">${p.verified ? 'verified onchain' : 'self-reported'}</span><b>${esc(p.subject)}</b> ${p.event ? `· ${esc(p.event)}` : ''}
        <div class="meta">gut ${pct(p.confidence)} · market ${pct(p.marketProb)} · sealed #${esc(p.stamp?.checkpoint)}${p.verified ? ` · settled at $${p.evidence.usd.toFixed(4)}, checkpoint #${esc(p.evidence.checkpoint)}` : ''}</div></div></div>`)
    .join('');
  if (open.some((p) => p.crypto)) { clearTimeout(window.__pollT); window.__pollT = setTimeout(poll, 8000); }

  $('#mem-list').innerHTML = v.memories.length
    ? v.memories.map((m) => `<div class="item"><div><span class="tag ${m.kind}">${esc(m.kind)}</span>${esc(m.sentence)}
        <div class="meta">${m.status === 'stored' ? `blob ${esc(short(m.blob_id))}` : m.status === 'failed' ? `failed: ${esc(m.error)}` : 'writing to Walrus…'}</div></div></div>`).join('')
    : `<p class="empty">No memories yet.</p>`;

  drawCalibration(v.calibration);
  if (v.memories.some((m) => m.status === 'pending')) setTimeout(poll, 2500);
}

function drawCalibration(buckets) {
  const W = 320, H = 220, L = 34, B = 26, T = 10, R = 10;
  const x = (p) => L + ((p - 0.5) / 0.5) * (W - L - R);
  const y = (p) => H - B - p * (H - B - T);
  let svg = '';
  for (const t of [0, 0.25, 0.5, 0.75, 1]) svg += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#2e2b26"/><text x="4" y="${y(t) + 3}">${t * 100}%</text>`;
  for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 1]) svg += `<text x="${x(t) - 10}" y="${H - 8}">${Math.round(t * 100)}%</text>`;
  svg += `<line x1="${x(0.5)}" y1="${y(0.5)}" x2="${x(1)}" y2="${y(1)}" stroke="#9b9384" stroke-dasharray="4 4"/>`;
  if (buckets.length) {
    const pts = buckets.map((b) => [x(b.conf), y(b.hit), b]);
    svg += `<polyline fill="none" stroke="#ff7a1a" stroke-width="2.5" points="${pts.map((p) => p.slice(0, 2).join(',')).join(' ')}"/>`;
    svg += pts.map(([cx, cy, b]) => `<circle cx="${cx}" cy="${cy}" r="${4 + Math.min(6, b.n)}" fill="#ff7a1a" fill-opacity="0.85"><title>${pct(b.conf)} said, ${pct(b.hit)} happened (${b.n} picks)</title></circle>`).join('');
  } else {
    svg += `<text x="${W / 2 - 60}" y="${H / 2}">settle picks to draw your curve</text>`;
  }
  $('#calib-chart').innerHTML = svg;
}

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-settle]');
  if (!b) return;
  b.disabled = true;
  try {
    render(await api(`/api/picks/${b.dataset.id}/settle`, { result: b.dataset.settle }));
    refreshOpinion();
  } catch (e) {
    alert(e.message);
  }
});

$('#ask-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = ev.target.q.value.trim();
  if (!q) return;
  $('#ask-results').innerHTML = `<p class="empty">Recalling from Walrus…</p>`;
  try {
    const hits = await api('/api/recall', { query: q });
    $('#ask-results').innerHTML = hits.length
      ? hits.map((h) => `<div class="item"><div>${esc(h.text)}<div class="meta">match ${Math.round((1 - h.distance) * 100)}% · blob ${esc(short(h.blob_id))}</div></div></div>`).join('')
      : `<p class="empty">Nothing in memory matches that yet.</p>`;
  } catch (e) {
    $('#ask-results').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
});

$('#restore').addEventListener('click', async () => {
  $('#restore').disabled = true;
  $('#restore-msg').textContent = 'Wiping local data and rebuilding from Walrus Memory…';
  try {
    const r = await api('/api/restore', {});
    $('#restore-msg').textContent = `Rebuilt from ${r.restored} memories on Walrus.`;
    render(r);
  } catch (e) {
    $('#restore-msg').textContent = e.message;
  } finally {
    $('#restore').disabled = false;
  }
});

async function poll() {
  render(await api('/api/state'));
}

async function checkMemoryCount() {
  try {
    const r = await api('/api/memory-count');
    $('#stored').textContent = r.count;
    $('#pill-memory').classList.add('ok');
  } catch {
    $('#pill-memory').classList.add('bad');
  }
}

setKind();
poll().then(() => { refreshOpinion(); checkMemoryCount(); });
