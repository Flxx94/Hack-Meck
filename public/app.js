'use strict';

/* Hack-Meck Client (Phase 7).
 * Rendert ausschließlich den Server-State (STATE-Nachrichten).
 * Verbindung: WebSocket auf gleichem Host/Port (LAN-fähig, kein hardcoded Host).
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
  state: null, // letzte STATE-Nachricht
  lastRolledKey: '',
  retryTimer: null,
  bannerTimer: null,
};

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
      feed('Spiel gestartet!');
      break;
    case 'TURN_STARTED':
      break; // STATE danach zeichnet um
    case 'DICE_ROLLED':
      feed(`Gewürfelt: ${msg.rolled.map(dieLabel).join(' ')}`);
      break;
    case 'DICE_SELECTED':
      feed(`Gewählt: ${msg.count}× ${dieLabel(msg.picked)} (+${msg.score} Punkte)`);
      break;
    case 'BUST':
      showBanner(`💥 Fehlwurf!${msg.returned ? ` ${msg.returned} zurückgelegt.` : ''}${msg.flipped ? ` ${msg.flipped} umgedreht.` : ''}`, 'bust', 3200);
      feed('Fehlwurf!');
      break;
    case 'TILE_TAKEN': {
      const who = S.state?.game?.players[S.state.game.currentPlayer]?.name || '';
      const what = msg.type === 'steal' ? `stiehlt ${msg.value}` : `nimmt ${msg.value}`;
      showBanner(`${who} ${what}!`, 'take', 2200);
      feed(`${who} ${what}.`);
      flashTile(msg.value);
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

// ---------- Spiel ----------

function myTurn(st) {
  return st.game && st.game.currentPlayerId === S.playerId;
}

function renderGame(st) {
  const gm = st.game;
  renderPlayerBar(st);
  renderGrill(gm);
  renderTurn(st);
  renderStacks(st);
}

function renderPlayerBar(st) {
  const bar = $('#playerBar');
  bar.innerHTML = '';
  for (const p of st.game.players) {
    const top = p.stack[p.stack.length - 1];
    const chip = document.createElement('div');
    chip.className = 'player-chip'
      + (p.id === st.game.currentPlayerId ? ' active' : '')
      + (p.id === S.playerId ? ' me' : '');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = `${p.isBot ? '🤖' : '🟢'} ${p.name}`;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `🐛 ${playerWorms(p.stack)} · oben: ${top !== undefined ? top : '–'}`;
    chip.append(nm, sub);
    bar.appendChild(chip);
  }
}

function renderGrill(gm) {
  const el = $('#grill');
  el.innerHTML = '';
  for (const t of gm.grill) {
    const d = document.createElement('div');
    d.className = 'tile' + (t.faceUp ? '' : ' taken');
    d.dataset.value = t.value;
    d.innerHTML = `<span class="v">${t.value}</span><span class="w">${'🐛'.repeat(t.worms)}</span>`;
    el.appendChild(d);
  }
}

function renderTurn(st) {
  const gm = st.game;
  const me = gm.players[gm.currentPlayer];
  const mine = myTurn(st);
  $('#turnTitle').textContent = mine ? 'Du bist am Zug!' : `Am Zug: ${me.name}`;
  const score = gm.turn.score;
  $('#scoreLine').textContent = `Punkte: ${score}`;
  const wl = $('#wormLine');
  if (gm.turn.hasWorm) {
    wl.textContent = '🪱 Wurm gesichert';
    wl.className = 'worm-line ok';
  } else {
    wl.textContent = 'Kein Wurm – Beenden wäre Fehlwurf';
    wl.className = 'worm-line missing';
  }

  // Geworfene Würfel (klickbar, wenn ich wählen darf).
  const rd = $('#rolledDice');
  rd.innerHTML = '';
  const canChoose = mine && gm.turn.phase === 'pick';
  const rolledKey = gm.turn.rolled.join(',');
  const animate = rolledKey !== S.lastRolledKey && gm.turn.rolled.length > 0;
  S.lastRolledKey = rolledKey;
  if (gm.turn.rolled.length === 0) {
    rd.innerHTML = '<span class="empty-note">—</span>';
  }
  gm.turn.rolled.forEach((v, i) => {
    const ok = gm.turn.validPicks.includes(v);
    let node;
    if (canChoose && ok) {
      node = document.createElement('button');
      node.className = 'die pickable';
      node.addEventListener('click', () => send({ t: 'pick', value: v }));
    } else {
      node = document.createElement('div');
      node.className = 'die' + (canChoose && !ok ? ' locked' : '');
    }
    if (animate) {
      node.classList.add('just-rolled');
      node.style.animationDelay = `${i * 60}ms`;
    }
    node.textContent = dieLabel(v);
    node.title = ok ? `Wert ${dieLabel(v)} wählen` : dieLabel(v);
    rd.appendChild(node);
  });

  // Beiseitegelegt, gruppiert mit Punkten.
  const sa = $('#setAside');
  sa.innerHTML = '';
  const entries = Object.entries(gm.turn.setAside);
  if (entries.length === 0) sa.innerHTML = '<span class="empty-note">—</span>';
  for (const [v, n] of entries) {
    const grp = document.createElement('div');
    grp.className = 'set-group';
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'die locked';
      d.textContent = dieLabel(v);
      grp.appendChild(d);
    }
    const lab = document.createElement('span');
    lab.className = 'n';
    lab.textContent = `${n}× ${dieLabel(v)}`;
    grp.appendChild(lab);
    sa.appendChild(grp);
  }

  $('#btnRoll').disabled = !(mine && gm.turn.phase === 'roll' && gm.turn.remaining > 0);
  $('#btnTake').disabled = !(mine && (gm.turn.phase === 'roll' || gm.turn.phase === 'take') && gm.turn.picked.length > 0);
  $('#btnTake').textContent = gm.turn.picked.length > 0 ? `Nehmen / Beenden (${score})` : 'Nehmen / Beenden';
}

function renderStacks(st) {
  const el = $('#stacks');
  el.innerHTML = '';
  for (const p of st.game.players) {
    const row = document.createElement('div');
    row.className = 'stack-row';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${p.name} (🐛 ${playerWorms(p.stack)})`;
    row.appendChild(who);
    if (p.stack.length === 0) {
      const none = document.createElement('span');
      none.className = 'empty-note';
      none.textContent = '–';
      row.appendChild(none);
    }
    p.stack.forEach((v, i) => {
      const m = document.createElement('span');
      m.className = 'mini-tile' + (i === p.stack.length - 1 ? ' top' : '');
      m.textContent = v;
      row.appendChild(m);
    });
    el.appendChild(row);
  }
}

// ---------- Spielende ----------

function renderOver(st) {
  const gm = st.game;
  const winner = gm.ranking.find((r) => r.playerIndex === gm.winner);
  $('#overTitle').textContent = winner ? `🏆 ${winner.name} gewinnt!` : 'Spielende';
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

function flashTile(value) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.tile[data-value="${value}"]`);
    if (el) el.classList.add('flash');
  });
}

function openChoice(score, options) {
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
}

function closeChoice() {
  $('#choiceOverlay').classList.add('hidden');
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
$('#btnRoll').addEventListener('click', () => send({ t: 'roll' }));
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

$('#nameInput').value = localStorage.getItem('heckmeck-name') || '';
refreshResume();
connect();
showScreen('screen-menu');
