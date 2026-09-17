'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const g = require('../game');
const bots = require('../bots');
const { createHeckMeckServer } = require('../server');

function newGame() {
  const game = g.createGame(['BotA', 'BotB']);
  g.startGame(game);
  return game;
}

/** Deterministisches RNG aus Sequenz (fällt auf 0.5 zurück). */
function seqRng(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0.5);
}

function playThomas27(game) {
  g.rollDice(game, { dice: ['4', '4', '4', '1', '2', '3', '5', 'W'] });
  g.pickValue(game, '4');
  g.rollDice(game, { dice: ['W', '1', '2', '3', '5'] });
  g.pickValue(game, 'W');
  g.rollDice(game, { dice: ['5', '5', 'W', 'W'] });
  g.pickValue(game, '5');
}

// ---------- Auswahl ----------

test('choosePick ist immer gültig (fuzz über alle Stufen)', () => {
  for (const level of bots.DIFFICULTIES) {
    for (let i = 0; i < 50; i++) {
      const game = newGame();
      // Zufälligen Teilzug aufbauen.
      const dice = Array.from({ length: 8 }, () => g.DICE_VALUES[Math.floor(Math.random() * 6)]);
      g.rollDice(game, { dice });
      const pick = bots.choosePick(game, level, Math.random);
      assert.ok(g.validPickValues(game).includes(pick), `${level}: ${pick} ungültig`);
      g.pickValue(game, pick); // darf nie werfen
    }
  }
});

test('Bot wählt nie doppelt', () => {
  for (const level of bots.DIFFICULTIES) {
    const game = newGame();
    g.rollDice(game, { dice: ['3', '3', '1', '2', '4', '5', 'W', '1'] });
    g.pickValue(game, '3');
    g.rollDice(game, { dice: ['1', '3', '4', 'W', '5', '2'] });
    const pick = bots.choosePick(game, level, seqRng([0]));
    assert.notEqual(pick, '3');
    assert.ok(g.canPick(game, pick));
  }
});

test('normal/hard sichern zuerst den Wurm', () => {
  for (const level of ['normal', 'hard']) {
    const game = newGame();
    g.rollDice(game, { dice: ['W', '5', '5', '1', '2', '3', '4', '1'] });
    assert.equal(bots.choosePick(game, level, seqRng([0])), 'W');
  }
});

test('easy wählt zufällig (rng bestimmt Index)', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['1', '2', '3', '4', '5', 'W', '1', '2'] });
  const valid = g.validPickValues(game);
  assert.equal(bots.choosePick(game, 'easy', seqRng([0])), valid[0]);
});

// ---------- Stop-Entscheidung ----------

test('ohne Wurm wird weitergewürfelt', () => {
  for (const level of bots.DIFFICULTIES) {
    const game = newGame();
    g.rollDice(game, { dice: ['1', '1', '2', '3', '4', '5', '2', '3'] });
    g.pickValue(game, '1');
    assert.equal(bots.decideStop(game, level, seqRng([0])).stop, false);
  }
});

test('alle Würfel beiseite → Pflicht-Stopp', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['W', '1', '1', '2', '2', '3', '4', '5'] });
  g.pickValue(game, 'W'); // Rest 7
  g.rollDice(game, { dice: ['1', '1', '2', '2', '3', '4', '5'] });
  g.pickValue(game, '1'); // Rest 5
  g.rollDice(game, { dice: ['2', '2', '3', '4', '5'] });
  g.pickValue(game, '2'); // Rest 3
  g.rollDice(game, { dice: ['3', '4', '5'] });
  g.pickValue(game, '3'); // Rest 2
  g.rollDice(game, { dice: ['4', '5'] });
  g.pickValue(game, '4'); // Rest 1
  g.rollDice(game, { dice: ['5'] });
  const last = g.pickValue(game, '5');
  assert.equal(last.phase, 'take');
  for (const level of bots.DIFFICULTIES) {
    assert.equal(bots.decideStop(game, level, seqRng([0.99])).stop, true);
  }
});

test('hard sichert hohe Punktestände, easy ist risikofreudig', () => {
  const game = newGame();
  playThomas27(game); // 27 mit Wurm
  g.rollDice(game, { dice: ['3', '1'] });
  g.pickValue(game, '3'); // 30
  assert.equal(bots.decideStop(game, 'hard', seqRng([0.5])).stop, true);
  // easy mit rng≈1 (> 0.35) würfelt weiter:
  const game2 = newGame();
  playThomas27(game2);
  g.rollDice(game2, { dice: ['3', '1'] });
  g.pickValue(game2, '3');
  assert.equal(bots.decideStop(game2, 'easy', seqRng([0.99])).stop, false);
  assert.equal(bots.decideStop(game2, 'easy', seqRng([0.0])).stop, true);
});

test('bustRisk entspricht (gewählte/6)^rest', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['1', '2', '3', '4', '5', 'W', '1', '2'] });
  g.pickValue(game, '1'); // 1 Wert gewählt (2 Würfel beiseite)
  assert.equal(bots.bustRisk(game), Math.pow(1 / 6, g.remainingDice(game)));
  g.rollDice(game, { dice: ['2', '3', '4', '5', 'W', '1'] });
  g.pickValue(game, '2'); // 2 Werte gewählt
  assert.equal(bots.bustRisk(game), Math.pow(2 / 6, g.remainingDice(game)));
  // Vor dem ersten Pick und ohne Restwürfel ist das Risiko 0.
  const fresh = newGame();
  assert.equal(bots.bustRisk(fresh), 0);
});

// ---------- Nehmen & Stehlen ----------

test('Bot kann Portion nehmen und beendet den Zug korrekt', () => {
  for (const level of bots.DIFFICULTIES) {
    const game = newGame();
    playThomas27(game);
    const dec = bots.decideStop(game, level, seqRng([0]));
    assert.equal(dec.stop, true);
    const res = g.takeTile(game, dec.choice);
    assert.equal(res.value, 27);
    assert.deepEqual(game.players[0].stack, [27]);
    assert.equal(game.currentPlayer, 1); // Zug korrekt beendet
  }
});

test('Bot kann stehlen (hard stiehlt vom Führenden)', () => {
  const game = newGame();
  game.players[1].stack.push(27, 30); // oben 30? Für Steal-27: oben muss 27 sein
  game.players[1].stack.push(27);
  playThomas27(game); // 27, Grill-27 UND Gegner-27 → needChoice
  const ct = g.canTake(game);
  assert.equal(ct.needChoice, true);
  const choice = bots.chooseTakeOption(game, 27, ct.options, 'hard', seqRng([0]));
  assert.equal(choice.source, 'steal');
  const res = g.takeTile(game, choice);
  assert.equal(res.type, 'steal');
  assert.deepEqual(game.players[0].stack, [27]);
});

test('chooseTakeOption: easy zufällig, normal stiehlt', () => {
  const game = newGame();
  game.players[1].stack.push(27);
  playThomas27(game);
  const ct = g.canTake(game);
  assert.equal(bots.chooseTakeOption(game, 27, ct.options, 'easy', seqRng([0])), ct.options[0]);
  assert.equal(bots.chooseTakeOption(game, 27, ct.options, 'normal', seqRng([0])).source, 'steal');
});

// ---------- BUST ----------

test('Bot kann BUST auslösen und das Spiel läuft weiter', () => {
  const game = newGame();
  game.players[0].stack.push(24);
  game.grill.find((t) => t.value === 24).faceUp = false;
  // Bot-Zug mit manipuliertem Würfelpech: hard sichert den Wurm …
  g.rollDice(game, { dice: ['3', '3', '1', '2', '4', '5', 'W', '1'] });
  g.pickValue(game, bots.choosePick(game, 'hard', seqRng([0]))); // → 'W', Rest 7
  // … dann kommen nur noch Würmer (bereits gewählt) → Auto-BUST.
  const res = g.rollDice(game, { dice: ['W', 'W', 'W', 'W', 'W', 'W', 'W'] });
  assert.equal(res.bust, true);
  assert.equal(game.currentPlayer, 1);
});

// ---------- Komplette Spiele ----------

test('Bot-Züge sind immer gültig: volle Spiele pro Stufe', () => {
  for (const level of bots.DIFFICULTIES) {
    const game = g.createGame(['X', 'Y']);
    g.startGame(game);
    let turns = 0;
    while (!game.over && turns < 500) {
      bots.playBotTurn(game, level, Math.random);
      turns++;
    }
    assert.ok(game.over, `${level}: Spiel endet nicht`);
    assert.equal(game.ranking.length, 2);
    assert.ok(game.winner === 0 || game.winner === 1);
  }
});

test('gemischtes Spiel normal vs. hard endet mit Rangliste', () => {
  const game = g.createGame(['N', 'H']);
  g.startGame(game);
  let turns = 0;
  while (!game.over && turns < 500) {
    bots.playBotTurn(game, game.currentPlayer === 0 ? 'normal' : 'hard', Math.random);
    turns++;
  }
  assert.ok(game.over);
  const worms = game.ranking[0].worms;
  assert.ok(worms > 0);
});

// ---------- WS-Integration: Bot spielt automatisch ----------

test('Bot spielt über WS automatisch (800-ms-Engine)', async () => {
  const srv = createHeckMeckServer(0, '127.0.0.1');
  const addr = await srv.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  const queue = [];
  ws.on('message', (raw) => {
    try { queue.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const send = (o) => ws.send(JSON.stringify(o));
  const waitFor = (t, timeout = 25000, pred) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    (function poll() {
      const i = queue.findIndex((m) => m.t === t && (!pred || pred(m)));
      if (i >= 0) return resolve(queue.splice(i, 1)[0]);
      if (Date.now() > deadline) return reject(new Error(`Timeout: ${t}`));
      setTimeout(poll, 25);
    })();
  });

  try {
    await waitFor('WELCOME', 5000);
    send({ t: 'create', name: 'Mensch' });
    const joined = await waitFor('JOINED', 5000);
    send({ t: 'addBot', difficulty: 'easy' });
    await waitFor('PLAYER_JOINED', 5000);
    send({ t: 'start' });
    await waitFor('GAME_STARTED', 5000);

    // Mensch spielt seinen (ersten) Zug schnell zu Ende.
    for (let i = 0; i < 12; i++) {
      send({ t: 'roll' });
      const msg = await Promise.race([waitFor('DICE_ROLLED', 5000), waitFor('BUST', 5000)]);
      if (msg.t === 'BUST') break;
      const st = await waitFor('STATE', 5000, (m) => m.game && m.game.turn.phase === 'pick');
      const picks = st.game.turn.validPicks;
      send({ t: 'pick', value: picks.includes('W') ? 'W' : picks[0] });
      await waitFor('DICE_SELECTED', 5000);
      await waitFor('STATE', 5000);
      const st2 = queue.filter((m) => m.t === 'STATE').pop();
      if (st2 && st2.game.turn.hasWorm) {
        send({ t: 'stop' });
        await Promise.race([waitFor('TILE_TAKEN', 5000), waitFor('BUST', 5000), waitFor('NEED_CHOICE', 5000)]);
        break;
      }
    }
    // Jetzt ist der Bot am Zug: er muss automatisch würfeln (ohne Zutun).
    const botRoll = await waitFor('DICE_ROLLED', 25000);
    assert.ok(botRoll.rolled.length > 0 && botRoll.rolled.length <= 8);
    // … und seinen Zug auch beenden (TURN_STARTED für den Menschen folgt).
    await waitFor('TURN_STARTED', 25000, (m) => m.playerId === joined.playerId);
  } finally {
    ws.close();
    await srv.close();
  }
});
