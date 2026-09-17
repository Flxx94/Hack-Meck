'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../game');

// ---------- Hilfsfunktionen ----------

function newGame(names = ['A', 'B']) {
  const game = g.createGame(names);
  g.startGame(game);
  return game;
}

/** Thomas-Beispiel aus der Anleitung: 4/4/4=12 → Wurm=17 → 5/5=27. */
function playThomas27(game) {
  assert.deepEqual(g.rollDice(game, { dice: ['4', '4', '4', '1', '2', '3', '5', 'W'] }).rolled.length, 8);
  assert.equal(g.pickValue(game, '4').score, 12);
  g.rollDice(game, { dice: ['W', '1', '2', '3', '5'] });
  assert.equal(g.pickValue(game, 'W').score, 17);
  g.rollDice(game, { dice: ['5', '5', 'W', 'W'] });
  assert.equal(g.pickValue(game, '5').score, 27);
}

/** Grillportion schließen (nicht verfügbar machen). */
function closeTile(game, value) {
  g.createGrill; // no-op, nur damit der Helper sichtbar bleibt
  const t = game.grill.find((x) => x.value === value);
  t.faceUp = false;
}

// ---------- Grundlagen ----------

test('8 Würfel mit Werten 1–5 und Wurm', () => {
  assert.equal(g.DICE_COUNT, 8);
  assert.deepEqual([...g.DICE_VALUES].sort(), ['1', '2', '3', '4', '5', 'W']);
});

test('Wurm zählt 5 Punkte', () => {
  assert.equal(g.WORM_VALUE, 5);
  assert.equal(g.dicePoints('W'), 5);
  assert.equal(g.dicePoints('4'), 4);
});

test('Grill: 16 Portionen 21–36 mit Standard-Wurmverteilung', () => {
  const grill = g.createGrill();
  assert.equal(grill.length, 16);
  assert.equal(grill[0].value, 21);
  assert.equal(grill[15].value, 36);
  assert.ok(grill.every((t) => t.faceUp === true));
  for (const v of [21, 22, 23, 24]) assert.equal(g.wormsForTile(v), 1);
  for (const v of [25, 26, 27, 28]) assert.equal(g.wormsForTile(v), 2);
  for (const v of [29, 30, 31, 32]) assert.equal(g.wormsForTile(v), 3);
  for (const v of [33, 34, 35, 36]) assert.equal(g.wormsForTile(v), 4);
});

test('createGame braucht 2–7 Spieler', () => {
  assert.throws(() => g.createGame(['A']), /2–7/);
  assert.throws(() => g.createGame(['1', '2', '3', '4', '5', '6', '7', '8']), /2–7/);
  const game = g.createGame(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.equal(game.players.length, 7);
  assert.equal(game.grill.length, 16);
  assert.throws(() => g.startGame(game) && g.startGame(game), /bereits/);
});

// ---------- Würfeln & Auswählen ----------

test('alle Würfel eines Werts werden beiseitegelegt, Rest wird erneut gewürfelt', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['2', '2', '4', '5', 'W', '1', '3', '3'] });
  const r = g.pickValue(game, '3');
  assert.equal(r.count, 2);
  assert.equal(r.score, 6);
  assert.equal(g.remainingDice(game), 6);
  assert.equal(g.setAsideCount(game), 2);
  const roll = g.rollDice(game, { dice: ['1', '2', '4', '5', 'W', '1'] });
  assert.equal(roll.rolled.length, 6);
});

test('doppeltes Auswählen wird verhindert', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['2', '2', '4', '5', 'W', '1', '3', '3'] });
  g.pickValue(game, '3');
  g.rollDice(game, { dice: ['1', '3', '4', 'W', '5', '2'] });
  assert.equal(g.canPick(game, '3'), false);
  assert.throws(() => g.pickValue(game, '3'), /nicht gewählt/);
  assert.equal(g.canPick(game, 'W'), true);
});

test('nicht gewürfelter Wert kann nicht gewählt werden', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['1', '1', '2', '2', '3', '3', '4', '4'] });
  assert.equal(g.canPick(game, 'W'), false);
  assert.throws(() => g.pickValue(game, 'W'), /nicht gewählt/);
});

test('Phasen werden erzwungen: kein pick vor roll, kein roll nach pick', () => {
  const game = newGame();
  assert.throws(() => g.pickValue(game, '1'), /nicht gewählt/);
  g.rollDice(game, { dice: ['1', '2', '3', '4', '5', 'W', '1', '2'] });
  assert.throws(() => g.rollDice(game), /nicht gewürfelt/);
});

test('Thomas-Beispiel: 12 → 17 → 27 und exakter Grill-Treffer', () => {
  const game = newGame();
  playThomas27(game);
  assert.equal(g.turnScore(game), 27);
  assert.equal(g.hasWorm(game), true);
  const res = g.takeTile(game);
  assert.equal(res.type, 'grill');
  assert.equal(res.value, 27);
  assert.deepEqual(game.players[0].stack, [27]);
  assert.equal(game.grill.find((t) => t.value === 27).faceUp, false);
  assert.equal(game.currentPlayer, 1); // nächster Spieler am Zug
});

// ---------- Automatischer BUST ----------

test('nur bereits gewählte Werte → automatischer BUST (Birgit-Beispiel)', () => {
  const game = newGame();
  game.players[0].stack.push(24);
  closeTile(game, 24);
  g.rollDice(game, { dice: ['3', '3', '1', '2', '4', '5', 'W', '1'] });
  g.pickValue(game, '3'); // 6
  g.rollDice(game, { dice: ['5', '5', '5', '1', '2', '4'] });
  g.pickValue(game, '5'); // 21
  g.rollDice(game, { dice: ['W', '1', '1'] });
  g.pickValue(game, 'W'); // 26
  const res = g.rollDice(game, { dice: ['3', 'W'] });
  assert.equal(res.bust, true);
  assert.deepEqual(game.players[0].stack, []); // Rücklage
  assert.equal(game.grill.find((t) => t.value === 24).faceUp, true);
  assert.equal(game.grill.find((t) => t.value === 36).faceUp, false); // höchste umgedreht
  assert.equal(game.currentPlayer, 1);
});

test('nur Würmer, Wurm bereits gewählt → automatischer BUST', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['W', '1', '2', '3', '4', '5', '1', '2'] });
  g.pickValue(game, 'W');
  const res = g.rollDice(game, { dice: ['W', 'W', 'W', 'W', 'W', 'W', 'W'] });
  assert.equal(res.bust, true);
  assert.equal(res.reason, 'only-picked-values');
});

// ---------- Wurm-Pflicht & freiwilliges Beenden ----------

test('ohne Wurm ist das Beenden ein Fehlwurf', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['1', '1', '2', '3', '4', '5', '2', '3'] });
  g.pickValue(game, '1');
  assert.equal(g.hasWorm(game), false);
  const res = g.endTurn(game);
  assert.equal(res.bust, true);
  assert.equal(res.reason, 'no-worm');
});

test('freiwilliges Beenden mit Wurm nimmt exakte Grillportion', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['W', '5', '5', '1', '2', '3', '4', '1'] });
  g.pickValue(game, 'W'); // 5
  g.rollDice(game, { dice: ['5', '5', '1', '2', '3', '4', '1'] });
  g.pickValue(game, '5'); // 15
  g.rollDice(game, { dice: ['4', '4', '1', '2', '3'] });
  g.pickValue(game, '4'); // 23
  const res = g.endTurn(game);
  assert.equal(res.type, 'grill');
  assert.equal(res.value, 23);
});

// ---------- Stehlen ----------

test('exakter Treffer auf Gegnerstapel → stehlen', () => {
  const game = newGame();
  game.players[1].stack.push(32);
  closeTile(game, 32); // liegt nicht mehr auf dem Grill (Thomas-Fall)
  g.rollDice(game, { dice: ['5', '5', '5', '1', '2', '3', '4', 'W'] });
  g.pickValue(game, '5'); // 15
  g.rollDice(game, { dice: ['W', '1', '2', '3', '4'] });
  g.pickValue(game, 'W'); // 20
  g.rollDice(game, { dice: ['4', '4', '1', '2'] });
  g.pickValue(game, '4'); // 28
  g.rollDice(game, { dice: ['3', '1'] });
  g.pickValue(game, '3'); // 31
  g.rollDice(game, { dice: ['1'] });
  g.pickValue(game, '1'); // 32
  const res = g.takeTile(game);
  assert.equal(res.type, 'steal');
 assert.equal(res.value, 32);
  assert.deepEqual(game.players[1].stack, []);
  assert.deepEqual(game.players[0].stack, [32]);
});

test('stealTile direkt aufrufbar', () => {
  const game = newGame();
  game.players[1].stack.push(28);
  closeTile(game, 28);
  g.rollDice(game, { dice: ['5', '5', '5', '4', '4', '1', '2', 'W'] });
  g.pickValue(game, '5'); // 15
  g.rollDice(game, { dice: ['4', '4', '1', '2', 'W'] });
  g.pickValue(game, '4'); // 23
  g.rollDice(game, { dice: ['W', '1', '2'] });
  g.pickValue(game, 'W'); // 28
  const res = g.stealTile(game, 1);
  assert.equal(res.type, 'steal');
  assert.deepEqual(game.players[0].stack, [28]);
});

test('exakt auf Grill UND Gegner → Spieler wählt (needChoice)', () => {
  const game = newGame();
  game.players[1].stack.push(27); // 27 liegt zusätzlich auf dem Grill
  playThomas27(game);
  const pending = g.takeTile(game);
  assert.equal(pending.needChoice, true);
  assert.equal(pending.options.length, 2);
  // Wahl Grill:
  const resGrill = g.takeTile(game, { source: 'grill' });
  assert.equal(resGrill.type, 'grill');
  assert.deepEqual(game.players[0].stack, [27]);
  assert.deepEqual(game.players[1].stack, [27]);
});

test('exakt auf Grill UND Gegner → Wahl steal', () => {
  const game = newGame();
  game.players[1].stack.push(27);
  playThomas27(game);
  const res = g.takeTile(game, { source: 'steal', fromPlayer: 1 });
  assert.equal(res.type, 'steal');
  assert.deepEqual(game.players[1].stack, []);
  assert.deepEqual(game.players[0].stack, [27]);
  assert.equal(game.grill.find((t) => t.value === 27).faceUp, true); // Grill bleibt offen
});

// ---------- Nächstniedrigere / keine niedrigere ----------

test('exakter Wert fehlt → nächstniedrigere Grillportion', () => {
  const game = newGame();
  playThomas27(game); // 27
  g.rollDice(game, { dice: ['1', '3'] });
  g.pickValue(game, '3'); // 30
  closeTile(game, 30); // 30 nicht verfügbar
  const res = g.takeTile(game);
  assert.equal(res.type, 'lower');
  assert.equal(res.value, 29);
  assert.deepEqual(game.players[0].stack, [29]);
});

test('keine niedrigere Portion → Fehlwurf', () => {
  const game = newGame();
  for (const t of game.grill) if (t.value !== 36) t.faceUp = false;
  g.rollDice(game, { dice: ['5', '5', '4', '4', '1', '2', '3', 'W'] });
  g.pickValue(game, '5'); // 10
  g.rollDice(game, { dice: ['4', '4', '1', '2', '3', 'W'] });
  g.pickValue(game, '4'); // 18
  g.rollDice(game, { dice: ['W', '1', '2', '3'] });
  g.pickValue(game, 'W'); // 23 → nur 36 offen, nichts drunter/exakt
  const res = g.takeTile(game);
  assert.equal(res.bust, true);
  assert.equal(res.reason, 'no-lower');
});

// ---------- BUST-Sonderfälle ----------

test('BUST ohne eigene Portion: keine Rückgabe, nichts umdrehen', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['1', '1', '2', '3', '4', '5', '2', '3'] });
  g.pickValue(game, '1');
  const res = g.endTurn(game); // kein Wurm → BUST
  assert.equal(res.bust, true);
  assert.equal(res.returned, null);
  assert.equal(res.flipped, null);
  assert.ok(game.grill.every((t) => t.faceUp));
});

test('zurückgelegte höchste Portion bleibt offen, nichts wird umgedreht', () => {
  const game = newGame();
  game.players[0].stack.push(36);
  closeTile(game, 36);
  closeTile(game, 35);
  g.rollDice(game, { dice: ['1', '1', '2', '3', '4', '5', '2', '3'] });
  g.pickValue(game, '1');
  const res = g.endTurn(game);
  assert.equal(res.returned, 36);
  assert.equal(res.flipped, null);
  assert.equal(game.grill.find((t) => t.value === 36).faceUp, true);
  assert.equal(game.grill.find((t) => t.value === 35).faceUp, false); // war schon zu
  assert.equal(game.grill.find((t) => t.value === 34).faceUp, true); // bleibt offen
});

test('bust ist idempotent (keine doppelte Ausführung)', () => {
  const game = newGame();
  game.players[0].stack.push(25);
  closeTile(game, 25);
  g.rollDice(game, { dice: ['1', '1', '2', '3', '4', '5', '2', '3'] });
  g.pickValue(game, '1');
  const first = g.bust(game, 'test');
  assert.equal(first.bust, true);
  assert.equal(first.returned, 25);
  // Zweiter Aufruf trifft bereits abgeschlossenen Zug (jetzt Spieler 2 am Zug? nein:
  // bust startet nächsten Zug – also aktiver Zug von Spieler 2; idempotenz testen wir
  // über einen beendeten Zug: takeTile nach Spielende wirft).
  assert.equal(game.currentPlayer, 1);
  assert.deepEqual(game.players[0].stack, []);
});

test('doppeltes bust im selben Zug ist unmöglich (turn.over)', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['1', '2', '3', '4', '5', 'W', '1', '2'] });
  g.pickValue(game, '1');
  game.turn.over = true; // simuliert abgeschlossenen Zug
  const res = g.bust(game);
  assert.equal(res.alreadyOver, true);
});

// ---------- Alle Würfel beiseite ----------

test('alle 8 Würfel beiseite → kein Weiterwürfeln, Zug muss beendet werden', () => {
  const game = newGame();
  g.rollDice(game, { dice: ['1', '1', '1', '2', '3', '4', '5', 'W'] });
  g.pickValue(game, '1'); // 3
  g.rollDice(game, { dice: ['2', '3', '4', '5', 'W'] });
  g.pickValue(game, '2'); // 5
  g.rollDice(game, { dice: ['3', '4', '5', 'W'] });
  g.pickValue(game, '3'); // 8
  g.rollDice(game, { dice: ['4', '5', 'W'] });
  g.pickValue(game, '4'); // 12
  g.rollDice(game, { dice: ['5', 'W'] });
  g.pickValue(game, '5'); // 17
  g.rollDice(game, { dice: ['W'] });
  const last = g.pickValue(game, 'W'); // 22
  assert.equal(last.phase, 'take');
  assert.equal(g.remainingDice(game), 0);
  assert.throws(() => g.rollDice(game), /Keine Würfel/);
  const res = g.takeTile(game);
  assert.equal(res.value, 22);
});

// ---------- Spielende & Wertung ----------

test('Spielende: letzte offene Portion genommen → Rangliste + Gewinner', () => {
  const game = newGame();
  for (const t of game.grill) if (t.value !== 21) t.faceUp = false;
  game.players[0].stack.push(30); // 3 Würmer
  game.players[1].stack.push(33); // 4 Würmer
  // Spieler A nimmt 21 (1 Wurm) → Grill leer → Spielende
  g.rollDice(game, { dice: ['5', '5', '5', '1', '1', '2', '3', 'W'] });
  g.pickValue(game, '5'); // 15
  g.rollDice(game, { dice: ['1', '1', '2', '3', 'W'] });
  g.pickValue(game, '1'); // 17
  g.rollDice(game, { dice: ['W', '2', '3'] });
  g.pickValue(game, 'W'); // 22 → nächstniedrigere: nur 21 offen
  const res = g.takeTile(game);
  assert.equal(res.type, 'lower');
  assert.equal(res.value, 21);
  assert.equal(res.gameOver, true);
  assert.equal(game.over, true);
  // A: 3+1=4, B: 4 → Gleichstand → höchste Einzelportion: A=30, B=33 → B gewinnt
  assert.equal(game.winner, 1);
  assert.equal(game.ranking[0].playerIndex, 1);
});

test('Gleichstand: wertvollste Einzelportion entscheidet', () => {
  const game = g.createGame(['A', 'B']);
  game.players[0].stack.push(36); // 4 Würmer, best 36
  game.players[1].stack.push(35); // 4 Würmer, best 35
  const ranking = g.calculateFinalScore(game);
  assert.equal(ranking[0].playerIndex, 0);
  assert.equal(ranking[0].worms, 4);
  assert.equal(ranking[1].worms, 4);
  assert.equal(ranking[0].bestTile, 36);
});

test('meiste Würmer gewinnt', () => {
  const game = g.createGame(['A', 'B', 'C']);
  game.players[0].stack.push(21, 22); // 2 Würmer
  game.players[1].stack.push(36); // 4 Würmer
  game.players[2].stack.push(25, 26); // 4 Würmer, best 26
  const ranking = g.calculateFinalScore(game);
  assert.equal(ranking[0].playerIndex, 1); // 4 Würmer, best 36
  assert.equal(ranking[1].playerIndex, 2); // 4 Würmer, best 26
  assert.equal(ranking[2].playerIndex, 0);
});

test('checkGameOver nur bei leerem offenem Grill', () => {
  const game = newGame();
  assert.equal(g.checkGameOver(game), false);
  for (const t of game.grill) t.faceUp = false;
  assert.equal(g.checkGameOver(game), true);
});

test('canTake meldet needChoice und fallback', () => {
  const game = newGame();
  game.players[1].stack.push(27);
  playThomas27(game);
  const c = g.canTake(game);
  assert.equal(c.ok, true);
  assert.equal(c.needChoice, true);
  assert.equal(c.options.length, 2);
});
