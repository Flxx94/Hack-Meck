'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DICE_COUNT, DICE_VALUES, WORM_VALUE, wormsForTile, dicePoints, createGrill } = require('../game');

test('Phase 1: 8 Würfel mit Werten 1–5 und Wurm', () => {
  assert.equal(DICE_COUNT, 8);
  assert.deepEqual([...DICE_VALUES].sort(), ['1', '2', '3', '4', '5', 'W']);
});

test('Phase 1: Wurm zählt 5 Punkte', () => {
  assert.equal(WORM_VALUE, 5);
  assert.equal(dicePoints('W'), 5);
  assert.equal(dicePoints('4'), 4);
});

test('Phase 1: Grill hat 16 Portionen 21–36 mit Standard-Wurmverteilung', () => {
  const grill = createGrill();
  assert.equal(grill.length, 16);
  assert.equal(grill[0].value, 21);
  assert.equal(grill[15].value, 36);
  assert.ok(grill.every((t) => t.faceUp === true));
  assert.equal(wormsForTile(21), 1);
  assert.equal(wormsForTile(24), 1);
  assert.equal(wormsForTile(25), 2);
  assert.equal(wormsForTile(28), 2);
  assert.equal(wormsForTile(29), 3);
  assert.equal(wormsForTile(32), 3);
  assert.equal(wormsForTile(33), 4);
  assert.equal(wormsForTile(36), 4);
});
