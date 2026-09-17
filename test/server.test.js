'use strict';

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

// ---------- Client-Helfer ----------

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [];
  ws.on('message', (raw) => {
    try { queue.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  return {
    ws,
    queue,
    send: (obj) => ws.send(JSON.stringify(obj)),
    waitFor(t, timeout = 3000, pred) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeout;
        (function poll() {
          const i = queue.findIndex((m) => m.t === t && (!pred || pred(m)));
          if (i >= 0) return resolve(queue.splice(i, 1)[0]);
          if (Date.now() > deadline) return reject(new Error(`Timeout: wartete auf ${t} (warteschlange: ${queue.map((m) => m.t).join(',')})`));
          setTimeout(poll, 10);
        })();
      });
    },
    close() { ws.close(); },
  };
}

async function openClient() {
  const c = connect();
  await new Promise((resolve, reject) => {
    c.ws.on('open', resolve);
    c.ws.on('error', reject);
  });
  await c.waitFor('WELCOME');
  return c;
}

async function createRoom(client, name = 'Host') {
  client.send({ t: 'create', name });
  const joined = await client.waitFor('JOINED');
  assert.match(joined.code, /^[A-Z0-9]{4}$/);
  assert.ok(joined.playerId);
  assert.ok(joined.token);
  const state = await client.waitFor('STATE');
  assert.equal(state.status, 'lobby');
  return joined;
}

// ---------- Tests ----------

test('Raum erstellen: Code, IDs und Lobby-State', async () => {
  const c = await openClient();
  const joined = await createRoom(c, 'Florian');
  assert.equal(joined.code.length, 4);
  c.close();
});

test('Raum beitreten: Host sieht PLAYER_JOINED', async () => {
  const host = await openClient();
  const { code } = await createRoom(host, 'Florian');
  const guest = await openClient();
  guest.send({ t: 'join', code, name: 'Max' });
  const joined = await guest.waitFor('JOINED');
  assert.equal(joined.code, code);
  const info = await host.waitFor('PLAYER_JOINED', 3000, (m) => m.name === 'Max');
  assert.ok(info.playerId);
  host.close();
  guest.close();
});

test('falscher Code → ERROR', async () => {
  const c = await openClient();
  c.send({ t: 'join', code: 'ZZZZ', name: 'Max' });
  const err = await c.waitFor('ERROR');
  assert.match(err.message, /Raumcode/);
  c.close();
});

test('maximal 7 Spieler pro Raum', async () => {
  const host = await openClient();
  const { code } = await createRoom(host, 'Host');
  const guests = [];
  for (let i = 0; i < 6; i++) {
    const cl = await openClient();
    cl.send({ t: 'join', code, name: `G${i}` });
    await cl.waitFor('JOINED');
    guests.push(cl);
  }
  const extra = await openClient();
  extra.send({ t: 'join', code, name: 'ZuViel' });
  const err = await extra.waitFor('ERROR');
  assert.match(err.message, /voll/);
  host.close();
  for (const cl of guests) cl.close();
  extra.close();
});

test('Spielstart erst ab 2 Spielern; danach kein Beitritt', async () => {
  const host = await openClient();
  const { code } = await createRoom(host, 'Solo');
  host.send({ t: 'start' });
  const err = await host.waitFor('ERROR');
  assert.match(err.message, /2 Spieler/);
  const guest = await openClient();
  guest.send({ t: 'join', code, name: 'Max' });
  await guest.waitFor('JOINED');
  host.send({ t: 'start' });
  await host.waitFor('GAME_STARTED');
  await host.waitFor('TURN_STARTED');
  const state = await host.waitFor('STATE', 3000, (m) => m.game && m.game.grill.length === 16);
  assert.equal(state.status, 'playing');
  const late = await openClient();
  late.send({ t: 'join', code, name: 'Spät' });
  const err2 = await late.waitFor('ERROR');
  assert.match(err2.message, /bereits/);
  host.close();
  guest.close();
  late.close();
});

test('nur der aktuelle Spieler darf handeln', async () => {
  const host = await openClient();
  const { code } = await createRoom(host, 'A');
  const guest = await openClient();
  guest.send({ t: 'join', code, name: 'B' });
  await guest.waitFor('JOINED');
  host.send({ t: 'start' });
  await host.waitFor('GAME_STARTED');
  guest.send({ t: 'roll' });
  const err = await guest.waitFor('ERROR');
  assert.match(err.message, /nicht am Zug/);
  guest.send({ t: 'stop' });
  const err2 = await guest.waitFor('ERROR');
  assert.match(err2.message, /nicht am Zug/);
  host.close();
  guest.close();
});

test('stop ohne Pick → ERROR (kein BUST durch Fehlklick)', async () => {
  const host = await openClient();
  const { code } = await createRoom(host, 'A');
  const guest = await openClient();
  guest.send({ t: 'join', code, name: 'B' });
  await guest.waitFor('JOINED');
  host.send({ t: 'start' });
  await host.waitFor('GAME_STARTED');
  host.send({ t: 'stop' });
  const err = await host.waitFor('ERROR');
  assert.match(err.message, /gewählt/);
  host.close();
  guest.close();
});

test('Wurf + Auswahl werden synchron an alle verteilt', async () => {
  const host = await openClient();
  const { code } = await createRoom(host, 'A');
  const guest = await openClient();
  guest.send({ t: 'join', code, name: 'B' });
  await guest.waitFor('JOINED');
  host.send({ t: 'start' });
  await host.waitFor('GAME_STARTED');

  host.send({ t: 'roll' });
  const rolled = await host.waitFor('DICE_ROLLED');
  assert.equal(rolled.rolled.length, 8);
  const guestRolled = await guest.waitFor('DICE_ROLLED');
  assert.deepEqual(guestRolled.rolled, rolled.rolled);

  const st = await host.waitFor('STATE', 3000, (m) => m.game && m.game.turn.rolled.length === 8);
  const pick = st.game.turn.validPicks[0];
  assert.ok(pick);
  host.send({ t: 'pick', value: pick });
  const sel = await guest.waitFor('DICE_SELECTED');
  assert.equal(sel.picked, pick);
  const st2 = await guest.waitFor('STATE', 3000, (m) => m.game && m.game.turn.picked.includes(pick));
  assert.ok(st2.game.turn.score > 0);
  host.close();
  guest.close();
});

test('kompletter Zug über WS: roll/pick bis Wurm, dann stop', async () => {
  const host = await openClient();
  const { code } = await createRoom(host, 'A');
  const guest = await openClient();
  guest.send({ t: 'join', code, name: 'B' });
  await guest.waitFor('JOINED');
  host.send({ t: 'start' });
  await host.waitFor('GAME_STARTED');

  // Würfeln + wählen, bis ein Wurm beiseite liegt (max. 8 Picks).
  for (let i = 0; i < 10; i++) {
    host.send({ t: 'roll' });
    const msg = await host.waitFor('DICE_ROLLED');
    void msg;
    const st = await host.waitFor('STATE', 3000, (m) => m.game && m.game.turn.phase === 'pick');
    const choices = st.game.turn.validPicks;
    // Wurm bevorzugen, sonst ersten gültigen Wert.
    const pick = choices.includes('W') ? 'W' : choices[0];
    host.send({ t: 'pick', value: pick });
    await host.waitFor('DICE_SELECTED');
    const after = await host.waitFor('STATE', 3000, (m) => m.game && m.game.turn.phase !== 'pick');
    if (after.game.turn.hasWorm) break;
  }
  host.send({ t: 'stop' });
  const done = await Promise.race([host.waitFor('TILE_TAKEN'), host.waitFor('BUST'), host.waitFor('NEED_CHOICE')]);
  assert.ok(['TILE_TAKEN', 'BUST', 'NEED_CHOICE'].includes(done.t));
  const turn = await host.waitFor('TURN_STARTED');
  assert.ok(turn.playerId);
  host.close();
  guest.close();
});

test('Disconnect + Reconnect via Token', async () => {
  const host = await openClient();
  const { code } = await createRoom(host, 'A');
  const guest = await openClient();
  guest.send({ t: 'join', code, name: 'B' });
  const joined = await guest.waitFor('JOINED');
  host.send({ t: 'start' });
  await host.waitFor('GAME_STARTED');
  guest.close();
  await host.waitFor('PLAYER_LEFT', 3000, (m) => m.name === 'B');

  const back = await openClient();
  back.send({ t: 'rejoin', code, token: joined.token });
  const rejoined = await back.waitFor('REJOINED');
  assert.equal(rejoined.playerId, joined.playerId);
  const st = await back.waitFor('STATE');
  assert.equal(st.status, 'playing');
  host.close();
  back.close();
});

test('Bot hinzufügen zählt als Spieler für den Start', async () => {
  const host = await openClient();
  await createRoom(host, 'A');
  host.send({ t: 'addBot', difficulty: 'easy' });
  await host.waitFor('PLAYER_JOINED');
  host.send({ t: 'start' });
  await host.waitFor('GAME_STARTED');
  const st = await host.waitFor('STATE', 3000, (m) => m.game && m.game.players.length === 2);
  assert.equal(st.game.players[1].isBot, true);
  host.close();
});
