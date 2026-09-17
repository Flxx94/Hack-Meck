'use strict';

/**
 * Phase 8 – Integrationstests: vollständige Spiele über WebSocket.
 * Zwei menschliche Clients spielen ein ganzes Spiel bis GAME_OVER
 * (inkl. NEED_CHOICE-Beantwortung, Steals, BUSTs). Danach wird die
 * Schlusswertung auf Regelkonsistenz geprüft.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createHeckMeckServer } = require('../server');

let srv;
let port;

before(async () => {
  srv = createHeckMeckServer(0, '127.0.0.1');
  const addr = await srv.listen();
  port = addr.port;
});

after(async () => {
  await srv.close();
});

function makeClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [];
  // Sequenznummer pro Nachricht: splice-sicher (Queue-Indizes verschieben sich!).
  let seq = 0;
  const client = {
    ws,
    queue,
    mark: () => seq,
  };
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      msg.__seq = seq++;
      queue.push(msg);
    } catch { /* ignore */ }
  });
  return Object.assign(client, {
    send: (obj) => ws.send(JSON.stringify(obj)),
    // pred erhält (Nachricht, Queue-Index) – so lassen sich alte Nachrichten
    // aus früheren Zügen ausblenden (Frische-Disziplin, siehe mark/waits).
    waitFor(t, timeout = 5000, pred) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeout;
        (function poll() {
          const i = queue.findIndex((m, idx) => m.t === t && (!pred || pred(m, idx)));
          if (i >= 0) return resolve(queue.splice(i, 1)[0]);
          if (Date.now() > deadline) {
            return reject(new Error(`Timeout: wartete auf ${t} (warteschlange: ${queue.map((m) => m.t).join(',')})`));
          }
          setTimeout(poll, 10);
        })();
      });
    },
    // Ein Waiter für mehrere Typen: verhindert, dass verwaiste Promise.race-
    // Verlierer sich später eintreffende Nachrichten wegschnappen.
    // Frische via Sequenznummer (__seq), nicht Queue-Index (splice-sicher).
    waitAny(types, timeout = 5000, base = 0, pred) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeout;
        (function poll() {
          const i = queue.findIndex((m) => types.includes(m.t) && m.__seq >= base && (!pred || pred(m)));
          if (i >= 0) return resolve(queue.splice(i, 1)[0]);
          if (Date.now() > deadline) {
            return reject(new Error(`Timeout: wartete auf ${types.join('/')} (warteschlange: ${queue.map((m) => m.t).join(',')})`));
          }
          setTimeout(poll, 10);
        })();
      });
    },
    close() { try { ws.terminate(); } catch { /* ignore */ } },
  });
}

async function openClient() {
  const c = makeClient();
  await new Promise((resolve, reject) => {
    c.ws.on('open', resolve);
    c.ws.on('error', reject);
  });
  await c.waitFor('WELCOME');
  return c;
}

/** Wartet kurz auf GAME_OVER, sonst null (für Züge ohne Spielende). */
function maybeGameOver(...clients) {
  return Promise.race(clients.map((c) => c.waitFor('GAME_OVER', 800).catch(() => null)))
    .then((r) => r || null);
}

/** Sequenz-Marke: alles ab hier ist frisch (wird VOR dem Senden gesetzt). */
function mark(c) {
  return c.mark();
}

/** Wartet auf Nachricht NUR ab Marke (keine Alt-Nachrichten aus früheren Zügen). */
function waits(c, t, base, pred, timeout = 5000) {
  return c.waitFor(t, timeout, (m) => m.__seq >= base && (!pred || pred(m)));
}

/** Frischer Spiel-State ab Marke (pred erhält das game-Objekt). */
function nextState(c, base, pred, timeout = 5000) {
  return waits(c, 'STATE', base, (m) => m.game && (!pred || pred(m.game)), timeout);
}

function wormsForTile(v) {
  if (v <= 24) return 1;
  if (v <= 28) return 2;
  if (v <= 32) return 3;
  return 4;
}

/**
 * Wartet, bis der menschliche Spieler am Zug ist (Bot-Engine läuft selbst).
 * Stille (>3 s ohne Nachricht) heißt: Bot fertig, der STATE liegt bereits vor.
 */
async function waitHumanTurn(c) {
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const base = mark(c);
    const msg = await c.waitAny(['STATE', 'GAME_OVER'], 3500, base).catch(() => null);
    if (!msg) {
      const go = c.queue.filter((m) => m.t === 'GAME_OVER').pop();
      if (go) return { gameOver: go };
      const known = c.queue.filter((m) => m.t === 'STATE' && m.game).pop();
      if (known) {
        const gm = known.game;
        if (gm.over || !gm.players[gm.currentPlayer].isBot) return { state: known };
      }
      continue;
    }
    if (msg.t === 'GAME_OVER') return { gameOver: msg };
    if (msg.game.over) return { state: msg };
    if (!msg.game.players[msg.game.currentPlayer].isBot) return { state: msg };
  }
  throw new Error('Bot-Zug dauert zu lange');
}

test('vollständiges Spiel über WS bis GAME_OVER mit gültiger Wertung', async () => {
  const a = await openClient();
  const b = await openClient();
  try {
    const clients = { A: a, B: b };
    a.send({ t: 'create', name: 'A' });
    const joinedA = await a.waitFor('JOINED');
    b.send({ t: 'join', code: joinedA.code, name: 'B' });
    const joinedB = await b.waitFor('JOINED');
    const ids = { [joinedA.playerId]: 'A', [joinedB.playerId]: 'B' };

    let b0 = mark(a);
    a.send({ t: 'start' });
    await waits(a, 'GAME_STARTED', b0);
    let st = await nextState(a, b0, (gm) => gm.grill.length === 16);
    a.queue.length = 0;
    b.queue.length = 0;

    let gameOver = null;
    let needChoiceSeen = 0;
    let bustSeen = 0;
    let turns = 0;

    while (!gameOver && turns < 300) {
      turns++;
      assert.ok(st && st.game, 'kein Spiel-State');
      if (st.game.over) {
        gameOver = await maybeGameOver(a, b);
        assert.ok(gameOver, 'GAME_OVER-Nachricht fehlt');
        break;
      }
      const actorKey = ids[st.game.currentPlayerId];
      assert.ok(actorKey, 'unbekannter Spieler am Zug');
      const me = clients[actorKey];

      let b1 = mark(me);
      me.send({ t: 'roll' });
      const res = await me.waitAny(['DICE_ROLLED', 'BUST', 'GAME_OVER'], 5000, b1);
      if (res.t === 'GAME_OVER') { gameOver = res; break; }
      if (res.t === 'BUST') {
        bustSeen++;
        st = await nextState(me, b1);
        gameOver = await maybeGameOver(a, b);
        continue;
      }
      // Wählen, bis Wurm beiseite liegt (oder Auto-BUST passiert).
      let stopped = false;
      for (let i = 0; i < 10 && !stopped; i++) {
        st = await nextState(me, b1, (gm) => gm.turn.phase !== 'roll' || gm.turn.over || gm.over);
        if (st.game.over || st.game.turn.over) break;
        const picks = st.game.turn.validPicks;
        assert.ok(picks.length > 0, 'Auto-BUST hätte kommen müssen');
        b1 = mark(me);
        me.send({ t: 'pick', value: picks.includes('W') ? 'W' : picks[0] });
        await waits(me, 'DICE_SELECTED', b1);
        st = await nextState(me, b1);
        if (st.game.over || st.game.turn.over) { bustSeen++; break; }
        // Sinnvolle Spielstrategie (konvergiert): weiter bis 21+ mit Wurm.
        // Phase take (alle 8 beiseite): Zug muss beendet werden, takeTile
        // regelt den Rest (ggf. BUST ohne Wurm).
        if ((st.game.turn.hasWorm && st.game.turn.score >= 21) || st.game.turn.phase === 'take') {
          b1 = mark(me);
          me.send({ t: 'stop' });
          stopped = true;
        } else {
          b1 = mark(me);
          me.send({ t: 'roll' });
          const r2 = await me.waitAny(['DICE_ROLLED', 'BUST', 'GAME_OVER'], 5000, b1);
          if (r2.t === 'GAME_OVER') { gameOver = r2; break; }
          if (r2.t === 'BUST') { bustSeen++; st = await nextState(me, b1); break; }
        }
      }
      if (gameOver) break;
      if (!stopped) continue; // Auto-BUST-Pfad, STATE ist aktuell
      const done = await me.waitAny(['TILE_TAKEN', 'BUST', 'NEED_CHOICE', 'GAME_OVER'], 5000, b1);
      if (done.t === 'GAME_OVER') { gameOver = done; break; }
      if (done.t === 'NEED_CHOICE') {
        needChoiceSeen++;
        const b2 = mark(me);
        me.send({ t: 'take', choice: { source: 'grill' } });
        const t2 = await me.waitAny(['TILE_TAKEN', 'GAME_OVER'], 5000, b2);
        if (t2.t === 'GAME_OVER') { gameOver = t2; break; }
      }
      if (done.t === 'BUST') bustSeen++;
      st = await nextState(me, b1);
      gameOver = await maybeGameOver(a, b);
    }

    if (!gameOver && st.game.over && st.game.ranking.length) {
      gameOver = { ranking: st.game.ranking, winner: st.game.winner };
    }
    assert.ok(gameOver, `Spiel endete nicht (Züge: ${turns})`);
    assert.ok(turns < 300, 'Turn-Limit erreicht');
    assert.equal(gameOver.ranking.length, 2);

    // Regelkonsistenz: absteigend nach Würmern, Gleichstand → höchste Portion.
    const rows = gameOver.ranking;
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      assert.ok(prev.worms > cur.worms || (prev.worms === cur.worms && prev.bestTile >= cur.bestTile), 'Rangliste unsortiert');
    }
    // Würmer aus Stapeln nachrechnen; keine offene Grillportion mehr.
    assert.ok(st.game.grill.every((t) => !t.faceUp), 'Grill muss leer sein');
    for (const row of rows) {
      const stack = st.game.players[row.playerIndex].stack;
      assert.equal(row.worms, stack.reduce((s, v) => s + wormsForTile(v), 0));
      assert.equal(row.bestTile, stack.length ? Math.max(...stack) : 0);
    }
    // Konsistenz: jede gehaltene Portion ist auf dem Grill als vergeben markiert.
    for (const p of st.game.players) {
      for (const v of p.stack) {
        assert.equal(st.game.grill.find((t) => t.value === v).faceUp, false, `Portion ${v} inkonsistent`);
      }
    }

    // Nach Spielende sind Aktionen Fehler.
    a.send({ t: 'roll' });
    const err = await a.waitFor('ERROR');
    assert.match(err.message, /laufend|Zug/);
  } finally {
    a.close();
    b.close();
  }
});

test('Mensch + Bot beenden ein Spiel bis GAME_OVER', async () => {
  const a = await openClient();
  try {
    a.send({ t: 'create', name: 'Mensch' });
    await a.waitFor('JOINED');
    a.send({ t: 'addBot', difficulty: 'normal' });
    await a.waitFor('PLAYER_JOINED');
    let b0 = mark(a);
    a.send({ t: 'start' });
    await waits(a, 'GAME_STARTED', b0);
    let st = await nextState(a, b0, (gm) => gm.grill.length === 16);
    a.queue.length = 0;

    let gameOver = null;
    let turns = 0;
    while (!gameOver && turns < 400) {
      turns++;
      if (st.game.over) {
        gameOver = await a.waitFor('GAME_OVER', 5000).catch(() => null)
          || (st.game.ranking.length ? { ranking: st.game.ranking, winner: st.game.winner } : null);
        break;
      }
      const cur = st.game.players[st.game.currentPlayer];
      if (cur.isBot) {
        // Bot spielt selbst (800-ms-Engine): warten, bis der Mensch am Zug ist.
        const res = await waitHumanTurn(a);
        if (res.gameOver) { gameOver = res.gameOver; break; }
        if (res.state) st = res.state;
        gameOver = await maybeGameOver(a);
        if (!gameOver && st.game.over && st.game.ranking.length) {
          gameOver = { ranking: st.game.ranking, winner: st.game.winner };
        }
        continue;
      }
      // Mensch: schneller Zug (Wurm sichern, dann stoppen).
      let finished = false;
      for (let i = 0; i < 10 && !finished; i++) {
        let b1 = mark(a);
        a.send({ t: 'roll' });
        const r = await a.waitAny(['DICE_ROLLED', 'BUST', 'GAME_OVER'], 5000, b1);
        if (r.t === 'GAME_OVER') { gameOver = r; break; }
        if (r.t === 'BUST') { st = await nextState(a, b1); finished = true; break; }
        st = await nextState(a, b1, (gm) => gm.turn.phase === 'pick' || gm.turn.over || gm.over);
        if (st.game.over || st.game.turn.over) { finished = true; break; }
        const picks = st.game.turn.validPicks;
        b1 = mark(a);
        a.send({ t: 'pick', value: picks.includes('W') ? 'W' : picks[0] });
        await waits(a, 'DICE_SELECTED', b1);
        st = await nextState(a, b1);
        if (st.game.over || st.game.turn.over) { finished = true; break; }
        if ((st.game.turn.hasWorm && st.game.turn.score >= 21) || st.game.turn.phase === 'take') {
          b1 = mark(a);
          a.send({ t: 'stop' });
          const done = await a.waitAny(['TILE_TAKEN', 'BUST', 'NEED_CHOICE', 'GAME_OVER'], 5000, b1);
          if (done.t === 'GAME_OVER') { gameOver = done; break; }
          if (done.t === 'NEED_CHOICE') {
            const b2 = mark(a);
            a.send({ t: 'take', choice: { source: 'grill' } });
            const t2 = await a.waitAny(['TILE_TAKEN', 'GAME_OVER'], 5000, b2);
            if (t2.t === 'GAME_OVER') { gameOver = t2; break; }
          }
          st = await nextState(a, b1);
          finished = true;
        }
      }
      if (!gameOver) gameOver = await maybeGameOver(a);
    }
    assert.ok(gameOver, 'Mensch+Bot-Spiel endete nicht');
    assert.equal(gameOver.ranking.length, 2);
  } finally {
    a.close();
  }
}, { timeout: 240000 });
