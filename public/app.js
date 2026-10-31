'use strict';

/* Hack-Meck Client – Kartentisch-UI (Light/Dark, 3D-Würfel, Spielkarten).
 * Rendert ausschließlich den Server-State (STATE-Nachrichten); Spiellogik,
 * Protokoll und Server-Autorität bleiben unberührt.
 * Verbindung: WebSocket auf gleichem Host/Port (LAN-fähig).
 * Session (Code + Token) liegt in localStorage für Reconnect.
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
  state: null,
  lastRolledKey: '',
  retryTimer: null,
  bannerTimer: null,
  flashTimer: null,
  pendingChoice: null,
  lastFlipped: null,
  pendingFly: null,
  pendingFlip: null,
  wasMine: false,
  overShown: false,
  lastPillText: '',
  grillKeys: null,
  setAsideKey: '',
  rollSeq: 0,
  landingTimers: [],
  throwTimer: null,
  botDiff: 'normal',
  wormCounts: {},
  shownScore: 0,
  scoreRaf: 0,
};

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

function reduceMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- Theme (System / Hell / Dunkel) ----------

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Design: automatisch', light: 'Design: hell', dark: 'Design: dunkel' };
const THEME_ICON = { auto: '#i-auto', light: '#i-sun', dark: '#i-moon' };

function getTheme() {
  const t = lsGet('heckmeck-theme');
  return t === 'light' || t === 'dark' ? t : 'auto';
}

function resolveTheme(t) {
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(t) {
  const root = document.documentElement;
  const dark = resolveTheme(t) === 'dark';
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-pref', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#2c1d18' : '#ecd0a4');
  const b = $('#btnTheme');
  if (b) {
    b.querySelector('use').setAttribute('href', THEME_ICON[t]);
    b.setAttribute('aria-label', `${THEME_LABEL[t]} – klicken zum Wechseln`);
  }
}

/** Wechselt das Theme; mit View-Transition als Kreis-Reveal ab dem Button (falls verfügbar). */
function cycleTheme(ev) {
  const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
  if (next === 'auto') lsDel('heckmeck-theme');
  else lsSet('heckmeck-theme', next);
  const change = () => applyTheme(next);
  if (reduceMotion() || !document.startViewTransition) { change(); return; }
  const r = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : { left: innerWidth - 40, top: 30, width: 0, height: 0 };
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = document.startViewTransition(change);
  vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 650, easing: 'cubic-bezier(.3,.7,.2,1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {});
}

// ---------- Hilfsfunktionen ----------

/** Wurfdauer pro Würfel in Sekunden (540–680 ms, subtil unterschiedlich). */
function rollDur(i) {
  return 0.54 + ((i * 53) % 5) * 0.035;
}

function clearLandingTimers() {
  for (const id of S.landingTimers) clearTimeout(id);
  S.landingTimers = [];
}

/** Lande-Tick pro Würfel, passend zur Staffelung (nur aktuellster Wurf). */
function scheduleLandingTicks(rolled) {
  clearLandingTimers();
  if (reduceMotion()) {
    Sfx.tick(0);
    return;
  }
  const seq = ++S.rollSeq;
  const key = rolled.join(',');
  rolled.forEach((v, i) => {
    const ms = i * 70 + rollDur(i) * 1000 + 120;
    const id = setTimeout(() => {
      if (seq !== S.rollSeq) return;
      if (S.lastRolledKey !== key) return;
      if (v === 'W') Sfx.wormTick();
      else Sfx.tick(i);
    }, ms);
    S.landingTimers.push(id);
  });
}

/* Avatar-Verläufe (Hash aus Name). */
const AVATARS = [
  ['#5eead4', '#0f9d8a'], ['#93c5fd', '#2f62c4'], ['#fcd34d', '#c98a14'],
  ['#fda4af', '#d63a4a'], ['#c4b5fd', '#6d4fc2'], ['#86efac', '#16a34a'],
  ['#fdba74', '#e0611a'], ['#f0abfc', '#b43fc9'],
];

function avatarColors(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

function initials(name) {
  // Klammer-Zusätze wie „(hard)“ ignorieren, nur Buchstaben/Ziffern verwenden
  const clean = String(name).replace(/\(.*?\)/g, ' ');
  const words = clean.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (!words.length) return '?';
  const s = words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '');
  return s.toUpperCase();
}

function svgUse(href, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.appendChild(use);
  return svg;
}

function wormSvg(red = false) {
  return svgUse(red ? '#wormIconRed' : '#wormIconGreen');
}

function iconSvg(name) {
  return svgUse(`#i-${name}`, 'ic');
}

function avatarNode(p) {
  const av = document.createElement('span');
  av.className = 'avatar';
  const [a, b] = avatarColors(p.name);
  av.style.setProperty('--av-a', a);
  av.style.setProperty('--av-b', b);
  av.textContent = initials(p.name);
  if (p.isBot) {
    const bt = document.createElement('span');
    bt.className = 'bot';
    bt.appendChild(iconSvg('bot'));
    av.appendChild(bt);
  }
  return av;
}

// ---------- Sound (WebAudio-Synth, keine Assets) ----------
// Zurückhaltendes Sounddesign: nur Sinus/Dreieck, weiche Hüllkurven, Tiefpass + Kompressor am Master,
// Würfel klingen wie leises Holz-„Tok“, Karten wie ein Papier-Wisch, Hover kaum hörbar.

const Sfx = {
  ctx: null,
  master: null,
  noiseBuf: null,
  lastHover: 0,
  // 3 Stufen: 0 = aus, 1 = leise (40 %), 2 = an (100 %). Persistiert, migriert altes Mute-Flag.
  level: (() => {
    const v = Number(lsGet('heckmeck-volume'));
    if (v === 0 || v === 1 || v === 2) return v;
    return lsGet('heckmeck-muted') === '1' ? 0 : 2;
  })(),
  gainFor(l) { return [0, 0.4, 1][l] * 0.5; },
  setLevel(l) {
    this.level = l;
    lsSet('heckmeck-volume', String(l));
    if (this.master && this.ctx) this.master.gain.setValueAtTime(this.gainFor(l), this.ctx.currentTime);
  },
  ensure() {
    if (this.level === 0) return null;
    try {
      if (!this.ctx) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.ctx = ctx;
        this.master = ctx.createGain();
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 6500;
        lp.Q.value = 0.5;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -22;
        comp.ratio.value = 4;
        this.master.connect(lp).connect(comp).connect(ctx.destination);
        const len = ctx.sampleRate;
        this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      this.master.gain.setValueAtTime(this.gainFor(this.level), this.ctx.currentTime);
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  },
  /** Weicher Ton (Sinus/Dreieck), 8 ms Attack, exponentieller Ausklang. */
  tone(freq, dur = 0.1, type = 'sine', gain = 0.06, when = 0, slideTo = null) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const gn = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(gn).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  },
  /** Gefiltertes Rauschen (Papier, Holz-Anschlag). */
  noise(dur = 0.05, freq = 2000, gain = 0.04, when = 0, freqEnd = null, q = 0.9) {
    const ctx = this.ensure();
    if (!ctx || !this.noiseBuf) return;
    const t0 = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.01, dur / 3));
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(gn).connect(this.master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.03);
  },
  // --- Interface ---
  hover() { // kaum hörbares Tick, gedrosselt
    const now = performance.now();
    if (now - this.lastHover < 70) return;
    this.lastHover = now;
    this.tone(2100, 0.025, 'sine', 0.012);
    this.noise(0.02, 5200, 0.008);
  },
  click() { this.tone(540, 0.07, 'sine', 0.05, 0, 400); this.noise(0.02, 2800, 0.02); },
  open() { this.tone(420, 0.1, 'sine', 0.035, 0, 560); },
  close() { this.tone(560, 0.09, 'sine', 0.03, 0, 400); },
  copy() { this.tone(880, 0.08, 'sine', 0.035, 0.04); this.tone(1320, 0.1, 'sine', 0.025, 0.09); },
  // --- Würfel: leises Holz-Tok statt Rasseln ---
  rollStart() { this.noise(0.22, 700, 0.03, 0, 1700, 0.6); },
  tick(i) {
    const k = i % 5;
    const g = 0.07 * (0.85 + Math.random() * 0.3);
    this.tone(150 + k * 9, 0.07, 'sine', g, 0, 90);
    this.noise(0.03, 1900 - k * 110, 0.035);
  },
  wormTick() { this.tick(2); this.tone(880, 0.12, 'sine', 0.022, 0.03); },
  pick() { this.tone(660, 0.09, 'sine', 0.05); this.tone(990, 0.08, 'sine', 0.03, 0.05); },
  pickWorm() { this.tone(740, 0.1, 'sine', 0.055); this.tone(1109, 0.14, 'sine', 0.035, 0.06); },
  // --- Karten: Wisch beim Abflug, weiches Auflegen ---
  cardSlide() { this.noise(0.14, 1300, 0.03, 0, 3300, 0.7); },
  cardPlace() { this.tone(140, 0.07, 'sine', 0.06, 0, 100); this.noise(0.03, 900, 0.03); },
  deal(i = 0) { this.noise(0.07, 1800 + (i % 3) * 300, 0.02, 0, 3200, 0.8); },
  // --- Ereignisse ---
  take() { this.tone(523, 0.18, 'sine', 0.05); this.tone(659, 0.26, 'sine', 0.045, 0.09); },
  steal() { this.tone(784, 0.12, 'sine', 0.04, 0.05); this.tone(988, 0.2, 'sine', 0.04, 0.14); },
  bust() { this.tone(196, 0.42, 'sine', 0.07, 0, 120); this.noise(0.16, 260, 0.04, 0.02, null, 0.5); },
  win() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.32, 'sine', 0.05, i * 0.13)); },
  turn() { this.tone(880, 0.12, 'sine', 0.035); this.tone(1318, 0.16, 'sine', 0.02, 0.07); },
};

// ---------- Karten, Würfel, Stapel ----------

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
  return v === 'W' ? 'Wurm' : v;
}

/** Spielkarte: Eck-Indizes, große Zahl, Farbband mit Würmern (Farbe = Wurmzahl 1–4), Wasserzeichen. */
function cardNode(value, extra = '') {
  const n = wormsForTile(value);
  const d = document.createElement('div');
  d.className = `tile w${n}${extra ? ` ${extra}` : ''}`;
  d.dataset.value = value;
  const i1 = document.createElement('span');
  i1.className = 'idx';
  i1.textContent = value;
  const i2 = document.createElement('span');
  i2.className = 'idx br';
  i2.textContent = value;
  const v = document.createElement('span');
  v.className = 'v';
  v.textContent = value;
  const ww = document.createElement('span');
  ww.className = 'ww';
  for (let i = 0; i < n; i++) ww.appendChild(svgUse('#wormMono'));
  const wm = svgUse('#wormMono', 'wm');
  const tag = document.createElement('span');
  tag.className = 'target-tag';
  tag.textContent = 'Ziel';
  d.append(wm, i1, v, i2, ww, tag);
  return d;
}

/* Würfel: echter 3D-Würfel (Flächen 1–5 + Wurm). Endlage per Klasse vX,
 * Wurf-Tumble per WAAPI. Server-Werte bleiben maßgeblich. */
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8] };
const FIN = { 1: [0, 0], 2: [0, -180], 3: [0, -90], 4: [0, 90], 5: [-90, 0], W: [90, 0] };

function faceNode(v) {
  const f = document.createElement('span');
  f.className = `face f${v}`;
  if (v === 'W') {
    f.appendChild(wormSvg(false));
  } else {
    const grid = document.createElement('span');
    grid.className = 'pips';
    for (let i = 0; i < 9; i++) {
      const c = document.createElement('span');
      c.className = 'pip' + (PIPS[v].includes(i) ? ' on' : '');
      grid.appendChild(c);
    }
    f.appendChild(grid);
  }
  return f;
}

function renderDie(v, opts = {}) {
  const node = document.createElement(opts.button ? 'button' : 'div');
  if (opts.button) node.type = 'button';
  node.className = `die v${v}${opts.cls ? ` ${opts.cls}` : ''}`;
  node.dataset.v = v;
  if (opts.i !== undefined) node.style.setProperty('--i', opts.i);
  const tilt = document.createElement('span');
  tilt.className = 'tilt';
  const cube = document.createElement('span');
  cube.className = 'cube';
  for (const f of [1, 2, 3, 4, 5, 'W']) cube.appendChild(faceNode(f));
  tilt.appendChild(cube);
  node.appendChild(tilt);
  if (opts.pts) {
    const pts = document.createElement('i');
    pts.className = 'pts';
    pts.textContent = `+${opts.pts}`;
    node.appendChild(pts);
  }
  node.setAttribute('aria-label', v === 'W' ? 'Wurm (5 Punkte)' : `Würfel ${v}`);
  if (opts.title) node.title = opts.title;
  if (opts.onClick) node.addEventListener('click', opts.onClick);
  return node;
}

/** Wurf: Würfel wird von der Seite auf die Matte geworfen, springt zweimal und rollt auf den Serverwert aus. */
function tumbleDie(node, v, i) {
  if (reduceMotion() || !node.animate) return;
  const [fx, fy] = FIN[v];
  const dir = i % 2 ? 1 : -1;
  const sx = fx + dir * (360 * (1 + (i % 2)) + 90 * ((i * 7) % 3));
  const sy = fy - dir * (360 * (1 + ((i + 1) % 3)) + 90 * ((i * 5) % 3));
  const sz = dir * (180 + ((i * 53) % 90));
  const dur = rollDur(i) * 1000 + 220;
  const delay = i * 70;
  const fromX = (i % 2 ? 1 : -1) * (90 + ((i * 37) % 80));
  node.querySelector('.cube').animate(
    [
      { transform: `rotateX(${sx}deg) rotateY(${sy}deg) rotateZ(${sz}deg)` },
      { transform: `rotateX(${fx}deg) rotateY(${fy}deg) rotateZ(0deg)` },
    ],
    { duration: dur, delay, easing: 'cubic-bezier(.2,.7,.25,1)', fill: 'backwards' },
  );
  node.animate(
    [
      { transform: `translate(${fromX}px, -190px) scale(1.4) rotate(${dir * 25}deg)`, opacity: 0 },
      { opacity: 1, offset: 0.12 },
      { transform: `translate(${fromX * 0.12}px, 0) scale(1) rotate(${dir * -6}deg)`, offset: 0.52, easing: 'ease-out' },
      { transform: `translate(${fromX * -0.04}px, -30px) scale(1.04) rotate(${dir * 3}deg)`, offset: 0.68, easing: 'ease-in' },
      { transform: 'translate(0, 0) scale(1) rotate(0)', offset: 0.82, easing: 'ease-out' },
      { transform: 'translate(0, -9px) scale(1.01)', offset: 0.91, easing: 'ease-in' },
      { transform: 'translate(0, 0) scale(1)' },
    ],
    { duration: dur + 160, delay, easing: 'ease-in', fill: 'backwards' },
  );
}

/** Stapel mit Rücken-Layern, oberste Karte und Anzahl-Badge. */
function pileNode(stack) {
  const wrap = document.createElement('span');
  wrap.className = 'pile';
  const layers = Math.min(3, Math.max(0, stack.length - 1));
  for (let k = layers; k >= 1; k--) {
    const l = document.createElement('span');
    l.className = 'layer card-back';
    l.style.setProperty('--k', k);
    wrap.appendChild(l);
  }
  const m = document.createElement('span');
  if (stack.length === 0) {
    m.className = 'mini empty';
    m.textContent = '–';
  } else {
    const top = stack[stack.length - 1];
    m.className = `mini w${wormsForTile(top)}`;
    m.textContent = top;
  }
  wrap.appendChild(m);
  return wrap;
}

/** Eigene Hand: Karten als Fächer (rechts = oberste Karte). */
function fanNode(stack) {
  const fan = document.createElement('span');
  fan.className = 'fan';
  if (stack.length === 0) {
    fan.className = 'fan-empty';
    fan.textContent = 'Noch keine Karten';
    return fan;
  }
  fan.style.setProperty('--n', stack.length);
  stack.forEach((v, i) => {
    const m = document.createElement('span');
    m.className = `mini w${wormsForTile(v)}`;
    m.style.setProperty('--i', i);
    m.textContent = v;
    fan.appendChild(m);
  });
  return fan;
}

/** Oberste sichtbare Karte eines `.seat-stack` (Pile: einzige .mini, Fächer: letzte). */
function stackTopEl(stack) {
  if (!stack) return null;
  const minis = stack.querySelectorAll('.mini');
  return minis.length ? minis[minis.length - 1] : stack;
}

// ---------- Effekte (Konfetti / Funken) ----------

function sparksAt(x, y, color = 'var(--gold)', n = 14) {
  if (reduceMotion()) return;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    s.className = 'spark';
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.background = i % 3 === 0 ? '#fff' : color;
    document.body.appendChild(s);
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const d = 40 + Math.random() * 60;
    const an = s.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(0)`, opacity: 0 },
      ],
      { duration: 550 + Math.random() * 300, easing: 'cubic-bezier(.1,.7,.3,1)' },
    );
    an.onfinish = () => s.remove();
  }
}

function confetti() {
  if (reduceMotion()) return;
  const colors = ['#ffcf5a', '#3ddc97', '#ff6275', '#6aa8ff', '#f0abfc', '#ffffff'];
  for (let i = 0; i < 110; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = `${Math.random() * 100}vw`;
    c.style.top = '-20px';
    c.style.background = colors[i % colors.length];
    document.body.appendChild(c);
    const dx = (Math.random() - 0.5) * 240;
    const an = c.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx}px, ${window.innerHeight + 40}px) rotate(${Math.random() * 900 - 450}deg)`, opacity: 1 },
      ],
      { duration: 2200 + Math.random() * 1800, delay: Math.random() * 600, easing: 'cubic-bezier(.3,.2,.5,1)', fill: 'backwards' },
    );
    an.onfinish = () => c.remove();
  }
}

// ---------- Session ----------

function saveSession() {
  if (S.code && S.token) {
    lsSet(SESSION_KEY, JSON.stringify({ code: S.code, token: S.token, name: S.name }));
  }
}

function loadSession() {
  try {
    return JSON.parse(lsGet(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function clearSession() {
  lsDel(SESSION_KEY);
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
      Sfx.turn();
      break;
    case 'PLAYER_LEFT':
      feed(`${msg.name} hat die Verbindung verloren.`);
      break;
    case 'GAME_STARTED':
      S.overShown = false;
      S.grillKeys = null;
      S.wormCounts = {};
      feed('Spiel gestartet!');
      break;
    case 'TURN_STARTED':
      break;
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
      if (msg.flipped) S.pendingFlip = { value: msg.flipped, rect: grillTileRect(msg.flipped) };
      if (msg.returned) S.pendingFly = { kind: 'bust-return', value: msg.returned, fromRect: stackTopRect() };
      showBig('BUST!', 'bust');
      Sfx.bust();
      if (msg.returned) Sfx.cardSlide();
      shakeTable();
      bustFlash();
      showBanner(`Fehlwurf!${msg.returned ? ` ${msg.returned} zurückgelegt.` : ''}${msg.flipped ? ` ${msg.flipped} umgedreht.` : ''}`, 'bust', 3200);
      feed('Fehlwurf!');
      break;
    case 'TILE_TAKEN': {
      clearChoiceHighlight();
      S.lastFlipped = msg.value;
      const gm = S.state?.game;
      const takerId = gm?.players[gm.currentPlayer]?.id || null;
      const who = gm?.players[gm.currentPlayer]?.name || '';
      const isSteal = msg.type === 'steal';
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
      break;
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
  // Animation neu starten
  box.className = 'bigflash hidden';
  void box.offsetWidth;
  box.className = `bigflash k-${kind}`;
  clearTimeout(S.flashTimer);
  S.flashTimer = setTimeout(() => box.classList.add('hidden'), reduceMotion() ? 400 : ms);
}

function shakeTable() {
  if (reduceMotion()) return;
  const t = $('#stage');
  if (!t) return;
  t.classList.remove('shake');
  void t.offsetWidth;
  t.classList.add('shake');
}

function bustFlash() {
  const v = $('#bustVignette');
  if (!v) return;
  v.classList.remove('on');
  void v.offsetWidth;
  v.classList.add('on');
}

function grillTileRect(value) {
  const el = document.querySelector(`#grill .tile[data-value="${value}"]`);
  return el ? el.getBoundingClientRect() : null;
}

function stackTopRect(playerIdx) {
  const gm = S.state?.game;
  if (!gm) return null;
  const idx = playerIdx !== undefined ? playerIdx : gm.currentPlayer;
  const p = gm.players[idx];
  if (!p) return null;
  const stack = document.querySelector(`.seat-stack[data-pid="${p.id}"]`);
  if (stack) {
    return stackTopEl(stack).getBoundingClientRect();
  }
  return null;
}

/** Umgedrehte Grillkarte: Ghost dreht sich auf den Rücken und verschwindet (Server hat sie schon entfernt). */
function runPendingFlip() {
  const f = S.pendingFlip;
  S.pendingFlip = null;
  if (!f || !f.rect || reduceMotion()) return;
  const r = f.rect;
  if (document.querySelector(`#grill .tile[data-value="${f.value}"]`)) return; // blieb offen
  const ghost = document.createElement('div');
  ghost.className = 'flip-ghost';
  ghost.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;--cw:${r.width}px`;
  const inner = document.createElement('div');
  inner.className = 'inner';
  const front = cardNode(f.value);
  const back = document.createElement('div');
  back.className = 'back card-back';
  inner.append(front, back);
  ghost.appendChild(inner);
  document.body.appendChild(ghost);
  const an = inner.animate(
    [
      { transform: 'translateY(0) rotateY(0deg)' },
      { transform: 'translateY(-26px) rotateY(90deg)', offset: 0.4 },
      { transform: 'translateY(-10px) rotateY(180deg)', offset: 0.7 },
      { transform: 'translateY(40px) rotateY(180deg) scale(.8)', opacity: 0 },
    ],
    { duration: 1100, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' },
  );
  Sfx.cardSlide();
  an.onfinish = () => ghost.remove();
  setTimeout(() => ghost.remove(), 1400);
}

/** Fliegt einen Karten-Klon von der gemerkten Quelle zum neuen Ziel (nach STATE-Render). */
function runPendingFly() {
  const fly = S.pendingFly;
  S.pendingFly = null;
  if (!fly || !fly.fromRect || reduceMotion()) {
    if (fly) setTimeout(() => Sfx.cardPlace(), 150);
    return;
  }
  let target = null;
  if (fly.kind === 'take-grill' || fly.kind === 'steal') {
    const stack = fly.takerId ? document.querySelector(`.seat-stack[data-pid="${fly.takerId}"]`) : null;
    target = stack ? stackTopEl(stack) : null;
  } else if (fly.kind === 'bust-return') {
    target = document.querySelector(`#grill .tile[data-value="${fly.value}"]`);
  }
  if (!target) return;
  const to = target.getBoundingClientRect();
  if (to.width === 0 && to.height === 0) return;
  const from = fly.fromRect;
  const clone = cardNode(fly.value, 'fly-clone');
  clone.style.setProperty('--cw', `${from.width}px`);
  clone.style.left = `${from.left}px`;
  clone.style.top = `${from.top}px`;
  clone.style.width = `${from.width}px`;
  clone.style.height = `${from.height}px`;
  clone.style.aspectRatio = 'auto';
  document.body.appendChild(clone);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const sx = to.width / Math.max(1, from.width);
  const sy = to.height / Math.max(1, from.height);
  const anim = clone.animate(
    [
      { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 50}px) scale(${(1 + sx) / 2 + 0.15},${(1 + sy) / 2 + 0.15}) rotate(10deg)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx},${sy}) rotate(0deg)`, opacity: 0.95 },
    ],
    { duration: 700, easing: 'cubic-bezier(.2,.7,.3,1)' },
  );
  let landed = false;
  const land = () => {
    if (landed) return;
    landed = true;
    clone.remove();
    Sfx.cardPlace();
    sparksAt(to.left + to.width / 2, to.top + to.height / 2, fly.kind === 'steal' ? '#ff9d4a' : 'var(--gold)');
  };
  anim.onfinish = land;
  setTimeout(land, 900);
}

// Karten neigen sich zum Mauszeiger (Glanz folgt)
document.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const t = e.target.closest ? e.target.closest('.grill .tile, .hero-fan .tile') : null;
  if (!t) return;
  const r = t.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  t.style.setProperty('--tilt-y', `${(px - 0.5) * 18}deg`);
  t.style.setProperty('--tilt-x', `${-(py - 0.5) * 18}deg`);
  t.style.setProperty('--mx', `${px * 100}%`);
  t.style.setProperty('--my', `${py * 100}%`);
});
document.addEventListener('pointerout', (e) => {
  const t = e.target.closest ? e.target.closest('.grill .tile, .hero-fan .tile') : null;
  if (!t || t.contains(e.relatedTarget)) return;
  t.style.setProperty('--tilt-y', '0deg');
  t.style.setProperty('--tilt-x', '0deg');
});

// ---------- Screens ----------

function showScreen(id) {
  for (const s of ['screen-menu', 'screen-lobby', 'screen-game', 'screen-over']) {
    const el = $(`#${s}`);
    const show = s === id;
    if (show && el.classList.contains('hidden')) {
      // Einblend-Animation neu starten
      el.classList.remove('hidden');
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    } else {
      el.classList.toggle('hidden', !show);
    }
  }
  const inGame = id === 'screen-game';
  $('#btnLog').classList.toggle('hidden', !inGame);
  $('#dock').classList.toggle('hidden', !inGame);
  $('#btnLeaveGame').classList.toggle('hidden', !(inGame || id === 'screen-over'));
  if (!inGame) $('#logPanel').classList.add('hidden');
}

function updateRoomBadge() {
  const b = $('#roomBadge');
  if (S.code) {
    $('#roomBadgeText').textContent = S.code;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

async function copyCode(el) {
  if (!S.code) return;
  try {
    await navigator.clipboard.writeText(S.code);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = S.code;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(`Code ${S.code} kopiert`);
  Sfx.copy();
  el.classList.add('copied');
  setTimeout(() => el.classList.remove('copied'), 900);
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

let lobbyCodeShown = '';

function renderLobby(st) {
  const codeBtn = $('#lobbyCodeBtn');
  if (lobbyCodeShown !== st.code) {
    lobbyCodeShown = st.code;
    codeBtn.innerHTML = '';
    [...st.code].forEach((ch, i) => {
      const s = document.createElement('span');
      s.className = 'ch';
      s.style.setProperty('--i', i);
      s.textContent = ch;
      codeBtn.appendChild(s);
    });
  }
  const ul = $('#lobbyPlayers');
  ul.innerHTML = '';
  st.players.forEach((p, i) => {
    const li = document.createElement('li');
    li.style.animationDelay = `${i * 50}ms`;
    const strong = document.createElement('strong');
    strong.textContent = p.name + (p.id === S.playerId ? ' (Du)' : '');
    const sub = document.createElement('span');
    sub.className = 'sub' + (p.isBot || p.connected ? ' ready' : '');
    sub.textContent = p.isBot ? 'Bot' : (p.connected ? 'bereit' : 'weg');
    li.append(avatarNode(p), strong, sub);
    ul.appendChild(li);
  });
  if (st.players.length < 7) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.innerHTML = '<span class="waiting">Warte auf Mitspieler</span>';
    ul.appendChild(li);
  }
  requestAnimationFrame(moveSegThumb);
  $('#btnStart').disabled = st.players.length < 2;
  $('#lobbyHint').textContent = st.players.length < 2
    ? 'Mindestens 2 Spieler nötig (Bots zählen mit).'
    : `${st.players.length} Spieler – es kann losgehen!`;
}

// ---------- Spieltisch ----------

function myTurn(st) {
  return st.game && st.game.currentPlayerId === S.playerId;
}

function renderGame(st) {
  const mine = myTurn(st);
  renderSeats(st, mine);
  renderGrill(st.game);
  renderTurn(st, mine);
  markTargets(st.game, mine);
  renderPill(st, mine);
  $('#grillCount').textContent = `${st.game.grill.filter((t) => t.faceUp).length} offen`;
  runPendingFly();
  runPendingFlip();
  if (mine && !S.wasMine) {
    showBig('DU BIST DRAN', 'turn', 1100);
    Sfx.turn();
  }
  S.wasMine = mine;
}

function renderPill(st, mine) {
  const gm = st.game;
  const me = gm.players[gm.currentPlayer];
  const text = mine ? 'Du bist am Zug' : `${me.name} ist am Zug`;
  const pill = $('#turnPill');
  pill.classList.toggle('mine', mine);
  if (text === S.lastPillText) return;
  S.lastPillText = text;
  $('#turnPillText').textContent = text;
  pill.classList.remove('swap');
  void pill.offsetWidth;
  pill.classList.add('swap');
}

function panelNode(p, { active = false, you = false } = {}) {
  const el = document.createElement('div');
  el.className = 'ppanel' + (active ? ' active' : '');
  el.dataset.pid = p.id;

  const info = document.createElement('span');
  info.className = 'pinfo';
  const nm = document.createElement('span');
  nm.className = 'pname';
  nm.textContent = p.name.replace(/\s*\((easy|normal|hard)\)\s*$/i, '');
  nm.title = p.name;
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
  wc.className = 'wcount';
  const count = playerWorms(p.stack);
  wc.textContent = count;
  if (S.wormCounts[p.id] !== undefined && count > S.wormCounts[p.id]) wc.classList.add('bump');
  S.wormCounts[p.id] = count;
  w.appendChild(wc);
  if (active) {
    const at = document.createElement('span');
    at.className = 'turn-tag';
    at.textContent = ' · am Zug';
    w.appendChild(at);
  }
  info.append(nm, w);

  const stack = document.createElement('span');
  stack.className = 'seat-stack';
  stack.dataset.pid = p.id;
  stack.appendChild(you ? fanNode(p.stack) : pileNode(p.stack));
  if (!you && p.stack.length > 0) {
    const b = document.createElement('span');
    b.className = 'count-badge';
    b.textContent = p.stack.length;
    stack.appendChild(b);
  }

  if (you) stack.classList.add('is-fan');
  el.append(avatarNode(p), info, stack);
  return el;
}

function renderSeats(st) {
  const players = st.game.players;
  const currentId = st.game.currentPlayerId;
  const meIdx = players.findIndex((p) => p.id === S.playerId);
  const me = meIdx >= 0 ? players[meIdx] : null;
  // Gegner in Zugreihenfolge relativ zu mir
  const opps = [];
  for (let k = 1; k < players.length + (me ? 0 : 1); k++) {
    const p = players[((me ? meIdx : -1) + k + players.length) % players.length];
    if (p && p !== me) opps.push(p);
  }

  const oppsBox = $('#opps');
  oppsBox.innerHTML = '';
  opps.forEach((p, i) => {
    const el = panelNode(p, { active: p.id === currentId });
    el.style.animationDelay = `${i * 60}ms`;
    oppsBox.appendChild(el);
  });

  const dock = $('#seatME');
  dock.innerHTML = '';
  if (me) dock.appendChild(panelNode(me, { active: me.id === currentId, you: true }));
  highlightChoice();
}

function renderGrill(gm) {
  const el = $('#grill');
  el.innerHTML = '';
  const prev = S.grillKeys;
  const next = new Set();
  let dealt = 0;
  for (const t of gm.grill) {
    if (!t.faceUp) continue;
    next.add(t.value);
    const isNew = !prev || !prev.has(t.value);
    const d = cardNode(t.value, isNew ? 'new' : '');
    if (isNew) {
      d.style.setProperty('--deal', `${prev ? 0 : dealt * 45}ms`);
      if (!prev && dealt % 3 === 0) setTimeout(() => Sfx.deal(dealt), dealt * 45);
    }
    dealt++;
    el.appendChild(d);
  }
  if (S.lastFlipped !== null && S.lastFlipped !== undefined) {
    const hit = el.querySelector(`.tile[data-value="${S.lastFlipped}"]`);
    if (hit) { hit.classList.remove('new'); hit.classList.add('flash'); }
    S.lastFlipped = null;
  }
  S.grillKeys = next;
  highlightChoice();
}

/** Zeigt, welche Karte der Spieler beim Beenden jetzt bekäme (reine Anzeige). */
function markTargets(gm, mine) {
  document.querySelectorAll('.tile.target').forEach((e) => e.classList.remove('target'));
  document.querySelectorAll('.seat-stack.target-steal').forEach((e) => e.classList.remove('target-steal'));
  if (!mine || gm.turn.picked.length === 0 || !gm.turn.hasWorm) return;
  const score = gm.turn.score;
  const open = gm.grill.filter((t) => t.faceUp);
  let marked = false;
  const exact = open.find((t) => t.value === score);
  if (exact) {
    $(`#grill .tile[data-value="${exact.value}"]`)?.classList.add('target');
    marked = true;
  }
  gm.players.forEach((p, i) => {
    if (i !== gm.currentPlayer && p.stack[p.stack.length - 1] === score) {
      document.querySelector(`.seat-stack[data-pid="${p.id}"]`)?.classList.add('target-steal');
      marked = true;
    }
  });
  if (!marked) {
    const lower = open.filter((t) => t.value < score).sort((a, b) => b.value - a.value)[0];
    if (lower) $(`#grill .tile[data-value="${lower.value}"]`)?.classList.add('target');
  }
}

/** Spiegel von game.canTake aus dem STATE (nur Anzeige). */
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

function setScore(n) {
  const el = $('#scoreLine');
  if (n === S.shownScore) { el.textContent = n; return; }
  const from = S.shownScore;
  S.shownScore = n;
  cancelAnimationFrame(S.scoreRaf);
  if (reduceMotion() || n < from) { el.textContent = n; return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 450);
    el.textContent = Math.round(from + (n - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) S.scoreRaf = requestAnimationFrame(step);
  };
  S.scoreRaf = requestAnimationFrame(step);
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

/** Punkteleiste 21–36: offene Grillkarten leuchten in Wurmfarbe, Marker zeigt die aktuelle Punktzahl. */
function renderScoreTrack(gm, mine) {
  const tr = $('#scoreTrack');
  if (!tr) return;
  if (!tr.firstChild) {
    for (let v = 21; v <= 36; v++) {
      const c = document.createElement('span');
      c.className = `st-cell t${wormsForTile(v)}`;
      c.dataset.v = v;
      c.textContent = v;
      tr.appendChild(c);
    }
    const mk = document.createElement('span');
    mk.className = 'st-marker off';
    mk.id = 'stMarker';
    tr.appendChild(mk);
  }
  const open = new Set(gm.grill.filter((t) => t.faceUp).map((t) => t.value));
  const score = gm.turn.score;
  tr.querySelectorAll('.st-cell').forEach((c) => {
    const v = Number(c.dataset.v);
    c.classList.toggle('open', open.has(v));
    c.classList.toggle('taken', !open.has(v));
    c.classList.toggle('reach', mine && gm.turn.hasWorm && score === v && open.has(v));
  });
  const mk = $('#stMarker');
  if (score <= 0) { mk.classList.add('off'); return; }
  mk.classList.remove('off');
  mk.classList.toggle('below', score < 21);
  const idx = Math.min(15, Math.max(0, score - 21));
  const cellW = tr.querySelector('.st-cell').getBoundingClientRect().width;
  mk.style.width = `${cellW}px`;
  mk.style.transform = `translateX(${idx * (cellW + 3)}px)`;
}

function renderTurn(st, mine) {
  const gm = st.game;
  const me = gm.players[gm.currentPlayer];
  const table = $('#diceTable');
  table.classList.toggle('mine', mine);
  $('#turnTitle').textContent = mine ? 'Du bist am Zug' : `Am Zug: ${me.name}`;
  setScore(gm.turn.score);

  const wl = $('#wormLine');
  wl.innerHTML = '';
  wl.appendChild(wormSvg(false));
  const wt = document.createElement('span');
  if (gm.turn.hasWorm) {
    wt.textContent = 'Wurm gesichert';
    wl.className = 'worm-line ok';
  } else {
    wt.textContent = 'Noch kein Wurm';
    wl.className = 'worm-line missing';
  }
  wl.appendChild(wt);

  // Bust-Risiko (gleiche Formel wie die Bots): (gewählte Werte / 6) ^ Restwürfel
  const p = gm.turn.picked.length;
  const rest = gm.turn.remaining;
  let risk = null;
  if (p > 0 && rest > 0) risk = Math.pow(p / 6, rest) * 100;
  $('#riskFill').style.width = risk === null ? '0%' : `${Math.min(100, Math.max(4, risk))}%`;
  $('#riskText').textContent = risk === null ? '–' : risk < 1 ? '<1 %' : `${Math.round(risk)} %`;

  const rd = $('#rolledDice');
  rd.innerHTML = '';
  const canChoose = mine && gm.turn.phase === 'pick';
  const rolledKey = gm.turn.rolled.join(',');
  const animate = rolledKey !== S.lastRolledKey && gm.turn.rolled.length > 0;
  S.lastRolledKey = rolledKey;
  table.classList.remove('throwing');
  if (gm.turn.rolled.length === 0) rd.innerHTML = '<span class="empty-note">···</span>';
  gm.turn.rolled.forEach((v, i) => {
    const ok = gm.turn.validPicks.includes(v);
    let node;
    if (canChoose && ok) {
      const cnt = gm.turn.rolled.filter((x) => x === v).length;
      node = renderDie(v, { button: true, i, cls: 'pickable', pts: cnt * (v === 'W' ? 5 : v), title: `${dieLabel(v)} wählen (alle ${cnt}× beiseite)`, onClick: () => send({ t: 'pick', value: v }) });
    } else {
      node = renderDie(v, { i, cls: canChoose && !ok ? 'locked' : '', title: dieLabel(v) });
    }
    rd.appendChild(node);
    if (animate) tumbleDie(node, v, i);
  });

  const sa = $('#setAside');
  sa.innerHTML = '';
  const entries = Object.entries(gm.turn.setAside);
  const saKey = JSON.stringify(gm.turn.setAside);
  const saChanged = saKey !== S.setAsideKey;
  S.setAsideKey = saKey;
  if (entries.length === 0) sa.innerHTML = '<span class="empty-note">···</span>';
  for (const [v, n] of entries) {
    const grp = document.createElement('div');
    grp.className = 'set-group' + (saChanged ? ' new' : '');
    for (let i = 0; i < n; i++) grp.appendChild(renderDie(v, { cls: 'locked-still' }));
    const lab = document.createElement('span');
    lab.className = 'n';
    lab.textContent = `${n}×`;
    grp.appendChild(lab);
    sa.appendChild(grp);
  }

  renderScoreTrack(gm, mine);
  $('#dock').classList.toggle('mine', mine);
  $('#btnRoll').disabled = !(mine && gm.turn.phase === 'roll' && gm.turn.remaining > 0);
  const ready = takeReadiness(gm.turn, gm.grill, gm.players, gm.currentPlayer);
  const forced = gm.turn.phase === 'take';
  const takeAllowed = mine && (gm.turn.phase === 'roll' || forced)
    && gm.turn.picked.length > 0 && (ready.ok || forced);
  const btnTake = $('#btnTake');
  btnTake.disabled = !takeAllowed;
  $('#takeLabel').textContent = gm.turn.picked.length > 0 ? `Nehmen (${gm.turn.score})` : 'Nehmen';
  btnTake.title = (mine && gm.turn.picked.length > 0 && !ready.ok && !forced) ? ready.reason : '';

  const hint = $('#diceHint');
  hint.textContent = !mine
    ? `${me.name} spielt …`
    : gm.turn.phase === 'pick'
      ? 'Wähle einen leuchtenden Würfel'
      : gm.turn.picked.length === 0
        ? 'Würfle, um zu starten'
        : ready.ok || forced
          ? 'Weiterwürfeln oder Karte nehmen'
          : ready.reason;
}

// ---------- Spielende ----------

function renderOver(st) {
  const gm = st.game;
  const winner = gm.ranking.find((r) => r.playerIndex === gm.winner);
  $('#overTitle').textContent = winner ? `${winner.name} gewinnt!` : 'Spielende';
  if (!S.overShown) {
    S.overShown = true;
    showBig('GEWONNEN!', 'win', 1800);
    Sfx.win();
    confetti();
  }
  const pod = $('#podium');
  pod.innerHTML = '';
  const order = [1, 0, 2].filter((i) => gm.ranking[i]);
  for (const i of order) {
    const r = gm.ranking[i];
    const pl = gm.players[r.playerIndex];
    const el = document.createElement('div');
    el.className = `pod p${i + 1}`;
    el.style.setProperty('--d', `${(2 - i) * 220}ms`);
    if (i === 0) {
      const c = iconSvg('crown');
      c.setAttribute('class', 'ic crown');
      el.appendChild(c);
    }
    el.appendChild(avatarNode({ name: r.name, isBot: pl?.isBot }));
    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = r.name;
    const wm = document.createElement('span');
    wm.className = 'worms';
    wm.append(wormSvg(false), document.createTextNode(String(r.worms)));
    const blk = document.createElement('div');
    blk.className = 'block';
    blk.textContent = i + 1;
    el.append(nm, wm, blk);
    pod.appendChild(el);
  }
  const ol = $('#rankingList');
  ol.innerHTML = '';
  gm.ranking.forEach((r, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', i);
    if (i === 0) li.className = 'winner';
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = `${i + 1}.`;
    const mid = document.createElement('div');
    const nm = document.createElement('strong');
    nm.textContent = r.name;
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    const stack = gm.players[r.playerIndex]?.stack || [];
    for (const v of stack) {
      const m = document.createElement('span');
      m.className = `mini w${wormsForTile(v)}`;
      m.textContent = v;
      tiles.appendChild(m);
    }
    if (!stack.length) tiles.textContent = 'keine Karten';
    mid.append(nm, tiles);
    const sc = document.createElement('span');
    sc.className = 'score';
    sc.append(wormSvg(false), document.createTextNode(String(r.worms)));
    li.append(pos, mid, sc);
    ol.appendChild(li);
  });
}

// ---------- Banner / Toast / Feed / Choice ----------

function showBanner(text, kind, ms = 2500) {
  const b = $('#banner');
  b.textContent = text;
  b.className = 'banner hidden';
  void b.offsetWidth;
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
  while (ul.children.length > 14) ul.lastChild.remove();
}

function openChoice(score, options) {
  S.pendingChoice = options;
  $('#choiceText').textContent = `Mit ${score} Punkten passt es auf Grill und Gegnerstapel:`;
  const box = $('#choiceBtns');
  box.innerHTML = '';
  const players = S.state?.game?.players || [];
  for (const o of options) {
    const btn = document.createElement('button');
    btn.className = o.source === 'grill' ? 'btn primary big' : 'btn gold big';
    if (o.source === 'grill') {
      btn.append(iconSvg('flame'), document.createTextNode(`Vom Grill: ${o.value}`));
      btn.addEventListener('click', () => {
        send({ t: 'take', choice: { source: 'grill' } });
        closeChoice();
      });
    } else {
      const fromName = players[o.fromPlayer]?.name || 'Gegner';
      btn.append(iconSvg('swap'), document.createTextNode(`Von ${fromName} stehlen: ${o.value}`));
      btn.addEventListener('click', () => {
        send({ t: 'take', choice: { source: 'steal', fromPlayer: o.fromPlayer } });
        closeChoice();
      });
    }
    box.appendChild(btn);
  }
  $('#choiceOverlay').classList.remove('hidden');
  Sfx.open();
  const panel = $('#grillPanel');
  if (panel) panel.classList.add('choosing');
  highlightChoice();
}

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
  lsSet('heckmeck-name', n);
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
  S.pendingChoice = null;
  S.lastFlipped = null;
  S.pendingFly = null;
  S.pendingFlip = null;
  S.wasMine = false;
  S.overShown = false;
  S.lastPillText = '';
  S.grillKeys = null;
  S.setAsideKey = '';
  S.wormCounts = {};
  S.shownScore = 0;
  lobbyCodeShown = '';
  clearLandingTimers();
  S.rollSeq++;
  clearTimeout(S.throwTimer);
  closeChoice();
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

function doRoll() {
  if ($('#btnRoll').disabled) return;
  Sfx.rollStart();
  const t = $('#diceTable');
  t.classList.add('throwing');
  clearTimeout(S.throwTimer);
  S.throwTimer = setTimeout(() => t.classList.remove('throwing'), 900);
  send({ t: 'roll' });
}

function doTake() {
  if ($('#btnTake').disabled) return;
  send({ t: 'take' });
}

$('#btnCreate').addEventListener('click', () => {
  connect(() => send({ t: 'create', name: playerName() }));
});
$('#btnJoin').addEventListener('click', () => {
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!code) {
    toast('Bitte Raumcode eingeben.');
    $('#codeInput').focus();
    return;
  }
  S.name = playerName();
  connect(() => send({ t: 'join', code, name: S.name }));
});
$('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });
$('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnCreate').click(); });
$('#btnResume').addEventListener('click', () => {
  const sess = loadSession();
  if (!sess) return;
  S.name = sess.name;
  connect(() => send({ t: 'rejoin', code: sess.code, token: sess.token }));
});
$('#btnAddBot').addEventListener('click', () => {
  send({ t: 'addBot', difficulty: S.botDiff });
});
$('#botDifficulty').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-diff]');
  if (!b) return;
  S.botDiff = b.dataset.diff;
  $('#botDifficulty').querySelectorAll('button').forEach((x) => {
    const on = x === b;
    x.classList.toggle('on', on);
    x.setAttribute('aria-checked', String(on));
  });
  moveSegThumb();
  Sfx.click();
});
$('#btnStart').addEventListener('click', () => send({ t: 'start' }));
$('#btnLeaveLobby').addEventListener('click', leaveToMenu);
$('#btnLeaveGame').addEventListener('click', leaveToMenu);
$('#btnRoll').addEventListener('click', doRoll);
$('#btnTake').addEventListener('click', doTake);
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
  setConnected(true);
  leaveToMenu();
  setConnected(false);
});
$('#roomBadge').addEventListener('click', (e) => copyCode(e.currentTarget));
$('#lobbyCodeBtn').addEventListener('click', (e) => copyCode(e.currentTarget));
$('#btnTheme').addEventListener('click', cycleTheme);
$('#btnLog').addEventListener('click', () => $('#logPanel').classList.toggle('hidden'));
$('#btnHelp').addEventListener('click', () => { $('#helpOverlay').classList.remove('hidden'); Sfx.open(); });
$('#btnHelpClose').addEventListener('click', () => { $('#helpOverlay').classList.add('hidden'); Sfx.close(); });
$('#helpOverlay').addEventListener('click', (e) => { if (e.target.id === 'helpOverlay') $('#helpOverlay').classList.add('hidden'); });

// Tastatur: Leertaste würfeln, Enter nehmen, 1–5/W Wert wählen, Esc schließt
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#helpOverlay').classList.add('hidden');
    $('#logPanel').classList.add('hidden');
    return;
  }
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.ctrlKey || e.metaKey || e.altKey) return;
  const st = S.state;
  if (!st || !st.game || st.status !== 'playing' || st.game.over || !myTurn(st)) return;
  if (!$('#choiceOverlay').classList.contains('hidden') || !$('#helpOverlay').classList.contains('hidden')) return;
  if (e.key === ' ' && tag !== 'button') { e.preventDefault(); doRoll(); return; }
  if (e.key === 'Enter' && tag !== 'button') { e.preventDefault(); doTake(); return; }
  const k = e.key.toUpperCase();
  if (st.game.turn.phase === 'pick' && /^[1-5W]$/.test(k)) {
    const v = k === 'W' ? 'W' : Number(k);
    if (st.game.turn.validPicks.includes(v)) send({ t: 'pick', value: v });
  }
});

// ---------- Interaktions-Sounds (leise, delegiert) ----------

const HOVER_SEL = '.btn:not(:disabled), .icon-btn, .chip, .die.pickable, .grill .tile, .seg button, .code-cards, .hero-fan .tile';
let lastHoverEl = null;
document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const t = e.target.closest ? e.target.closest(HOVER_SEL) : null;
  if (!t || t === lastHoverEl) return;
  lastHoverEl = t;
  Sfx.hover();
});
document.addEventListener('pointerout', (e) => {
  if (lastHoverEl && !lastHoverEl.contains(e.relatedTarget)) lastHoverEl = null;
});
document.addEventListener('pointerdown', (e) => {
  const t = e.target.closest ? e.target.closest('.btn:not(:disabled), .icon-btn:not(#btnSound), .chip') : null;
  if (t) Sfx.click();
});

// ---------- Interaktionen: Spotlight, Ripple, Segment-Slider ----------

document.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const t = e.target.closest ? e.target.closest('.btn, .ppanel, .menu-panel, .seat-list li') : null;
  if (!t) return;
  const r = t.getBoundingClientRect();
  t.style.setProperty('--px', `${e.clientX - r.left}px`);
  t.style.setProperty('--py', `${e.clientY - r.top}px`);
});

document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest ? e.target.closest('.btn:not(:disabled)') : null;
  if (!b || reduceMotion()) return;
  const r = b.getBoundingClientRect();
  const d = Math.max(r.width, r.height) * 2.2;
  const rp = document.createElement('i');
  rp.className = 'ripple';
  rp.style.cssText = `left:${e.clientX - r.left}px;top:${e.clientY - r.top}px;width:${d}px;height:${d}px`;
  b.appendChild(rp);
  setTimeout(() => rp.remove(), 750);
});

function moveSegThumb() {
  const seg = $('#botDifficulty');
  const on = seg && seg.querySelector('button.on');
  const th = seg && seg.querySelector('.seg-thumb');
  if (!on || !th || !on.offsetWidth) return;
  th.style.width = `${on.offsetWidth}px`;
  th.style.transform = `translateX(${on.offsetLeft}px)`;
}
window.addEventListener('resize', moveSegThumb);

// ---------- Start ----------

const SOUND_ICONS = ['#i-vol0', '#i-vol1', '#i-vol2'];
const SOUND_LABELS = ['Sound aus', 'Sound leise', 'Sound an'];
function refreshSoundBtn() {
  const b = $('#btnSound');
  if (!b) return;
  b.querySelector('use').setAttribute('href', SOUND_ICONS[Sfx.level]);
  b.setAttribute('aria-label', `${SOUND_LABELS[Sfx.level]} – klicken zum Wechseln`);
}
$('#btnSound').addEventListener('click', () => {
  Sfx.setLevel((Sfx.level + 2) % 3);
  refreshSoundBtn();
  if (Sfx.level > 0) Sfx.click();
});
document.addEventListener('pointerdown', () => Sfx.ensure(), { once: true });

/** Menü: Kartenfächer über dem Titel + schwebende Karten und drehende Würfel im Hintergrund. */
function buildHeroDecor() {
  const fan = $('#heroFan');
  if (fan) {
    [21, 25, 29, 33, 36].forEach((v, i) => {
      const c = cardNode(v);
      c.style.setProperty('--i', i);
      c.style.setProperty('--cw', 'clamp(62px, 17vw, 82px)');
      fan.appendChild(c);
    });
  }
  const box = $('#heroDecor');
  if (!box) return;
  const items = [
    { k: 'card', v: 24, x: 5, y: 12, r: -14, d: 9 },
    { k: 'card', v: 31, x: 84, y: 9, r: 12, d: 11 },
    { k: 'card', v: 27, x: 12, y: 64, r: 9, d: 10 },
    { k: 'card', v: 35, x: 88, y: 60, r: -9, d: 12 },
    { k: 'die', v: 'W', x: 22, y: 34, d: 8, sp: 16 },
    { k: 'die', v: 5, x: 76, y: 34, d: 10, sp: 13 },
    { k: 'die', v: 3, x: 70, y: 82, d: 9, sp: 18 },
    { k: 'die', v: 'W', x: 28, y: 84, d: 11, sp: 15 },
  ];
  items.forEach((it, i) => {
    const w = document.createElement('div');
    w.className = 'deco';
    w.style.left = `${it.x}%`;
    w.style.top = `${it.y}%`;
    w.style.setProperty('--dur', `${it.d}s`);
    w.style.setProperty('--del', `${-i * 1.3}s`);
    w.style.setProperty('--r0', `${(it.r || 0) - 6}deg`);
    w.style.setProperty('--r1', `${(it.r || 0) + 8}deg`);
    if (it.k === 'card') {
      const c = cardNode(it.v);
      c.style.setProperty('--cw', '78px');
      w.appendChild(c);
    } else {
      const d = renderDie(it.v, { cls: 'spin' });
      d.style.setProperty('--s', '58px');
      d.style.setProperty('--spin', `${it.sp}s`);
      w.appendChild(d);
    }
    box.appendChild(w);
  });
}

applyTheme(getTheme());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (getTheme() === 'auto') applyTheme('auto'); });
$('#nameInput').value = lsGet('heckmeck-name') || '';
buildHeroDecor();
refreshResume();
refreshSoundBtn();
connect();
showScreen('screen-menu');
