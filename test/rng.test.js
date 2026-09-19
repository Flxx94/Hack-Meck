'use strict';

/**
 * RNG-Überprüfung (Aufgabe §1–3): untersucht den Würfelzufall objektiv,
 * ohne die Spielregeln zu verändern.
 *
 * - 100.000 Einzelwürfel über den echten Produktionspfad
 *   (game.rollDice ohne injizierte Würfel → Math.random): Gleichverteilung?
 * - Mapping-Grenzen: Math.floor(rng()*6) → DICE_VALUES (kein Off-by-one)?
 * - BUST-Simulation mit echten Regeln (game.js + bots.js, normal-Bot):
 *   BUST-Rate, Würfe/Zug, Wurm-Rate, BUST-Gründe.
 *
 * Ergebnis (Stand Erstellung): RNG korrekt → keine Änderung an game.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../game');
const bots = require('../bots');

function newGame(names = ['A', 'B']) {
  const game = g.createGame(names);
  g.startGame(game);
  return game;
}

/** Deterministisches RNG (mulberry32) für reproduzierbare Teil-Checks. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 1. Verteilung über den Produktionspfad ----------

test('RNG: 100.000 Würfel sind annähernd gleichverteilt (1-5, Wurm)', () => {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, W: 0 };
  const TOTAL_DICE = 100000;
  const ROLLS = TOTAL_DICE / g.DICE_COUNT; // 12500 volle Erst-Würfe à 8 Würfel
  for (let i = 0; i < ROLLS; i++) {
    const game = newGame();
    // Produktionspfad: keine opts.dice → Math.random im Core.
    const { rolled } = g.rollDice(game);
    assert.equal(rolled.length, 8);
    for (const d of rolled) {
      assert.ok(g.DICE_VALUES.includes(d), `ungültiger Wert: ${d}`);
      counts[d]++;
    }
  }

  const expected = TOTAL_DICE / 6;
  // Chi-Quadrat (df=5): 99,9-%-Quantil ≈ 20,5 — großzügige Schranke 30 gegen Flakiness.
  let chi2 = 0;
  for (const v of g.DICE_VALUES) {
    chi2 += ((counts[v] - expected) ** 2) / expected;
    // Zusätzlich: jede Seite innerhalb ±4 % (bei 100k: σ≈118, ±4 % ≈ ±5,6σ).
    const lo = expected * 0.96;
    const hi = expected * 1.04;
    assert.ok(counts[v] >= lo && counts[v] <= hi, `${v}: ${counts[v]} außerhalb ±4 % von ${expected}`);
  }
  assert.ok(chi2 < 30, `Chi² zu hoch: ${chi2.toFixed(2)} (Verteilung: ${JSON.stringify(counts)})`);
  console.log(`    Verteilung (n=${TOTAL_DICE}): ${JSON.stringify(counts)} — Chi²=${chi2.toFixed(2)}`);
});

test('RNG: Wurm-Wahrscheinlichkeit ≈ 1/6', () => {
  const rng = mulberry32(12345);
  const N = 60000;
  let worms = 0;
  for (let i = 0; i < N; i++) {
    // Gleicher Mapping-Pfad wie randomDie(): floor(rng()*6).
    const d = g.DICE_VALUES[Math.floor(rng() * g.DICE_VALUES.length)];
    if (d === 'W') worms++;
  }
  const p = worms / N;
  assert.ok(Math.abs(p - 1 / 6) < 0.01, `Wurm-Anteil ${p} statt ~0,1667`);
  console.log(`    Wurm-Anteil (n=${N}, seed-RNG): ${(p * 100).toFixed(2)} %`);
});

test('RNG: kein Off-by-one — rng()=0 → erste Seite, rng()→1 → letzte Seite', () => {
  const first = g.DICE_VALUES[Math.floor(0 * 6)];
  const last = g.DICE_VALUES[Math.floor(0.999999999 * 6)];
  assert.equal(first, '1');
  assert.equal(last, 'W');
  // Alle 6 Seiten sind über den Wertebereich erreichbar (Bin-Mitten durch den echten Core-Pfad).
  for (let k = 0; k < 6; k++) {
    const gm = newGame();
    const { rolled } = g.rollDice(gm, { rng: () => (k + 0.5) / 6 });
    assert.deepEqual(rolled, Array(8).fill(g.DICE_VALUES[k]), `Bin ${k} → ${g.DICE_VALUES[k]}`);
  }
});

test('RNG: jeder Wurf würfelt neu — keine Wiederverwendung alter Werte', () => {
  const game = newGame();
  const seen = new Set();
  // 8er-Wurf, dann Pick, dann Rest-Wurf mit injiziertem Zähler-RNG.
  let calls = 0;
  const countingRng = () => {
    calls++;
    return Math.random();
  };
  g.rollDice(game, { rng: countingRng });
  assert.equal(calls, 8, 'Erst-Wurf muss genau 8× rng() aufrufen');
  const before = [...game.turn.rolled];
  g.pickValue(game, before[0]);
  const rest = g.remainingDice(game);
  calls = 0;
  g.rollDice(game, { rng: countingRng });
  assert.equal(calls, rest, `Folgewurf muss genau ${rest}× rng() aufrufen (nur Restwürfel)`);
  for (const r of game.turn.rolled) seen.add(r);
  assert.ok(seen.size >= 1);
});

test('RNG: Test-RNG und Produktions-RNG nutzen denselben Codepfad', () => {
  // Injizierter deterministischer RNG muss exakt abbildbar sein:
  // rng()=0 → immer '1'.
  const game = newGame();
  const { rolled } = g.rollDice(game, { rng: () => 0 });
  assert.deepEqual(rolled, Array(8).fill('1'));
  const game2 = newGame();
  const r2 = g.rollDice(game2, { rng: () => 0.999999 });
  assert.deepEqual(r2.rolled, Array(8).fill('W'));
});

// ---------- 2. BUST-Simulation mit echten Regeln ----------

test('BUST-Simulation: normal-Bot über 2000 Züge (echte game.js-Regeln)', () => {
  const TURNS = 2000;
  let busts = 0;
  let rolls = 0;
  const reasons = {};
  let totalPicks = 0;

  for (let i = 0; i < TURNS; i++) {
    const game = newGame();
    let turnRolls = 0;
    let result = null;
    for (let step = 0; step < 30; step++) {
      const phase = game.turn.phase;
      if (phase === 'pick') {
        const valid = g.validPickValues(game);
        assert.ok(valid.length > 0, 'pick-Phase ohne gültige Werte dürfte Auto-BUST gewesen sein');
        // Bereits gewählte Werte dürfen nie auswählbar sein.
        for (const p of game.turn.picked) assert.ok(!valid.includes(p), `gewählter Wert ${p} erneut angebbar`);
        totalPicks++;
        g.pickValue(game, bots.choosePick(game, 'normal', Math.random));
        continue;
      }
      if (phase === 'take') {
        const dec = bots.decideStop(game, 'normal', Math.random);
        result = g.takeTile(game, dec.choice);
        break;
      }
      // phase 'roll'
      if (game.turn.picked.length > 0) {
        const dec = bots.decideStop(game, 'normal', Math.random);
        if (dec.stop) {
          result = g.takeTile(game, dec.choice);
          break;
        }
      }
      const res = g.rollDice(game); // Produktions-RNG
      turnRolls++;
      if (res.bust) {
        result = res;
        break;
      }
    }
    assert.ok(result, 'Zug endete ohne Ergebnis');
    rolls += turnRolls;
    if (result && result.bust) {
      busts++;
      reasons[result.reason] = (reasons[result.reason] || 0) + 1;
    }
  }

  const bustRate = busts / TURNS;
  const avgRolls = rolls / TURNS;
  console.log(`    BUST-Simulation (normal, n=${TURNS}): bustRate=${(bustRate * 100).toFixed(1)} %, Ø Würfe/Zug=${avgRolls.toFixed(2)}, Gründe=${JSON.stringify(reasons)}`);
  // Plausibilitäts-Schranken (weit, nur gegen krasse Regel-/RNG-Fehler):
  // - BUST muss vorkommen, darf aber nicht dominieren (Bot spielt vorsichtig).
  assert.ok(bustRate > 0.02, `BUST zu selten (${bustRate}) — verdächtig`);
  assert.ok(bustRate < 0.7, `BUST zu häufig (${bustRate}) — verdächtig`);
  assert.ok(avgRolls >= 1 && avgRolls <= 6, `Ø Würfe ${avgRolls} unplausibel`);
  assert.ok(totalPicks > TURNS, 'zu wenige Picks');
});

test('BUST-Simulation: normal-Bot sichert den Wurm mehrheitlich', () => {
  const TURNS = 500;
  let withWormAtTake = 0;
  let takes = 0;
  for (let i = 0; i < TURNS; i++) {
    const game = newGame();
    for (let step = 0; step < 30; step++) {
      const phase = game.turn.phase;
      if (phase === 'pick') {
        g.pickValue(game, bots.choosePick(game, 'normal', Math.random));
        continue;
      }
      if (phase === 'take' || (phase === 'roll' && game.turn.picked.length > 0)) {
        if (phase === 'take' || bots.decideStop(game, 'normal', Math.random).stop) {
          if (g.hasWorm(game)) withWormAtTake++;
          takes++;
          break;
        }
      }
      const res = g.rollDice(game);
      if (res.bust) break; // Auto-BUST: kein Take
    }
  }
  const q = withWormAtTake / Math.max(1, takes);
  console.log(`    Wurm-Quote bei Take-Entscheidung: ${(q * 100).toFixed(1)} % (n=${takes})`);
  assert.ok(q > 0.8, `Wurm-Quote ${q} zu niedrig für normal-Bot`);
});
