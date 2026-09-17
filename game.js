'use strict';

/**
 * Heckmeck am Bratwurmeck – Game Core (Phase-1-Gerüst).
 *
 * Diese Datei enthält in Phase 1 nur Konstanten und reine Hilfsfunktionen.
 * Sie ist bewusst unabhängig von HTTP, WebSocket, DOM und Browser,
 * damit die komplette Spiellogik mit node:test getestet werden kann.
 *
 * Die vollständige Zug-Logik (rollDice, pickValue, bust, takeTile, ...)
 * folgt in Phase 2.
 */

const DICE_COUNT = 8;
const TILE_MIN = 21;
const TILE_MAX = 36;
const WORM_VALUE = 5;

// Würfelwerte: '1'..'5' und 'W' (Wurm). Wurm zählt 5 Punkte.
const DICE_VALUES = ['1', '2', '3', '4', '5', 'W'];

/**
 * Wurm-Anzahl einer Portion nach Standard-Verteilung (vom Nutzer bestätigt,
 * entspricht Originalspiel von Reiner Knizia):
 * 21–24 → 1, 25–28 → 2, 29–32 → 3, 33–36 → 4.
 */
function wormsForTile(value) {
  if (value >= 21 && value <= 24) return 1;
  if (value >= 25 && value <= 28) return 2;
  if (value >= 29 && value <= 32) return 3;
  if (value >= 33 && value <= 36) return 4;
  throw new RangeError(`Ungültiger Portionswert: ${value}`);
}

/** Punkte eines einzelnen Würfels (Wurm zählt 5). */
function dicePoints(value) {
  if (value === 'W') return WORM_VALUE;
  const n = Number(value);
  if (n >= 1 && n <= 5) return n;
  throw new RangeError(`Ungültiger Würfelwert: ${value}`);
}

/** Erzeugt den Grill: 16 Portionen 21–36, alle offen. */
function createGrill() {
  const grill = [];
  for (let value = TILE_MIN; value <= TILE_MAX; value++) {
    grill.push({ value, worms: wormsForTile(value), faceUp: true });
  }
  return grill;
}

module.exports = {
  DICE_COUNT,
  TILE_MIN,
  TILE_MAX,
  WORM_VALUE,
  DICE_VALUES,
  wormsForTile,
  dicePoints,
  createGrill,
};
