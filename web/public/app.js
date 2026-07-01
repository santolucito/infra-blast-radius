// Front-end for blast-compare. Numbers come from POST /api/compare (the server
// runs the real CLI). The only client-side computation is the tradeoff
// "threat model" slider, which re-applies the network-category weight to the
// already-returned per-category breakdown — the same scoring formula, instant.

const SVGNS = 'http://www.w3.org/2000/svg';
const RISK = { low: '#58a6ff', med: '#d29922', high: '#f85149' };
const NETWORK_CATS = ['network_exposure', 'public_exposure', 'encryption', 'misconfiguration'];

const state = { examples: [], cur: null, fix: 'fix-A', cmp: null, mult: 1 };

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  kids.forEach((c) => n.appendChild(c));
  return n;
};
const txt = (s) => document.createTextNode(s);

function status(msg, kind) {
  const s = $('status');
  s.className = 'status show' + (kind ? ' ' + kind : '');
  s.innerHTML = kind === 'run' ? `<span class="spin"></span>${msg}` : msg;
  if (kind === 'ok') setTimeout(() => (s.className = 'status'), 1400);
}

// ---- data ----
async function load() {
  state.examples = await (await fetch('/api/examples')).json();
  renderTabs();
  const [hid, hfix] = decodeURIComponent(location.hash.slice(1)).split('/');
  const start = state.examples.find((e) => e.id === hid) ? hid : state.examples[0].id;
  select(start, hfix);
}

async function compare() {
  const ex = state.cur;
  status(`running blast-compare on “${ex.title}” …`, 'run');
  try {
    const body = { example: ex.id };
    const r = await fetch('/api/compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.error) return status('error: ' + data.error, 'err');
    state.cmp = data.comparison;
    status(`done in ${(data.tookMs / 1000).toFixed(1)}s`, 'ok');
    renderPanel();
  } catch (e) {
    status('request failed: ' + e.message, 'err');
  }
}

// ---- top-level render ----
function renderTabs() {
  const t = $('tabs');
  t.innerHTML = '';
  for (const e of state.examples) {
    const d = document.createElement('div');
    d.className = 'tab' + (state.cur && state.cur.id === e.id ? ' active' : '');
    d.innerHTML = `${e.title}<small>${e.subtitle}</small>`;
    d.onclick = () => select(e.id);
    t.appendChild(d);
  }
}

function select(id, wantFix) {
  state.cur = state.examples.find((e) => e.id === id);
  state.mult = 1;
  if (location.hash.slice(1) !== id) location.hash = id;
  const fixes = Object.keys(state.cur.graph);
  state.fix = wantFix && fixes.includes(wantFix) ? wantFix : fixes.includes('fix-A') ? 'fix-A' : fixes[0];
  renderTabs();
  $('story').textContent = state.cur.story;
  renderFixbar();
  renderGraph();
  compare();
}

function renderFixbar() {
  const bar = $('fixbar');
  bar.innerHTML = '';
  for (const f of Object.keys(state.cur.graph)) {
    const b = document.createElement('div');
    b.className = 'fixbtn' + (state.fix === f ? ' active' : '');
    const label = f === 'baseline' ? 'the "before" state' : (state.cur.fixes[f] || '');
    b.innerHTML = `<b>${f}</b>${label}`;
    b.onclick = () => { state.fix = f; renderFixbar(); renderGraph(); renderPanel(); };
    bar.appendChild(b);
  }
}

// ---- graph ----
const GX = (x) => 40 + x * (1000 - 80);
const GY = (y) => 40 + y * (620 - 80);

function renderGraph() {
  const svg = $('graph');
  svg.innerHTML = '';
  const g = state.cur.graph[state.fix];
  if (!g) return;

  const defs = el('defs');
  for (const k in RISK) {
    defs.appendChild(el('marker', {
      id: 'arw-' + k, viewBox: '0 0 10 10', refX: 8, refY: 5,
      markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    }, [el('path', { d: 'M0 0 L10 5 L0 10 z', fill: RISK[k] })]));
  }
  svg.appendChild(defs);

  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  const eLayer = el('g');
  for (const e of g.edges) {
    const s = byId[e.from], t = byId[e.to];
    if (!s || !t) continue;
    const sx = GX(s.pos[0]), sy = GY(s.pos[1]), tx = GX(t.pos[0]), ty = GY(t.pos[1]);
    const dx = tx - sx, dy = ty - sy, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const x1 = sx + ux * 42, y1 = sy + uy * 34, x2 = tx - ux * 46, y2 = ty - uy * 40;
    eLayer.appendChild(el('line', {
      x1, y1, x2, y2, stroke: RISK[e.risk], 'stroke-width': e.risk === 'high' ? 2.4 : 1.6,
      'stroke-dasharray': e.dashed ? '5 5' : '0', opacity: e.dashed ? 0.5 : 0.9,
      'marker-end': 'url(#arw-' + e.risk + ')',
    }));
    if (e.label) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      eLayer.appendChild(el('rect', { x: mx - e.label.length * 3.4 - 4, y: my - 9, width: e.label.length * 6.8 + 8, height: 16, rx: 4, fill: '#0d1117', opacity: 0.85 }));
      const tn = el('text', { x: mx, y: my + 3, 'text-anchor': 'middle', class: 'elabel' });
      tn.appendChild(txt(e.label));
      eLayer.appendChild(tn);
    }
  }
  svg.appendChild(eLayer);

  for (const n of g.nodes) {
    const x = GX(n.pos[0]), y = GY(n.pos[1]), col = RISK[n.risk];
    const grp = el('g', { class: 'node' });
    const round = n.type === 'principal' || n.type === 'network';
    if (round) {
      grp.appendChild(el('circle', { cx: x, cy: y, r: 30, fill: '#161b22', stroke: col, 'stroke-width': 2 }));
    } else {
      const w = 158, h = 54;
      grp.appendChild(el('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 10, fill: '#161b22', stroke: col, 'stroke-width': 2 }));
      grp.appendChild(el('rect', { x: x - w / 2, y: y - h / 2, width: 5, height: h, rx: 2, fill: col }));
    }
    const lab = el('text', { x, y: n.note && !round ? y - 2 : y + 5, 'text-anchor': 'middle', class: 'nlabel' });
    lab.appendChild(txt(n.label));
    grp.appendChild(lab);
    if (n.note) {
      const nt = el('text', { x, y: round ? y + 46 : y + 15, 'text-anchor': 'middle', class: 'nnote' });
      nt.appendChild(txt(n.note));
      grp.appendChild(nt);
    }
    svg.appendChild(grp);
  }
}

// ---- comparison panel ----
const PRETTY = {
  network_exposure: 'network exposure', public_exposure: 'public exposure',
  data_exfiltration: 'data exfiltration', permissions_management: 'perms mgmt',
  infrastructure_modification: 'infra modification', service_wildcard: 'service wildcard',
  privilege_escalation: 'priv-esc', credentials_exposure: 'creds exposure',
};
const HIGH = new Set(['privilege_escalation', 'credentials_exposure', 'permissions_management', 'data_exfiltration', 'service_wildcard']);
const pretty = (c) => PRETTY[c] || c;

function netContrib(byCat) { return NETWORK_CATS.reduce((s, c) => s + (byCat[c] || 0), 0); }
function adjScore(scored, m) { return Math.round(scored.score + netContrib(scored.byCategory) * (m - 1)); }

function driverChips(added) {
  const tally = {};
  let newActions = 0, unused = 0, reach = 1;
  for (const f of added) {
    if (f.category === 'breadth') { newActions++; continue; }
    if (f.category === 'unused_grant') { unused++; continue; }
    tally[f.category] = (tally[f.category] || 0) + 1;
    if (f.reachFactor && f.reachFactor > reach) reach = f.reachFactor;
  }
  const chips = [];
  if (newActions) chips.push(`<span class="chip">${newActions} new actions</span>`);
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => {
    const cls = NETWORK_CATS.includes(c) ? 'net' : HIGH.has(c) ? 'hi' : '';
    chips.push(`<span class="chip ${cls}">${pretty(c)}: ${n}</span>`);
  });
  if (unused) chips.push(`<span class="chip unused">${unused} unused grants</span>`);
  if (reach > 1) chips.push(`<span class="chip reach">shared-role reach ×${reach}</span>`);
  return chips.join('');
}

function renderPanel() {
  const p = $('panel');
  if (!state.cmp) { p.innerHTML = '<div class="phead">running…</div>'; return; }
  const c = state.cmp;
  const cand = {}; c.candidates.forEach((x) => (cand[x.scored.ref] = x));
  const m = state.mult;

  const base = adjScore(c.baseline, m);
  const rows = ['fix-A', 'fix-B'].filter((r) => cand[r]).map((r) => {
    const x = cand[r];
    return { ref: r, score: adjScore(x.scored, m), added: x.diff.added, removed: x.diff.removed };
  });
  const winner = rows.slice().sort((a, b) => a.score - b.score)[0];
  const maxS = Math.max(base, ...rows.map((r) => r.score), 1);

  let html = `<div class="phead">blast-radius comparison</div>`;
  html += `<div class="baseline">baseline (main): score ${base}</div>`;

  if (state.cur.weightsSlider) {
    html += `<div class="slider"><label><span>threat model — network sensitivity</span><span id="mval">×${m.toFixed(1)}</span></label>
      <input id="mslider" type="range" min="0" max="2" step="0.1" value="${m}" />
      <label><span style="color:var(--dim)">ignore network</span><span style="color:var(--dim)">paranoid</span></label></div>`;
  }

  for (const row of rows) {
    const isWin = row.ref === winner.ref, isSel = row.ref === state.fix;
    const col = isWin ? 'var(--green)' : 'var(--red)';
    const delta = row.score - base;
    html += `<div class="card ${isWin ? 'win' : ''} ${isSel ? 'sel' : ''}" data-ref="${row.ref}">
      <h3>${row.ref}${isWin ? ' <span style="color:var(--green);font-size:12px">✓ smaller</span>' : ''}</h3>
      <div class="pitch">${state.cur.fixes[row.ref] || ''}</div>
      <div><span class="score" style="color:${col}">${row.score}</span><span class="delta">${delta >= 0 ? '+' : ''}${delta} vs baseline</span></div>
      <div class="bar"><span style="width:${Math.max(2, (row.score / maxS) * 100)}%;background:${col}"></span></div>
      <div class="chips">${driverChips(row.added) || '<span class="chip">no new findings</span>'}</div>
    </div>`;
  }

  if (rows.length === 2) {
    const factor = winner.score > 0 ? (Math.max(...rows.map((r) => r.score)) / winner.score) : Infinity;
    const other = rows.find((r) => r.ref !== winner.ref);
    html += `<div class="verdict">✅ Smallest blast radius: <b>${winner.ref}</b>` +
      (isFinite(factor) ? ` — ${factor.toFixed(1)}× smaller than ${other.ref}` : '') + `</div>`;
  }

  p.innerHTML = html;

  p.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.onclick = () => { state.fix = cardEl.dataset.ref; renderFixbar(); renderGraph(); renderPanel(); };
  });
  const sl = $('mslider');
  if (sl) sl.oninput = () => { state.mult = parseFloat(sl.value); $('mval').textContent = '×' + state.mult.toFixed(1); renderPanel(); };
}

load();
