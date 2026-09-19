'use strict';

/* Hack-Meck Client (Light-Minimal-UI nach Referenzgrafik).
 * Rendert ausschließlich den Server-State (STATE-Nachrichten).
 * Verbindung: WebSocket auf gleichem Host/Port (LAN-fähig, kein hardcoded Host).
 * Session (Code + Token) liegt in localStorage für Reconnect.
 *
 * Layout: Status-Pill oben, Spieler in Eck-Panels (ich unten-links),
 * Gegner-Würfel-Schale oben, Wurmkarten mittig, eigene Schale unten,
 * das EINE Würfelfeld (#diceTable) wandert animiert zum aktiven Spieler.
 * Spiellogik, Protokoll und Server-Autorität bleiben unberührt.
 */

const $ = (sel) => document.querySelector(sel);
const SESSION_KEY = 'heckmeck-session-v1';

const S = {
  ws: null,
  connected: false,
  code: null,
  playerId: null,
  token: null,
  name: '',
  state: null, // letzte STATE-Nachricht
  lastRolledKey: '',
  retryTimer: null,
  bannerTimer: null,
  flashTimer: null,
  diceSide: null, // 'top' | 'bottom' – wo das Würfelfeld gerade liegt
  pendingChoice: null, // NEED_CHOICE-Optionen für Steal-Highlight
  lastFlipped: null, // zuletzt umgedrehte/genommene Portion (wird im Grill geflasht)
  pendingFly: null, // Kartenflug: { kind, value, fromRect } – Ziel folgt nach STATE-Render
  wasMine: false, // für „DU BIST DRAN“-Flash bei Zugwechsel
  overShown: false, // GEWONNEN!-Flash nur einmal pro Spielende
  lastPillText: '', // Status-Pill: nur bei Wechsel animieren
  grillKeys: null, // offene Grillwerte des letzten Renders (nur neue Karten animieren)
  setAsideKey: '', // Beiseite-Stand des letzten Renders (Pop nur bei Änderung)
  rollSeq: 0, // Lande-Ticks: nur aktuellster Wurf darf ticken
  landingTimers: [], // offene Lande-Tick-Timeouts (cleanup bei neuem Wurf/Verlassen)
  throwTimer: null, // Fallback: optimistische Wurf-Anhebung wieder entfernen
};

/** Wurfdauer pro Würfel in Sekunden (540–680 ms, subtil unterschiedlich). */
function rollDur(i) {
  return 0.54 + ((i * 53) % 5) * 0.035;
}

function clearLandingTimers() {
  for (const id of S.landingTimers) clearTimeout(id);
  S.landingTimers = [];
}

/**
 * Plant pro Würfel einen Lande-Tick passend zur Animations-Staffelung
 * (Delay + individuelle Dauer). Nur der aktuellste Wurf tickt; bei
 * Reduced Motion gibt es einen einzelnen weichen Tick.
 */
function scheduleLandingTicks(rolled) {
  clearLandingTimers();
  if (reduceMotion()) {
    Sfx.tick(0);
    return;
  }
  const seq = ++S.rollSeq;
  const key = rolled.join(',');
  rolled.forEach((v, i) => {
    const ms = i * 70 + rollDur(i) * 1000;
    const id = setTimeout(() => {
      if (seq !== S.rollSeq) return;
      if (S.lastRolledKey !== key) return; // STATE zeigt längst anderes
      if (v === 'W') Sfx.wormTick();
      else Sfx.tick(i);
    }, ms);
    S.landingTimers.push(id);
  });
}

/* Pastell-Avatare (Initialen): gedeckt + dezent, passend zur ruhigen Palette. */
const AVATARS = [
  ['#e3f6ec', '#1e9e62'],
  ['#e7effd', '#2f62c4'],
  ['#fdeede', '#a86a17'],
  ['#fdecec', '#c0323c'],
  ['#efe9fb', '#6d4fc2'],
  ['#e2f2f2', '#147a7a'],
];

function avatarColors(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  const s = (parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
  return s.toUpperCase();
}

/** Inline-Wurm-SVG (grün = Standard/niedrig, rot = hohe Karten). */
function wormSvg(red = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', red ? '#wormIconRed' : '#wormIconGreen');
  svg.appendChild(use);
  return svg;
}

// ---------- Sound (WebAudio-Synth, keine Assets, alles transform-frei) ----------

const Sfx = {
  ctx: null,
  master: null,
  // 3 Stufen: 0 = aus, 1 = leise (35 %), 2 = an (100 %). Persistiert, migriert altes Mute-Flag.
  level: (() => {
    const v = Number(localStorage.getItem('heckmeck-volume'));
    if (v === 0 || v === 1 || v === 2) return v;
    return localStorage.getItem('heckmeck-muted') === '1' ? 0 : 2;
  })(),
  setLevel(l) {
    this.level = l;
    localStorage.setItem('heckmeck-volume', String(l));
    if (this.master && this.ctx) this.master.gain.setValueAtTime([0, 0.35, 1][l], this.ctx.currentTime);
  },
  ensure() {
    if (this.level === 0) return null;
    try {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
      }
      this.master.gain.setValueAtTime([0, 0.35, 1][this.level], this.ctx.currentTime);
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  },
  tone(freq, dur = 0.1, type = 'sine', gain = 0.15, when = 0, slideTo = null) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const gn = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(gn).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  },
  noise(dur = 0.08, freq = 2000, gain = 0.12, when = 0, freqEnd = null) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t0);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    const gn = ctx.createGain();
    gn.gain.value = gain;
    src.connect(f).connect(gn).connect(this.master);
    src.start(t0);
  },
  // --- Würfel: Start, Lande-Ticks (trocken, leise), Wurm-Special ---
  rollStart() { this.noise(0.12, 900, 0.08, 0, 2400); this.tone(300, 0.1, 'sine', 0.04, 0, 600); },
  tick(i) {
    this.noise(0.03, 3400 - (i % 5) * 220, 0.16);
    this.tone(190 + (i % 5) * 14, 0.05, 'triangle', 0.2, 0, 120);
  },
  wormTick() {
    this.noise(0.03, 2600, 0.1);
    this.tone(660, 0.09, 'sine', 0.06);
    this.tone(990, 0.12, 'sine', 0.05, 0.07);
  },
  pick() { this.tone(640, 0.07, 'square', 0.05); this.tone(960, 0.06, 'sine', 0.07, 0.04); },
  pickWorm() { this.tone(740, 0.08, 'sine', 0.08); this.tone(1108, 0.12, 'sine', 0.06, 0.06); },
  // --- Karten: Slide bei Abflug, sanftes Auflegen bei Landung ---
  cardSlide() { this.noise(0.18, 500, 0.08, 0, 1500); },
  cardPlace() { this.noise(0.06, 600, 0.14); this.tone(170, 0.07, 'triangle', 0.14, 0, 110); },
  roll() { this.noise(0.07, 2500, 0.12, 0); this.noise(0.07, 1800, 0.1, 0.09); this.noise(0.09, 1200, 0.1, 0.18); },
  take() { this.tone(523, 0.12, 'triangle', 0.14); this.tone(784, 0.18, 'triangle', 0.14, 0.1); },
  bust() { this.tone(220, 0.35, 'sawtooth', 0.1, 0, 90); this.noise(0.2, 300, 0.15, 0.02); },
  steal() { this.noise(0.25, 3000, 0.08); this.tone(880, 0.1, 'sine', 0.1, 0.16); this.tone(1174, 0.16, 'sine', 0.1, 0.24); },
  win() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.13, i * 0.13)); },
  turn() { this.tone(880, 0.12, 'sine', 0.08); },
};

function reduceMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function wormsForTile(v) {
  if (v <= 24) return 1;
  if (v <= 28) return 2;
  if (v <= 32) return 3;
  return 4;
}

function playerWorms(stack) {
  return stack.reduce((a, v) => a + wormsForTile(v), 0);
}

function dieLabel(v) {
  return v === 'W' ? '🪱' : v;
}

/* Echte Würfel: 1–5 als Pip-Raster, Wurm als SVG (kein Zahlentext).
 * Server-Werte bleiben maßgeblich — das ist reine Darstellung. */
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8] };

function renderDie(v, opts = {}) {
  const node = document.createElement(opts.button ? 'button' : 'div');
  node.className = 'die' + (v === 'W' ? ' worm' : '') + (opts.cls ? ` ${opts.cls}` : '');
  if (v === 'W') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#wormIconGreen');
    svg.appendChild(use);
    node.appendChild(svg);
    node.setAttribute('aria-label', 'Wurm (5 Punkte)');
  } else {
    const grid = document.createElement('span');
    grid.className = 'pips';
    grid.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 9; i++) {
      const c = document.createElement('span');
      c.className = 'pip' + (PIPS[v].includes(i) ? ' on' : '');
      grid.appendChild(c);
    }
    node.appendChild(grid);
    node.setAttribute('aria-label', `Würfel ${v}`);
  }
  if (opts.title) node.title = opts.title;
  if (opts.delay) node.style.animationDelay = opts.delay;
  if (opts.onClick) node.addEventListener('click', opts.onClick);
  return node;
}

/* Entfernt: avatarFor/primaryOpponent (altes Tisch-Layout) – ersetzt durch
 * Initialen-Avatare (avatarColors/initials) und feste Eck-Slots. */

// ---------- Session ----------

function saveSession() {
  if (S.code && S.token) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ code: S.code, token: S.token, name: S.name }));
  }
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ---------- Verbindung ----------

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

function setConnected(on) {
  S.connected = on;
  $('#connDot').classList.toggle('on', on);
  $('#connOverlay').classList.toggle('hidden', on);
}

function connect(afterOpen) {
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) {
    if (S.ws.readyState === 1 && afterOpen) afterOpen();
    return;
  }
  const ws = new WebSocket(wsUrl());
  S.ws = ws;
  ws.addEventListener('open', () => {
    setConnected(true);
    if (afterOpen) afterOpen();
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(msg);
  });
  ws.addEventListener('close', () => {
    setConnected(false);
    scheduleRetry();
  });
  ws.addEventListener('error', () => {
    try { ws.close(); } catch { /* ignore */ }
  });
}

function scheduleRetry() {
  // Nur automatisch neu verbinden, wenn eine Session zum Rejoin existiert.
  if (S.retryTimer || !loadSession()) return;
  S.retryTimer = setInterval(() => {
    const sess = loadSession();
    if (!sess || S.connected) {
      clearInterval(S.retryTimer);
      S.retryTimer = null;
      return;
    }
    connect(() => send({ t: 'rejoin', code: sess.code, token: sess.token }));
  }, 3000);
}

function send(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

// ---------- Nachrichten ----------

function onMessage(msg) {
  switch (msg.t) {
    case 'WELCOME':
      break;
    case 'JOINED':
      S.code = msg.code;
      S.playerId = msg.playerId;
      S.token = msg.token;
      saveSession();
      updateRoomBadge();
      break;
    case 'REJOINED':
      S.code = msg.code;
      S.playerId = msg.playerId;
      S.token = msg.token;
      saveSession();
      updateRoomBadge();
      toast('Wieder verbunden!');
      break;
    case 'PLAYER_JOINED':
      feed(`${msg.name} ist dabei.`);
      break;
    case 'PLAYER_LEFT':
      feed(`${msg.name} hat die Verbindung verloren.`);
      break;
    case 'GAME_STARTED':
      S.overShown = false;
      feed('Spiel gestartet!');
      break;
    case 'TURN_STARTED':
      break; // STATE danach zeichnet um
    case 'DICE_ROLLED':
      scheduleLandingTicks(msg.rolled);
      feed(`Gewürfelt: ${msg.rolled.map(dieLabel).join(' ')}`);
      break;
    case 'DICE_SELECTED':
      if (msg.picked === 'W') Sfx.pickWorm();
      else Sfx.pick();
      feed(`Gewählt: ${msg.count}× ${dieLabel(msg.picked)} (+${msg.score} Punkte)`);
      break;
    case 'BUST':
      clearChoiceHighlight();
      S.lastFlipped = msg.flipped || msg.returned || null;
      // Flug-Start merken (altes DOM zeigt den Stapel noch MIT der Portion).
      if (msg.returned) S.pendingFly = { kind: 'bust-return', value: msg.returned, fromRect: stackTopRect() };
      showBig('BUST!', 'bust');
      Sfx.bust();
      if (msg.returned) Sfx.cardSlide();
      shakeTable();
      showBanner(`💥 Fehlwurf!${msg.returned ? ` ${msg.returned} zurückgelegt.` : ''}${msg.flipped ? ` ${msg.flipped} umgedreht.` : ''}`, 'bust', 3200);
      feed('Fehlwurf!');
      break;
    case 'TILE_TAKEN': {
      clearChoiceHighlight();
      S.lastFlipped = msg.value;
      const gm = S.state?.game;
      const takerId = gm?.players[gm.currentPlayer]?.id || null;
      const who = gm?.players[gm.currentPlayer]?.name || '';
      const isSteal = msg.type === 'steal';
      // Flug-Start merken (altes DOM zeigt die Quelle noch am alten Ort).
      // takerId: nach STATE rotiert currentPlayer weiter — Ziel ist der Nehmer.
      S.pendingFly = isSteal
        ? { kind: 'steal', value: msg.value, takerId, fromRect: stackTopRect(msg.fromPlayer) }
        : { kind: 'take-grill', value: msg.value, takerId, fromRect: grillTileRect(msg.value) };
      const what = isSteal ? `stiehlt ${msg.value}` : `nimmt ${msg.value}`;
      if (isSteal) {
        showBig('STEAL!', 'steal');
        Sfx.cardSlide();
        Sfx.steal();
      } else {
        showBig('+ WURM!', 'take');
        Sfx.cardSlide();
        Sfx.take();
      }
      showBanner(`${who} ${what}!`, 'take', 2200);
      feed(`${who} ${what}.`);
      break;
    }
    case 'TURN_ENDED':
      break;
    case 'NEED_CHOICE':
      openChoice(msg.score, msg.options);
      break;
    case 'GAME_OVER':
      break; // STATE danach zeigt Rangliste
    case 'STATE':
      S.state = msg;
      render();
      break;
    case 'ERROR':
      toast(msg.message);
      break;
    default:
      break;
  }
}

// ---------- Großes Event-Feedback + Kartenflug (rein visualisierend) ----------

function showBig(text, kind, ms = 1350) {
  const box = $('#bigFlash');
  if (!box) return;
  $('#bigFlashText').textContent = text;
  box.className = `bigflash k-${kind}`;
  clearTimeout(S.flashTimer);
  S.flashTimer = setTimeout(() => box.classList.add('hidden'), reduceMotion() ? 400 : ms);
}

function shakeTable() {
  if (reduceMotion()) return;
  const t = $('#stage');
  if (!t) return;
  t.classList.remove('shake');
  void t.offsetWidth; // Reflow: Animation neu starten
  t.classList.add('shake');
}

/** Rect der Grillportion (altes DOM, vor STATE-Render) oder null. */
function grillTileRect(value) {
  const el = document.querySelector(`#grill .tile[data-value="${value}"]`);
  return el ? el.getBoundingClientRect() : null;
}

/**
 * Rect der obersten Stapelportion (altes DOM, vor STATE-Render) oder null.
 * playerIdx = game.js-Index (Default: aktueller Spieler).
 */
function stackTopRect(playerIdx) {
  const gm = S.state?.game;
  if (!gm) return null;
  const idx = playerIdx !== undefined ? playerIdx : gm.currentPlayer;
  const p = gm.players[idx];
  if (!p) return null;
  const stack = document.querySelector(`.seat-stack[data-pid="${p.id}"]`);
  if (stack) {
    const top = stack.querySelector('.mini') || stack;
    return top.getBoundingClientRect();
  }
  // Opfer/Nehmer in der Zusatzzeile (5+ Spieler): Panel als Ersatz-Quelle.
  const panel = document.querySelector(`.seat-more .ppanel[data-pid="${p.id}"]`);
  return panel ? panel.getBoundingClientRect() : null;
}

/**
 * Fliegt einen Karten-Klon von der gemerkten Quelle zum neuen Ziel.
 * Wird NACH dem STATE-Render aufgerufen; Server-State bleibt maßgeblich —
 * bei fehlenden Elementen oder Reduced Motion passiert nichts.
 */
function runPendingFly() {
  const fly = S.pendingFly;
  S.pendingFly = null;
  // Sanftes Auflegen auch ohne sichtbaren Flug (z. B. Reduced Motion).
  if (!fly || !fly.fromRect || reduceMotion()) {
    if (fly) setTimeout(() => Sfx.cardPlace(), 150);
    return;
  }
  let target = null;
  if (fly.kind === 'take-grill' || fly.kind === 'steal') {
    // Ziel: Stapel des Nehmers (per stabiler Spieler-ID, nicht per rotiertem Index).
    const stack = fly.takerId ? document.querySelector(`.seat-stack[data-pid="${fly.takerId}"]`) : null;
    target = (stack && (stack.querySelector('.mini') || stack)) || null;
  } else if (fly.kind === 'bust-return') {
    target = document.querySelector(`#grill .tile[data-value="${fly.value}"]`);
  }
  if (!target) return;
  const to = target.getBoundingClientRect();
  if (to.width === 0 && to.height === 0) return;
  const from = fly.fromRect;
  const clone = document.createElement('div');
  clone.className = 'fly-clone';
  clone.style.left = `${from.left}px`;
  clone.style.top = `${from.top}px`;
  clone.style.width = `${from.width}px`;
  clone.style.height = `${from.height}px`;
  const v = document.createElement('span');
  v.textContent = fly.value;
  const w = document.createElement('span');
  w.textContent = '🪱'.repeat(wormsForTile(fly.value));
  w.style.fontSize = '0.7rem';
  clone.append(v, w);
  document.body.appendChild(clone);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const sx = to.width / Math.max(1, from.width);
  const sy = to.height / Math.max(1, from.height);
  const anim = clone.animate(
    [
      { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 30}px) scale(${(1 + sx) / 2},${(1 + sy) / 2}) rotate(7deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx},${sy}) rotate(0deg)`, opacity: 0.9 },
    ],
    { duration: 600, easing: 'cubic-bezier(.2,.7,.3,1)' },
  );
  let landed = false;
  const land = () => {
    if (landed) return;
    landed = true;
    clone.remove();
    Sfx.cardPlace();
  };
  anim.onfinish = land;
  setTimeout(land, 800); // Fallback, falls onfinish nie feuert
}

// ---------- Screens ----------

function showScreen(id) {
  for (const s of ['screen-menu', 'screen-lobby', 'screen-game', 'screen-over']) {
    $(`#${s}`).classList.toggle('hidden', s !== id);
  }
}

function updateRoomBadge() {
  const b = $('#roomBadge');
  if (S.code) {
    b.textContent = S.code;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

function render() {
  const st = S.state;
  if (!st) return;
  if (st.status === 'lobby') {
    showScreen('screen-lobby');
    renderLobby(st);
  } else if (st.game && st.game.over) {
    showScreen('screen-over');
    renderOver(st);
  } else if (st.status === 'playing') {
    showScreen('screen-game');
    renderGame(st);
  }
}

// ---------- Lobby ----------

function renderLobby(st) {
  $('#lobbyCode').textContent = st.code;
  const ul = $('#lobbyPlayers');
  ul.innerHTML = '';
  for (const p of st.players) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.isBot ? '🤖' : '🟢'} <strong></strong></span><span class="sub"></span>`;
    li.querySelector('strong').textContent = p.name;
    li.querySelector('.sub').textContent = p.isBot ? 'Bot' : (p.connected ? 'bereit' : 'weg');
    ul.appendChild(li);
  }
  $('#btnStart').disabled = st.players.length < 2;
  $('#lobbyHint').textContent = st.players.length < 2
    ? 'Mindestens 2 Spieler nötig (Bots zählen mit).'
    : `${st.players.length} Spieler – es kann losgehen!`;
}

// ---------- Spieltisch ----------

function myTurn(st) {
  return st.game && st.game.currentPlayerId === S.playerId;
}

/* Entfernt: primaryOpponent (altes Tisch-Layout) – feste Eck-Slots in renderSeats. */

function renderGame(st) {
  const mine = myTurn(st);
  renderSeats(st, mine);
  renderGrill(st.game);
  renderTurn(st, mine);
  // Das Würfelfeld wandert erst nach dem Befüllen – kein Flackern, keine Doppelanzeige.
  moveDiceTable(!mine);
  updateSlotHints(st, mine);
  renderPill(st, mine);
  renderBottomBar(st);
  runPendingFly();
  if (mine && !S.wasMine) {
    showBig('DU BIST DRAN', 'turn', 1100);
    Sfx.turn();
  }
  S.wasMine = mine;
}

/** Status-Pill oben („Max ist am Zug“ / „Du bist am Zug“), animiert nur bei Wechsel. */
function renderPill(st, mine) {
  const gm = st.game;
  const me = gm.players[gm.currentPlayer];
  const text = mine ? 'Du bist am Zug' : `${me.name} ist am Zug`;
  if (text === S.lastPillText) return;
  S.lastPillText = text;
  $('#turnPillText').textContent = text;
  const pill = $('#turnPill');
  pill.classList.remove('hidden', 'swap');
  void pill.offsetWidth;
  pill.classList.add('swap');
}

/** Spielerpanel in den Ecken: Avatar-Initialen, Name, Wurm-Anzahl, Mini-Stapel. */
function panelNode(p, { active = false, activeText = '', you = false } = {}) {
  const el = document.createElement('div');
  el.className = 'ppanel' + (active ? ' active' : '');
  el.dataset.pid = p.id;

  const av = document.createElement('span');
  av.className = 'avatar';
  const [bg, fg] = avatarColors(p.name);
  av.style.setProperty('--av-bg', bg);
  av.style.setProperty('--av-fg', fg);
  av.textContent = initials(p.name);
  if (p.isBot) {
    const b = document.createElement('span');
    b.className = 'bot';
    b.textContent = '🤖';
    av.appendChild(b);
  }

  const info = document.createElement('span');
  info.className = 'pinfo';
  const nm = document.createElement('span');
  nm.className = 'pname';
  nm.textContent = p.name;
  if (you) {
    const y = document.createElement('span');
    y.className = 'you';
    y.textContent = ' (Du)';
    nm.appendChild(y);
  }
  const w = document.createElement('span');
  w.className = 'pworms';
  w.appendChild(wormSvg(false));
  const wc = document.createElement('span');
  wc.textContent = playerWorms(p.stack);
  w.appendChild(wc);
  if (active && activeText) {
    const at = document.createElement('span');
    at.className = 'you';
    at.textContent = ` · ${activeText}`;
    w.appendChild(at);
  }
  info.append(nm, w);

  const stack = document.createElement('span');
  stack.className = 'seat-stack';
  stack.dataset.pid = p.id;
  stack.appendChild(miniStackNode(p.stack));

  el.append(av, info, stack);
  return el;
}

/** Mini-Stapel: oberste Karte + Count-Badge (wie Referenz). */
function miniStackNode(stack) {
  const wrap = document.createElement('span');
  wrap.style.position = 'relative';
  wrap.style.display = 'inline-block';
  const m = document.createElement('span');
  if (stack.length === 0) {
    m.className = 'mini empty';
    m.textContent = '–';
  } else {
    m.className = 'mini';
    m.textContent = stack[stack.length - 1];
  }
  wrap.appendChild(m);
  if (stack.length > 0) {
    const b = document.createElement('span');
    b.className = 'count-badge';
    b.textContent = stack.length;
    wrap.appendChild(b);
  }
  return wrap;
}

function renderSeats(st, mine) {
  const players = st.game.players;
  const currentId = st.game.currentPlayerId;
  const me = players.find((p) => p.id === S.playerId);
  const opps = players.filter((p) => p.id !== S.playerId);

  // Ich fest unten-links; Gegner oben-links, oben-rechts, unten-rechts; Rest → Zusatzzeile.
  const slots = { seatME: me, seatTL: opps[0] || null, seatTR: opps[1] || null, seatBR: opps[2] || null };
  for (const [slotId, p] of Object.entries(slots)) {
    const slot = document.getElementById(slotId);
    slot.innerHTML = '';
    if (!p) continue;
    const isActive = p.id === currentId;
    slot.appendChild(panelNode(p, {
      active: isActive,
      activeText: p.id === S.playerId ? 'Du bist dran' : 'am Zug',
      you: p.id === S.playerId,
    }));
  }

  const more = $('#seatMore');
  more.innerHTML = '';
  for (const p of opps.slice(3)) {
    more.appendChild(panelNode(p, { active: p.id === currentId, activeText: 'am Zug' }));
  }
  highlightChoice();
}

/** Grill: NUR offene Karten (genommen = weg, wie Referenz). Zahl + 1–4 Wurm-Icons (≤28 grün, ≥29 rot). */
function renderGrill(gm) {
  const el = $('#grill');
  el.innerHTML = '';
  const prev = S.grillKeys || new Set();
  const next = new Set();
  for (const t of gm.grill) {
    if (!t.faceUp) continue;
    next.add(t.value);
    const d = document.createElement('div');
    d.className = 'tile' + (prev.has(t.value) ? '' : ' new');
    d.dataset.value = t.value;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = t.value;
    const ww = document.createElement('span');
    ww.className = 'ww';
    const red = t.value >= 29;
    for (let i = 0; i < t.worms; i++) ww.appendChild(wormSvg(red));
    d.append(v, ww);
    el.appendChild(d);
  }
  // Zuletzt zurückgekehrte Portion (BUST) hervorheben, falls wieder offen.
  if (S.lastFlipped !== null && S.lastFlipped !== undefined) {
    const hit = el.querySelector(`.tile[data-value="${S.lastFlipped}"]`);
    if (hit) hit.classList.add('flash');
    S.lastFlipped = null;
  }
  S.grillKeys = next;
  highlightChoice();
}

/**
 * Das EINE Würfelfeld wandert zum aktiven Spieler:
 * Gegnerzug → Slot oben, eigener Zug → Slot unten.
 * FLIP-Animation (~450 ms): kein Teleportieren, kein Doppel-Render.
 */
function moveDiceTable(toTop) {
  const table = $('#diceTable');
  const target = toTop ? $('#diceSlotTop') : $('#diceSlotBottom');
  if (!table || !target) return;
  const want = toTop ? 'top' : 'bottom';
  if (table.parentElement === target) {
    S.diceSide = want;
    return;
  }
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const first = S.diceSide === null || reduceMotion ? null : table.getBoundingClientRect();
  target.appendChild(table);
  S.diceSide = want;
  if (first && table.animate) {
    const last = table.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx !== 0 || dy !== 0) {
      table.animate(
        [{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0.6 }, { transform: 'none', opacity: 1 }],
        { duration: 450, easing: 'cubic-bezier(.2,.7,.3,1)' },
      );
    }
  }
}

/**
 * Darf „Nehmen / Beenden" angeboten werden? Reine Anzeige-Logik
 * (Spiegel von game.canTake aus dem STATE): Wurm UND erreichbare
 * Portion nötig – sonst wäre der Klick ein sofortiger Fehlwurf mit
 * Strafe. Der Server bleibt autoritativ (er bustet trotzdem korrekt,
 * falls die Aktion z. B. als Bot-Ersatz erzwungen wird).
 */
function takeReadiness(turn, grill, players, currentPlayer) {
  if (turn.picked.length === 0) return { ok: false, reason: 'Noch nichts gewählt.' };
  if (!turn.hasWorm) return { ok: false, reason: 'Erst einen Wurm beiseitelegen.' };
  const score = turn.score;
  const grillExact = grill.some((t) => t.faceUp && t.value === score);
  const stealExact = players.some((p, i) => i !== currentPlayer && p.stack[p.stack.length - 1] === score);
  const lower = grill.some((t) => t.faceUp && t.value < score);
  if (!grillExact && !stealExact && !lower) {
    return { ok: false, reason: 'Punkte reichen für keine Portion – weiterwürfeln.' };
  }
  return { ok: true };
}

function renderTurn(st, mine) {
  const gm = st.game;
  const me = gm.players[gm.currentPlayer];
  $('#diceTable').classList.toggle('mine', mine);
  $('#turnTitle').textContent = mine ? 'Du bist am Zug 🎲' : `Am Zug: ${me.name}`;
  const score = gm.turn.score;
  $('#scoreLine').textContent = `Punkte: ${score}`;
  const wl = $('#wormLine');
  if (gm.turn.hasWorm) {
    wl.textContent = '🪱 Wurm gesichert';
    wl.className = 'worm-line ok';
  } else {
    wl.textContent = 'Kein Wurm – Nehmen gesperrt, weiterwürfeln';
    wl.className = 'worm-line missing';
  }

  // Geworfene Würfel (klickbar, wenn ich wählen darf).
  const rd = $('#rolledDice');
  rd.innerHTML = '';
  const canChoose = mine && gm.turn.phase === 'pick';
  const rolledKey = gm.turn.rolled.join(',');
  const animate = rolledKey !== S.lastRolledKey && gm.turn.rolled.length > 0;
  S.lastRolledKey = rolledKey;
  // Server hat geantwortet: optimistische Anhebung zurücknehmen.
  $('#diceTable').classList.remove('throwing');
  if (gm.turn.rolled.length === 0) {
    rd.innerHTML = '<span class="empty-note">—</span>';
  }
  gm.turn.rolled.forEach((v, i) => {
    const ok = gm.turn.validPicks.includes(v);
    const delay = animate ? `${i * 70}ms` : undefined;
    let node;
    if (canChoose && ok) {
      node = renderDie(v, { button: true, cls: 'pickable', delay, title: `Wert ${dieLabel(v)} wählen`, onClick: () => send({ t: 'pick', value: v }) });
    } else {
      node = renderDie(v, { cls: canChoose && !ok ? 'locked' : '', delay, title: dieLabel(v) });
    }
    // Leichte Individualität pro Würfel (Richtung/Neigung + Dauer), Ergebnis bleibt Server-Wert.
    node.style.setProperty('--rd', (((i * 37) % 11) - 5) / 5);
    node.style.setProperty('--rdur', `${rollDur(i)}s`);
    if (animate) node.classList.add('just-rolled');
    rd.appendChild(node);
  });

  // Beiseitegelegt, gruppiert mit Punkten (Pop nur bei inhaltlicher Änderung).
  const sa = $('#setAside');
  sa.innerHTML = '';
  const entries = Object.entries(gm.turn.setAside);
  const saKey = JSON.stringify(gm.turn.setAside);
  const saChanged = saKey !== S.setAsideKey;
  S.setAsideKey = saKey;
  if (entries.length === 0) sa.innerHTML = '<span class="empty-note">—</span>';
  for (const [v, n] of entries) {
    const grp = document.createElement('div');
    grp.className = 'set-group' + (saChanged ? ' new' : '');
    for (let i = 0; i < n; i++) {
      grp.appendChild(renderDie(v, { cls: 'locked' }));
    }
    const lab = document.createElement('span');
    lab.className = 'n';
    lab.textContent = `${n}× ${dieLabel(v)}`;
    grp.appendChild(lab);
    sa.appendChild(grp);
  }

  $('#btnRoll').disabled = !(mine && gm.turn.phase === 'roll' && gm.turn.remaining > 0);
  // Nehmen nur bei erfüllten Anforderungen anbieten. Ausnahme phase 'take'
  // (alle 8 Würfel beiseite): Würfeln ist unmöglich, Nehmen ist die einzige
  // Aktion – endet ggf. als BUST (gleiche Regel wie bei Bots).
  const ready = takeReadiness(gm.turn, gm.grill, gm.players, gm.currentPlayer);
  const forced = gm.turn.phase === 'take';
  const takeAllowed = mine && (gm.turn.phase === 'roll' || forced)
    && gm.turn.picked.length > 0 && (ready.ok || forced);
  const btnTake = $('#btnTake');
  btnTake.disabled = !takeAllowed;
  btnTake.textContent = gm.turn.picked.length > 0 ? `Nehmen / Beenden (${score})` : 'Nehmen / Beenden';
  btnTake.title = (mine && gm.turn.picked.length > 0 && !ready.ok && !forced) ? ready.reason : '';

  // Hinweilszeile unter den Buttons (Referenz: „Wähle einen Wert aus“).
  const hint = $('#diceHint');
  if (hint) {
    hint.textContent = !mine
      ? `${me.name} spielt …`
      : gm.turn.phase === 'pick'
        ? 'Wähle einen Wert aus'
        : gm.turn.picked.length === 0
          ? 'Würfle, um zu starten'
          : 'Würfeln oder Nehmen';
  }

  // Inaktive Schale zeigt dezent, wer am Zug ist (Symmetrie zur Referenz).
  // (Hinweis: diceHint-Text bleibt in renderTurn.)
}

/** Füllt die würfellose Schale mit dezentem Hinweis (läuft NACH moveDiceTable). */
function updateSlotHints(st, mine) {
  const table = $('#diceTable');
  const name = st.game.players[st.game.currentPlayer]?.name || '';
  for (const [slotId, isMine] of [['diceSlotTop', false], ['diceSlotBottom', true]]) {
    const slot = document.getElementById(slotId);
    if (!slot) continue;
    const holdsTable = table && slot.contains(table);
    const idle = isMine === mine ? false : true;
    if (holdsTable) {
      slot.querySelector('.slot-hint')?.remove();
    } else if (idle) {
      slot.innerHTML = '';
      const s = document.createElement('span');
      s.className = 'slot-hint';
      s.textContent = mine ? 'Bereit' : `${name} ist am Zug`;
      slot.appendChild(s);
    }
  }
}

function renderBottomBar(st) {
  const players = st.game.players;
  const me = players.find((p) => p.id === S.playerId);
  $('#bbPlayers').textContent = `👥 ${players.length} Spieler`;
  $('#bbWorms').textContent = me ? `🪱 ${playerWorms(me.stack)} Würmer` : '';
  $('#bbCode').textContent = S.code ? `Raum ${S.code}` : '';
}

// ---------- Spielende ----------

function renderOver(st) {
  const gm = st.game;
  const winner = gm.ranking.find((r) => r.playerIndex === gm.winner);
  $('#overTitle').textContent = winner ? `🏆 ${winner.name} gewinnt!` : 'Spielende';
  if (!S.overShown) {
    S.overShown = true;
    showBig('GEWONNEN!', 'win', 1800);
    Sfx.win();
  }
  const tb = $('#rankingTable tbody');
  tb.innerHTML = '';
  gm.ranking.forEach((r, i) => {
    const tr = document.createElement('tr');
    if (i === 0) tr.className = 'winner';
    const tiles = gm.players[r.playerIndex]?.stack.join(', ') || '–';
    tr.innerHTML = `<td>${i + 1}.</td><td></td><td>${tiles}</td><td>${r.worms}</td>`;
    tr.children[1].textContent = r.name;
    tb.appendChild(tr);
  });
}

// ---------- Banner / Toast / Feed / Choice ----------

function showBanner(text, kind, ms = 2500) {
  const b = $('#banner');
  b.textContent = text;
  b.className = `banner ${kind}`;
  clearTimeout(S.bannerTimer);
  S.bannerTimer = setTimeout(() => b.classList.add('hidden'), ms);
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  $('#toastWrap').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function feed(text) {
  const ul = $('#eventFeed');
  if (!ul) return;
  const li = document.createElement('li');
  li.textContent = text;
  ul.prepend(li);
  while (ul.children.length > 8) ul.lastChild.remove();
}

function openChoice(score, options) {
  S.pendingChoice = options;
  $('#choiceText').textContent = `Mit ${score} Punkten passt es auf Grill und Gegnerstapel:`;
  const box = $('#choiceBtns');
  box.innerHTML = '';
  const players = S.state?.game?.players || [];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    if (o.source === 'grill') {
      btn.textContent = `Vom Grill: ${o.value}`;
      btn.addEventListener('click', () => {
        send({ t: 'take', choice: { source: 'grill' } });
        closeChoice();
      });
    } else {
      const fromName = players[o.fromPlayer]?.name || 'Gegner';
      btn.textContent = `Von ${fromName} stehlen: ${o.value}`;
      btn.addEventListener('click', () => {
        send({ t: 'take', choice: { source: 'steal', fromPlayer: o.fromPlayer } });
        closeChoice();
      });
    }
    box.appendChild(btn);
  }
  $('#choiceOverlay').classList.remove('hidden');
  const panel = $('#grillPanel');
  if (panel) panel.classList.add('choosing');
  highlightChoice();
}

/** Hebt die zur Wahl stehenden Steine am Tisch hervor (Rest tritt zurück). */
function highlightChoice() {
  const stage = $('#stage');
  if (!stage || !S.pendingChoice) return;
  for (const o of S.pendingChoice) {
    if (o.source === 'grill') {
      const tile = stage.querySelector(`.tile[data-value="${o.value}"]`);
      if (tile) tile.classList.add('stealable');
    } else if (o.fromPlayer !== undefined) {
      const players = S.state?.game?.players || [];
      const target = players[o.fromPlayer];
      if (!target) continue;
      stage.querySelectorAll('.seat-stack').forEach((el) => {
        if (el.dataset.pid === target.id) el.classList.add('stealable');
      });
    }
  }
}

function clearChoiceHighlight() {
  S.pendingChoice = null;
  const panel = $('#grillPanel');
  if (panel) panel.classList.remove('choosing');
  document.querySelectorAll('.stealable').forEach((el) => el.classList.remove('stealable'));
}

function closeChoice() {
  $('#choiceOverlay').classList.add('hidden');
  clearChoiceHighlight();
}

// ---------- Menü-Aktionen ----------

function playerName() {
  const n = $('#nameInput').value.trim().slice(0, 20) || 'Spieler';
  S.name = n;
  localStorage.setItem('heckmeck-name', n);
  return n;
}

function leaveToMenu() {
  if (S.retryTimer) {
    clearInterval(S.retryTimer);
    S.retryTimer = null;
  }
  try { S.ws?.close(); } catch { /* ignore */ }
  S.ws = null;
  S.code = null;
  S.playerId = null;
  S.token = null;
  S.state = null;
  S.lastRolledKey = '';
  S.diceSide = null;
  S.pendingChoice = null;
  S.lastFlipped = null;
  S.pendingFly = null;
  S.wasMine = false;
  S.overShown = false;
  S.lastPillText = '';
  S.grillKeys = null;
  S.setAsideKey = '';
  clearLandingTimers();
  S.rollSeq++;
  clearTimeout(S.throwTimer);
  clearSession();
  updateRoomBadge();
  refreshResume();
  showScreen('screen-menu');
}

function refreshResume() {
  const sess = loadSession();
  $('#resumeBox').classList.toggle('hidden', !sess);
  if (sess) $('#resumeText').textContent = `Weiter als ${sess.name} in Raum ${sess.code}?`;
}

$('#btnCreate').addEventListener('click', () => {
  connect(() => send({ t: 'create', name: playerName() }));
});
$('#btnJoin').addEventListener('click', () => {
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!code) {
    toast('Bitte Raumcode eingeben.');
    return;
  }
  S.name = playerName();
  connect(() => send({ t: 'join', code, name: S.name }));
});
$('#btnResume').addEventListener('click', () => {
  const sess = loadSession();
  if (!sess) return;
  S.name = sess.name;
  connect(() => send({ t: 'rejoin', code: sess.code, token: sess.token }));
});
$('#btnAddBot').addEventListener('click', () => {
  send({ t: 'addBot', difficulty: $('#botDifficulty').value });
});
$('#btnStart').addEventListener('click', () => send({ t: 'start' }));
$('#btnLeaveLobby').addEventListener('click', leaveToMenu);
$('#btnLeaveGame').addEventListener('click', leaveToMenu);
$('#btnRoll').addEventListener('click', () => {
  // Optimistisches Feedback: Würfel heben sich schon beim Klick (Server antwortet gleich).
  Sfx.rollStart();
  const t = $('#diceTable');
  t.classList.add('throwing');
  clearTimeout(S.throwTimer);
  S.throwTimer = setTimeout(() => t.classList.remove('throwing'), 900);
  send({ t: 'roll' });
});
$('#btnTake').addEventListener('click', () => send({ t: 'take' }));
$('#btnNewRoom').addEventListener('click', leaveToMenu);
$('#btnRetry').addEventListener('click', () => {
  const sess = loadSession();
  if (sess) {
    S.name = sess.name;
    connect(() => send({ t: 'rejoin', code: sess.code, token: sess.token }));
  } else {
    connect();
  }
});
$('#btnToMenu').addEventListener('click', () => {
  setConnected(true); // Overlay schließen
  leaveToMenu();
  setConnected(false);
});

// ---------- Start ----------

const SOUND_ICONS = ['🔇', '🔉', '🔊'];
const SOUND_LABELS = ['Sound aus', 'Sound leise', 'Sound an'];
function refreshSoundBtn() {
  const b = $('#btnSound');
  if (!b) return;
  b.textContent = SOUND_ICONS[Sfx.level];
  b.title = `${SOUND_LABELS[Sfx.level]} – klicken zum Wechseln`;
}
$('#btnSound').addEventListener('click', () => {
  Sfx.setLevel((Sfx.level + 2) % 3); // an → leise → aus → an …
  refreshSoundBtn();
  if (Sfx.level > 0) Sfx.pick();
});
// AudioContext darf erst nach Nutzer-Geste starten (Autoplay-Policy).
document.addEventListener('pointerdown', () => Sfx.ensure(), { once: true });

$('#nameInput').value = localStorage.getItem('heckmeck-name') || '';
refreshResume();
refreshSoundBtn();
connect();
showScreen('screen-menu');
