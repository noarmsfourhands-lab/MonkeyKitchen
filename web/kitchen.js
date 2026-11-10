// Monkey Kitchen front end. Draws the brigade once, then re-renders from the
// state snapshots the server pushes over /events.

const ROLES = [
  // back row, along the wall
  { id: 'prep-cook', name: 'Prep Cook', sub: 'finds & reads', tier: 'haiku', x: 11, y: 50, fur: '#a9743f', hat: 'cap', tool: '🔪', props: '🥕🥬', fx: '🥕' },
  { id: 'backend-cook', name: 'Grill Cook', sub: 'back end', tier: 'sonnet', x: 30, y: 50, fur: '#6b4a2f', hat: 'bandana', tool: '🍖', props: '🔥🥩', fx: '🔥' },
  { id: 'line-cook', name: 'Line Cook', sub: 'general build', tier: 'sonnet', x: 49, y: 50, fur: '#8b5a2b', hat: 'toque', tool: '🍳', props: '🍲🧅', fx: '💨' },
  { id: 'frontend-cook', name: 'Pastry Chef', sub: 'front end', tier: 'sonnet', x: 68, y: 50, fur: '#c98d5a', hat: 'beret', tool: '🧁', props: '🎂🍓', fx: '✨' },
  { id: 'dishwasher', name: 'Dishwasher', sub: 'cleanup', tier: 'haiku', x: 87, y: 50, fur: '#9a8f86', hat: 'none', tool: '🧽', props: '🍽️🚰', fx: '🫧' },
  // front row
  { id: 'runner', name: 'Runner', sub: 'fetches docs', tier: 'haiku', x: 8, y: 93, fur: '#b5651d', hat: 'headband', tool: '📦', props: '🍌📦', fx: '💨', front: true },
  { id: 'scribe', name: 'Menu Scribe', sub: 'docs', tier: 'haiku', x: 22, y: 93, fur: '#7d5a44', hat: 'cap', tool: '✏️', props: '📜🖋️', fx: '📝', front: true },
  { id: 'sous-chef', name: 'Sous Chef', sub: 'plans & hard bugs', tier: 'opus', x: 36, y: 93, fur: '#5c3b22', hat: 'toque', tool: '📐', props: '🗺️📏', fx: '💡', front: true, glasses: true },
  { id: 'head-chef', name: 'Head Chef', sub: 'runs the pass', tier: 'fable', x: 50.5, y: 93, fur: '#4a2f1b', hat: 'tall', tool: '🥄', props: '🛎️🍽️', fx: '⭐', front: true, boss: true, moustache: true },
  { id: 'taster', name: 'Taster', sub: 'runs tests', tier: 'sonnet', x: 65, y: 93, fur: '#a0683a', hat: 'toque', tool: '🥄', props: '🍜🧂', fx: '😋', front: true },
  { id: 'inspector', name: 'Health Inspector', sub: 'code review', tier: 'sonnet', x: 79, y: 93, fur: '#70675f', hat: 'flat', tool: '📋', props: '🔍🧾', fx: '❗', front: true, glasses: true },
  { id: 'stagiaire', name: 'Stagiaire', sub: 'guest agent', tier: 'guest', x: 92.5, y: 93, fur: '#c4a484', hat: 'paper', tool: '🥔', props: '🥔🥔', fx: '❓', front: true },
];
const ROLE_BY_ID = Object.fromEntries(ROLES.map(r => [r.id, r]));
const TIER_LABEL = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', guest: 'Guest', other: 'Other' };
const TIER_COLOR = { fable: '#b77fd0', opus: '#f08a63', sonnet: '#5cc7c7', haiku: '#8fd17c', other: '#bbb' };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- drawing ----------

function hatSvg(kind) {
  switch (kind) {
    case 'tall':
      return `<path d="M36 34 q-14 -30 8 -34 q4 -16 16 -9 q14 -9 18 9 q20 4 6 34z" fill="#fff" stroke="#cfc6b4" stroke-width="1.5"/>
              <rect x="36" y="29" width="48" height="10" rx="3" fill="#fff" stroke="#cfc6b4" stroke-width="1.5"/>`;
    case 'toque':
      return `<path d="M38 34 q-12 -18 8 -22 q4 -12 14 -7 q12 -7 16 7 q18 4 6 22z" fill="#fff" stroke="#cfc6b4" stroke-width="1.5"/>
              <rect x="37" y="30" width="46" height="9" rx="3" fill="#fff" stroke="#cfc6b4" stroke-width="1.5"/>`;
    case 'beret':
      return `<ellipse cx="62" cy="31" rx="27" ry="10" fill="#e86a92"/><circle cx="64" cy="20" r="3" fill="#e86a92"/>`;
    case 'bandana':
      return `<path d="M31 42 q29 -22 58 0 l0 -8 q-29 -20 -58 0z" fill="#c0392b"/><path d="M88 36 l12 -4 l-6 10z" fill="#c0392b"/>`;
    case 'headband':
      return `<rect x="31" y="36" width="58" height="7" rx="3" fill="#2e86de"/>`;
    case 'cap':
      return `<path d="M36 38 q24 -26 48 0z" fill="#fff" stroke="#cfc6b4" stroke-width="1.5"/>`;
    case 'flat':
      return `<path d="M32 38 q28 -22 56 0 l10 3 l-66 0z" fill="#3d4a5c"/>`;
    case 'paper':
      return `<path d="M36 38 l8 -18 l16 0 l16 0 l8 18z" fill="#fff" stroke="#cfc6b4" stroke-width="1.5"/>`;
    default:
      return '';
  }
}

function monkeySvg(r) {
  const face = '#f3d2a4';
  return `
<svg class="monkey" viewBox="0 -6 120 146" aria-hidden="true">
  <g class="whole">
    <path class="tail" d="M86 118 q30 4 25 -24 q-3 -15 -15 -9" fill="none" stroke="${r.fur}" stroke-width="7" stroke-linecap="round"/>
    <ellipse cx="60" cy="112" rx="27" ry="29" fill="${r.fur}"/>
    <path d="M42 96 h36 v36 q-18 7 -36 0z" fill="#fff" stroke="#e0d8c8" stroke-width="1"/>
    <g class="arm-l">
      <path d="M38 98 q-17 8 -15 27" fill="none" stroke="${r.fur}" stroke-width="9" stroke-linecap="round"/>
      <circle cx="23" cy="127" r="6" fill="${face}"/>
    </g>
    <g class="arm-r">
      <path d="M82 98 q17 8 15 27" fill="none" stroke="${r.fur}" stroke-width="9" stroke-linecap="round"/>
      <circle cx="97" cy="127" r="6" fill="${face}"/>
      <text x="97" y="126" font-size="20" text-anchor="middle">${r.tool}</text>
    </g>
    <g class="head">
      <circle cx="29" cy="60" r="11" fill="${r.fur}"/><circle cx="29" cy="60" r="6" fill="${face}"/>
      <circle cx="91" cy="60" r="11" fill="${r.fur}"/><circle cx="91" cy="60" r="6" fill="${face}"/>
      <circle cx="60" cy="62" r="30" fill="${r.fur}"/>
      <path d="M40 58 q0 -17 20 -10 q20 -7 20 10 q4 25 -20 27 q-24 -2 -20 -27z" fill="${face}"/>
      <g class="eyes"><circle cx="50" cy="59" r="3.6" fill="#2b1d12"/><circle cx="70" cy="59" r="3.6" fill="#2b1d12"/></g>
      ${r.glasses ? `<g fill="none" stroke="#2b1d12" stroke-width="1.8"><circle cx="50" cy="59" r="8"/><circle cx="70" cy="59" r="8"/><path d="M58 59h4"/></g>` : ''}
      <circle cx="57" cy="69" r="1.2" fill="#8a5a3a"/><circle cx="63" cy="69" r="1.2" fill="#8a5a3a"/>
      <path d="M50 74 q10 8 20 0" fill="none" stroke="#2b1d12" stroke-width="2" stroke-linecap="round"/>
      ${r.moustache ? `<path d="M60 72 q-8 -5 -16 2 q9 3 16 -2 q7 5 16 2 q-8 -7 -16 -2z" fill="#2b1d12"/>` : ''}
      ${hatSvg(r.hat)}
      <path class="sweat" d="M92 44 q4 6 0 8 q-4 -2 0 -8z" fill="#6ec6f0"/>
    </g>
    <text class="zzz" x="88" y="34">z</text>
  </g>
</svg>`;
}

function backdropSvg() {
  return `
<svg viewBox="0 0 1600 900" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <pattern id="tiles" width="80" height="80" patternUnits="userSpaceOnUse">
      <rect width="80" height="80" fill="#f8ecd0"/><path d="M0 0h80v80" fill="none" stroke="#e6d3a8" stroke-width="3"/>
    </pattern>
    <pattern id="floor" width="120" height="120" patternUnits="userSpaceOnUse">
      <rect width="120" height="120" fill="#e9d2a6"/><rect width="60" height="60" fill="#c98f58"/><rect x="60" y="60" width="60" height="60" fill="#c98f58"/>
    </pattern>
  </defs>
  <rect width="1600" height="470" fill="url(#tiles)"/>
  <rect y="470" width="1600" height="430" fill="url(#floor)"/>
  <rect y="455" width="1600" height="26" fill="#8a5527"/>
  <!-- window -->
  <rect x="690" y="150" width="220" height="150" rx="10" fill="#bfe6f7" stroke="#8a5527" stroke-width="10"/>
  <path d="M800 150v150M690 225h220" stroke="#8a5527" stroke-width="6"/>
  <circle cx="860" cy="190" r="18" fill="#ffd95a"/>
  <!-- shelf with jars -->
  <rect x="150" y="205" width="330" height="12" fill="#8a5527"/>
  <text x="165" y="200" font-size="48">🫙🍯🧄🌶️🫙</text>
  <rect x="1110" y="205" width="300" height="12" fill="#8a5527"/>
  <text x="1125" y="200" font-size="48">🥫🧂🍋🥫</text>
  <!-- hanging pans -->
  <path d="M520 130h130" stroke="#6b6b6b" stroke-width="6"/>
  <text x="525" y="188" font-size="46">🍳🥘</text>
  <!-- banana clock -->
  <circle cx="1010" cy="200" r="46" fill="#fff8ea" stroke="#3b2a1e" stroke-width="6"/>
  <text x="1010" y="218" font-size="50" text-anchor="middle">🍌</text>
  <!-- pantry door -->
  <rect x="20" y="520" width="90" height="0" fill="#8a5527"/>
</svg>`;
}

function buildScene() {
  $('backdrop').innerHTML = backdropSvg();
  $('stations').innerHTML = ROLES.map((r, i) => `
    <div class="station s-${r.id} idle${r.front ? ' front' : ''}${r.boss ? ' boss' : ''}" id="st-${r.id}" style="left:${r.x}%;top:${r.y}%">
      <div class="monkey-wrap">
        <div class="bubble"></div>
        <div class="count"></div>
        ${monkeySvg(r)}
      </div>
      <div class="counter">
        <span class="props">${r.props}</span>
        <div class="fx"><span>${r.fx}</span><span>${r.fx}</span><span>${r.fx}</span></div>
      </div>
      <div class="nameplate"><b>${r.name}</b><i class="tier ${r.tier}">${TIER_LABEL[r.tier].toUpperCase()}</i><small>${r.sub}</small></div>
    </div>`).join('') + '<div class="fly">🪰</div>';
  // de-sync the idle animations so the kitchen doesn't breathe in unison
  document.querySelectorAll('.station').forEach((el, i) => {
    el.querySelectorAll('.whole, .zzz, .head, .tail').forEach(n => { n.style.animationDelay = `${-(i * 0.47) % 3}s`; });
  });
}

// ---------- rendering ----------

const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
const money = n => '$' + (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));
const celebrated = new Set();
let firstRender = true;

function setStation(id, status, bubble, count) {
  const el = $('st-' + id);
  if (!el) return;
  for (const c of ['idle', 'working', 'waiting', 'failed']) el.classList.toggle(c, c === status);
  el.classList.toggle('multi', count > 1);
  el.querySelector('.count').textContent = count > 1 ? '×' + count : '';
  if (!el.classList.contains('celebrate')) el.querySelector('.bubble').textContent = bubble || '';
}

function celebrate(id, text) {
  const el = $('st-' + id);
  if (!el) return;
  el.classList.add('celebrate');
  el.querySelector('.bubble').textContent = text;
  setTimeout(() => el.classList.remove('celebrate'), 2200);
}

function render(s) {
  // order
  const order = s.order || {};
  $('order').className = 'order ' + (order.status || '');
  $('order-text').textContent = order.text || 'The kitchen is quiet. Send an order from Claude Code.';
  $('order-text').title = order.text || '';

  // head chef
  const chef = s.chef || { status: 'idle' };
  setStation('head-chef', chef.status, chef.activity, 1);

  // cooks, grouped by station
  const cooks = s.cooks || [];
  for (const r of ROLES) {
    if (r.id === 'head-chef') continue;
    const mine = cooks.filter(c => c.role === r.id);
    const working = mine.filter(c => c.status === 'working');
    const lastFail = mine.find(c => c.status === 'failed' && s.now - c.endedAt < 8000);
    const lead = working[working.length - 1];
    if (lead) {
      const label = r.id === 'stagiaire' && lead.agentType ? `[${lead.agentType}] ` : '';
      setStation(r.id, 'working', label + (lead.activity || lead.ticket || 'Cooking…'), working.length);
    } else if (lastFail) {
      setStation(r.id, 'failed', '💥 Sent back!', 0);
    } else {
      setStation(r.id, 'idle', '', 0);
    }
    for (const c of mine) {
      if (c.status === 'done' && !celebrated.has(c.id)) {
        celebrated.add(c.id);
        if (!firstRender && !working.length) celebrate(r.id, '🛎️ Order up!');
      }
    }
  }
  if (order.status === 'served' && !celebrated.has('order:' + order.startedAt)) {
    celebrated.add('order:' + order.startedAt);
    if (!firstRender) celebrate('head-chef', '👨‍🍳 Service!');
  }

  // ticket rail: working first, then most recent finished
  const sorted = [...cooks].sort((a, b) => (a.status === 'working' ? 0 : 1) - (b.status === 'working' ? 0 : 1) || b.startedAt - a.startedAt);
  const shown = sorted.slice(0, 7);
  $('rail').innerHTML = shown.map(c => {
    const r = ROLE_BY_ID[c.role] || ROLE_BY_ID.stagiaire;
    return `<div class="ticket ${c.status}" title="${esc(c.ticket)}"><b>${r.tool} ${esc(r.name)}</b><span>${esc(c.ticket || c.agentType || 'ticket')}</span></div>`;
  }).join('') + (sorted.length > shown.length ? `<div class="ticket more">+${sorted.length - shown.length}</div>` : '');

  $('fire-count').textContent = s.dropped || 0;

  // usage chalkboard
  const u = s.usage;
  if (u && u.tiers && u.tiers.length) {
    $('usage-body').innerHTML = u.tiers.map(t => `
      <tr><td><span class="dot" style="background:${TIER_COLOR[t.tier] || TIER_COLOR.other}"></span>${TIER_LABEL[t.tier] || esc(t.tier)}</td>
      <td>${fmt(t.input)}</td><td>${fmt(t.output)}</td><td>${fmt(t.cacheRead)}</td><td>${money(t.cost)}</td></tr>`).join('') +
      `<tr class="total"><td>Total</td><td>${fmt(u.total.input)}</td><td>${fmt(u.total.output)}</td><td>${fmt(u.total.cacheRead)}</td><td>${money(u.total.cost)}</td></tr>`;
    const saved = u.soloCost - u.total.cost;
    $('saving').innerHTML = u.soloCost > 0 && saved > 0.0005
      ? `Head Chef alone would have run <b>${money(u.soloCost)}</b>. The brigade saved <b>${Math.round(100 * saved / u.soloCost)}%</b>.`
      : (u.soloCost > 0 ? 'No savings yet: everything so far ran at the Head Chef’s tier.' : '');
  } else {
    $('usage-body').innerHTML = '<tr><td colspan="5" class="muted">Nothing cooked yet</td></tr>';
    $('saving').textContent = '';
  }

  // feed, newest first
  $('feed').innerHTML = (s.feed || []).slice().reverse().map(f => {
    const r = ROLE_BY_ID[f.who] || ROLE_BY_ID.stagiaire;
    const t = new Date(f.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<li class="${f.fail ? 'fail' : ''}"><time>${t}</time><b>${r.tool} ${esc(r.name)}</b>${esc(f.text)}</li>`;
  }).join('');

  firstRender = false;
}

// ---------- session picker + live connection ----------

let watching = null; // session id the user picked, or null for "most recent"
let lastAll = null;

function onSnapshot(all) {
  lastAll = all;
  const pick = $('session-pick');
  const ids = all.sessions.map(x => x.id);
  if (watching && !ids.includes(watching)) watching = null;
  pick.hidden = all.sessions.length < 2;
  pick.innerHTML = `<option value="">Latest session</option>` + all.sessions.map(x =>
    `<option value="${esc(x.id)}"${x.id === watching ? ' selected' : ''}>${esc(x.project)} · ${esc(x.id.slice(0, 6))}</option>`).join('');
  const s = all.sessions.find(x => x.id === watching) || all.sessions[0];
  render(s ? { ...s, now: all.now } : { now: all.now });
}

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { $('conn').classList.add('live'); $('closed').hidden = true; };
  es.onmessage = e => onSnapshot(JSON.parse(e.data));
  es.onerror = () => { $('conn').classList.remove('live'); $('closed').hidden = false; };
}

buildScene();
$('session-pick').addEventListener('change', e => { watching = e.target.value || null; if (lastAll) onSnapshot(lastAll); });
connect();
