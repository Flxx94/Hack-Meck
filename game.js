'use strict';

/**
 * Heckmeck am Bratwurmeck – Game Core (Phase 2).
 *
 * Reine Spiellogik, unabhängig von HTTP, WebSocket, DOM und Browser.
 * Der Server ist die einzige Quelle der Wahrheit und ruft nur diese API auf;
 * Bots nutzen dieselben Funktionen wie menschliche Spieler.
 *
 * Regeln (Quelle: Spielanleitung, siehe AGENTS.md):
 * - 8 Würfel (1–5 + Wurm, Wurm = 5 Punkte), 16 Portionen 21–36
 * - Pro Wurf genau ein noch nicht gewählter Wert, alle Würfel dieses Werts beiseitelegen
 * - Freiwilliges Beenden jederzeit, aber mind. 1 Wurm nötig
 * - Exakt auf Grill → nehmen; exakt oben auf Gegnerstapel → stehlen;
 *   liegt beides gleichzeitig vor, wählt der Spieler (needChoice)
 * - Sonst nächstniedrigere offene Grillportion; keine niedrigere → Fehlwurf
 * - Fehlwurf: oberste eigene Portion zurück auf Grill + höchste offene
 *   Grillportion umdrehen (Sonderfälle beachten), idempotent
 * - Ende: keine offene Grillportion; meiste Würmer gewinnt,
 *   Gleichstand → höchste Einzelportion
 */

const DICE_COUNT = 8;
const TILE_MIN = 21;
const TILE_MAX = 36;
const WORM_VALUE = 5;

// Würfelwerte: '1'..'5' und 'W' (Wurm).
const DICE_VALUES = ['1', '2', '3', '4', '5', 'W'];

/**
 * Wurm-Anzahl einer Portion (Original-Verteilung, nutzerbestätigt):
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
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
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

function assertValidDiceValue(value) {
  if (!DICE_VALUES.includes(value)) throw new RangeError(`Ungültiger Würfelwert: ${value}`);
}

/** Neues Spiel mit Spielernamen anlegen (2–7 Spieler). Zug läuft noch nicht. */
function createGame(playerNames) {
  if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 7) {
    throw new RangeError('Es werden 2–7 Spieler benötigt.');
  }
  return {
    grill: createGrill(),
    players: playerNames.map((name, i) => ({
      id: `p${i}`,
      name: String(name),
      stack: [],
      isBot: false,
      connected: true,
    })),
    currentPlayer: 0,
    turn: freshTurn(),
    over: false,
    winner: null,
    ranking: [],
  };
}

function freshTurn() {
  return {
    active: false,
    rolled: [],
    setAside: {},
    picked: [],
    phase: 'roll', // roll → pick → (roll | take)
    over: false,
    bust: false,
    result: null,
  };
}

/** Spiel starten: erster Spieler beginnt. */
function startGame(game) {
  assertRunning(game);
  if (game.turn.active) throw new Error('Spiel läuft bereits.');
  game.currentPlayer = 0;
  game.turn = freshTurn();
  game.turn.active = true;
  game.over = false;
  game.winner = null;
  game.ranking = [];
  return game;
}

function assertRunning(game) {
  if (!game || !Array.isArray(game.players) || game.players.length === 0) {
    throw new Error('Ungültiger Spielstand.');
  }
  if (game.over) throw new Error('Spiel ist bereits beendet.');
}

function assertTurnActive(game) {
  assertRunning(game);
  if (!game.turn || !game.turn.active || game.turn.over) {
    throw new Error('Kein aktiver Zug.');
  }
}

/** Anzahl bereits beiseitegelegter Würfel. */
function setAsideCount(game) {
  return Object.values(game.turn.setAside).reduce((a, n) => a + n, 0);
}

/** Anzahl übriger Würfel für den nächsten Wurf. */
function remainingDice(game) {
  return DICE_COUNT - setAsideCount(game);
}

/** Summe aller beiseitegelegten Würfel (Wurm = 5). */
function turnScore(game) {
  let sum = 0;
  for (const [value, n] of Object.entries(game.turn.setAside)) {
    sum += dicePoints(value) * n;
  }
  return sum;
}

/** Wurde mindestens ein Wurm beiseitegelegt? */
function hasWorm(game) {
  return (game.turn.setAside.W || 0) > 0;
}

function randomDie(rng) {
  return DICE_VALUES[Math.floor(rng() * DICE_VALUES.length)];
}

/**
 * Würfeln. `opts.dice` (Array) setzt Würfel direkt (Tests),
 * `opts.rng` ist die Zufallsfunktion (Standard: Math.random).
 * Gibt { rolled } zurück oder { bust: true, ... } bei Auto-BUST
 * (nur bereits gewählte Werte gewürfelt).
 */
function rollDice(game, opts = {}) {
  assertTurnActive(game);
  const rest = remainingDice(game);
  if (rest <= 0) throw new Error('Keine Würfel mehr übrig – Zug muss beendet werden.');
  if (game.turn.phase !== 'roll') throw new Error('Jetzt darf nicht gewürfelt werden (erst wählen).');

  let rolled;
  if (opts.dice !== undefined) {
    if (!Array.isArray(opts.dice) || opts.dice.length !== rest) {
      throw new RangeError(`Es müssen genau ${rest} Würfel vorgegeben werden.`);
    }
    rolled = [...opts.dice];
    for (const v of rolled) assertValidDiceValue(v);
  } else {
    const rng = opts.rng || Math.random;
    rolled = Array.from({ length: rest }, () => randomDie(rng));
  }

  game.turn.rolled = rolled;
  game.turn.phase = 'pick';

  // Fall B: ausschließlich bereits gewählte Werte → automatischer Fehlwurf.
  if (validPickValues(game).length === 0) {
    const res = bust(game, 'only-picked-values');
    return { bust: true, ...res };
  }
  return { rolled: [...rolled] };
}

/** Noch nicht gewählte Werte aus dem aktuellen Wurf. */
function validPickValues(game) {
  if (!game.turn || !Array.isArray(game.turn.rolled)) return [];
  const picked = new Set(game.turn.picked);
  return [...new Set(game.turn.rolled)].filter((v) => !picked.has(v));
}

/** Darf dieser Wert jetzt gewählt werden? */
function canPick(game, value) {
  try {
    assertTurnActive(game);
  } catch {
    return false;
  }
  if (game.turn.phase !== 'pick') return false;
  if (!DICE_VALUES.includes(value)) return false;
  if (game.turn.picked.includes(value)) return false;
  return game.turn.rolled.includes(value);
}

/**
 * Wert auswählen: alle Würfel dieses Werts werden beiseitegelegt.
 * Danach weiterwürfeln (phase roll) oder – wenn alle 8 beiseite – beenden (phase take).
 */
function pickValue(game, value) {
  assertTurnActive(game);
  if (!canPick(game, value)) {
    throw new Error(`Wert ${value} darf nicht gewählt werden (nicht gewürfelt oder bereits gewählt).`);
  }
  const n = game.turn.rolled.filter((d) => d === value).length;
  game.turn.setAside[value] = (game.turn.setAside[value] || 0) + n;
  game.turn.picked.push(value);
  game.turn.rolled = [];
  game.turn.phase = remainingDice(game) <= 0 ? 'take' : 'roll';
  return { picked: value, count: n, score: turnScore(game), phase: game.turn.phase };
}

/** Offene Grillportion mit exaktem Wert (oder null). */
function findGrillTile(game, value) {
  return game.grill.find((t) => t.faceUp && t.value === value) || null;
}

/** Gegner-Indizes, deren oberste Stapelportion exakt passt. */
function findStealSources(game, value) {
  const out = [];
  game.players.forEach((p, i) => {
    if (i === game.currentPlayer) return;
    const top = p.stack[p.stack.length - 1];
    if (top === value) out.push(i);
  });
  return out;
}

/** Höchste offene Grillportion unterhalb eines Werts (oder null). */
function findLowerTile(game, score) {
  let best = null;
  for (const t of game.grill) {
    if (t.faceUp && t.value < score && (!best || t.value > best.value)) best = t;
  }
  return best;
}

/** Höchste offene Grillportion überhaupt (oder null). */
function highestOpenTile(game) {
  let best = null;
  for (const t of game.grill) {
    if (t.faceUp && (!best || t.value > best.value)) best = t;
  }
  return best;
}

/**
 * Prüft, ob der Zug erfolgreich beendet werden kann.
 * { ok } oder { ok:false, reason } oder { ok:true, needChoice, options }.
 */
function canTake(game) {
  try {
    assertTurnActive(game);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (game.turn.picked.length === 0) return { ok: false, reason: 'Noch nichts gewählt.' };
  if (!hasWorm(game)) return { ok: false, reason: 'Mindestens ein Wurm ist nötig.' };
  const score = turnScore(game);
  const grill = findGrillTile(game, score);
  const steals = findStealSources(game, score);
  if (grill && steals.length > 0) {
    return { ok: true, needChoice: true, options: [{ source: 'grill', value: score }, ...steals.map((i) => ({ source: 'steal', value: score, fromPlayer: i }))] };
  }
  if (grill || steals.length > 0) return { ok: true };
  if (findLowerTile(game, score)) return { ok: true, fallback: true };
  return { ok: false, reason: 'Keine passende oder niedrigere Portion verfügbar.' };
}

/**
 * Zug freiwillig beenden (= Portion nehmen). Entspricht endTurn().
 * Bei Grill+Gegner-Ambiguität ohne choice → { needChoice:true, options },
 * kein State wird verändert. choice: { source:'grill' } oder { source:'steal', fromPlayer }.
 */
function takeTile(game, choice) {
  assertTurnActive(game);
  // Normaler Stop: nach einem Pick, vor dem nächsten Wurf (phase 'roll'),
  // oder wenn alle 8 Würfel beiseite liegen (phase 'take').
  // In phase 'pick' liegt ein unverwerteter Wurf vor – erst wählen (oder Auto-BUST).
  if (game.turn.phase !== 'roll' && game.turn.phase !== 'take') {
    throw new Error('Erst einen Wert aus dem Wurf wählen, dann beenden.');
  }
  if (game.turn.picked.length === 0) return bust(game, 'no-pick');
  if (!hasWorm(game)) return bust(game, 'no-worm');

  const score = turnScore(game);
  const grill = findGrillTile(game, score);
  const steals = findStealSources(game, score);

  if (grill && steals.length > 0 && !choice) {
    return { needChoice: true, score, options: [{ source: 'grill', value: score }, ...steals.map((i) => ({ source: 'steal', value: score, fromPlayer: i }))] };
  }

  if (grill && (steals.length === 0 || (choice && choice.source === 'grill'))) {
    grill.faceUp = false;
    currentPlayer(game).stack.push(grill.value);
    return finishTake(game, { type: 'grill', value: grill.value, score });
  }

  const stealFrom = choice && choice.source === 'steal' ? choice.fromPlayer : steals.length === 1 ? steals[0] : null;
  if ((steals.length > 0 && !choice && steals.length === 1) || (choice && choice.source === 'steal')) {
    return stealTile(game, stealFrom, score);
  }
  if (grill) {
    grill.faceUp = false;
    currentPlayer(game).stack.push(grill.value);
    return finishTake(game, { type: 'grill', value: grill.value, score });
  }
  if (steals.length > 1 && !choice) {
    // Mehrere Gegner mit gleicher oberster Portion: Spieler wählt den Gegner.
    return { needChoice: true, score, options: steals.map((i) => ({ source: 'steal', value: score, fromPlayer: i })) };
  }

  const lower = findLowerTile(game, score);
  if (lower) {
    lower.faceUp = false;
    currentPlayer(game).stack.push(lower.value);
    return finishTake(game, { type: 'lower', value: lower.value, score });
  }
  return bust(game, 'no-lower');
}

/** Alias für freiwilliges Beenden (Aufgaben-API: endTurn). */
function endTurn(game, choice) {
  return takeTile(game, choice);
}

/**
 * Oberste Gegnerportion exakt stehlen (kann direkt oder via takeTile aufgerufen werden).
 */
function stealTile(game, fromPlayerIndex, expectedScore) {
  assertTurnActive(game);
  const score = expectedScore !== undefined ? expectedScore : turnScore(game);
  if (!hasWorm(game)) return bust(game, 'no-worm');
  const from = game.players[fromPlayerIndex];
  if (!from || fromPlayerIndex === game.currentPlayer) throw new Error('Ungültiges Stehlziel.');
  const top = from.stack[from.stack.length - 1];
  if (top !== score) throw new Error('Diese Portion liegt dort nicht oben.');
  from.stack.pop();
  currentPlayer(game).stack.push(top);
  return finishTake(game, { type: 'steal', value: top, score, fromPlayer: fromPlayerIndex });
}

function currentPlayer(game) {
  return game.players[game.currentPlayer];
}

function finishTake(game, result) {
  game.turn.over = true;
  game.turn.result = result;
  if (checkGameOver(game)) {
    return finishGame(game, result);
  }
  nextTurn(game);
  return { ...result, turnEnded: true };
}

/**
 * Zentraler Fehlwurf. Idempotent: ein bereits abgeschlossener Zug wird
 * nicht erneut verändert ({ alreadyOver:true }).
 */
function bust(game, reason = 'bust') {
  if (!game.turn || !game.turn.active) throw new Error('Kein aktiver Zug.');
  if (game.turn.over) return { bust: true, alreadyOver: true, reason: game.turn.result?.reason || reason };
  game.turn.over = true;
  game.turn.bust = true;

  const me = currentPlayer(game);
  let returned = null;
  if (me.stack.length > 0) {
    returned = me.stack.pop();
    const tile = game.grill.find((t) => t.value === returned);
    if (tile) tile.faceUp = true;
  }

  // Höchste noch offene Grillportion umdrehen – mit Sonderfällen:
  // - ohne eigene Rücklage: nichts umdrehen
  // - zurückgelegte ist danach die höchste offene: bleibt offen, nichts umdrehen
  let flipped = null;
  if (returned !== null) {
    const highest = highestOpenTile(game);
    if (highest && highest.value !== returned) {
      highest.faceUp = false;
      flipped = highest.value;
    }
  }

  const result = { bust: true, reason, returned, flipped };
  game.turn.result = result;
  if (checkGameOver(game)) {
    return { ...finishGame(game, result), ...result };
  }
  nextTurn(game);
  return { ...result, turnEnded: true };
}

function nextTurn(game) {
  game.currentPlayer = (game.currentPlayer + 1) % game.players.length;
  game.turn = freshTurn();
  game.turn.active = true;
}

/** Spiel endet, sobald keine offene Grillportion mehr liegt. */
function checkGameOver(game) {
  return !game.grill.some((t) => t.faceUp);
}

/** Würmer eines Spielers (Summe über Stapelportionen). */
function playerWorms(game, playerIndex) {
  return game.players[playerIndex].stack.reduce((a, v) => a + wormsForTile(v), 0);
}

/** Wertvollste Einzelportion eines Spielers (0 bei leerem Stapel). */
function playerBestTile(game, playerIndex) {
  const s = game.players[playerIndex].stack;
  return s.length ? Math.max(...s) : 0;
}

/** Schlusswertung: Rangliste (Würmer desc, dann höchste Einzelportion desc). */
function calculateFinalScore(game) {
  const rows = game.players.map((p, i) => ({
    playerIndex: i,
    id: p.id,
    name: p.name,
    worms: playerWorms(game, i),
    bestTile: playerBestTile(game, i),
    tiles: p.stack.length,
  }));
  rows.sort((a, b) => b.worms - a.worms || b.bestTile - a.bestTile);
  return rows;
}

function finishGame(game, lastResult) {
  game.over = true;
  game.ranking = calculateFinalScore(game);
  game.winner = game.ranking.length ? game.ranking[0].playerIndex : null;
  game.turn.active = false;
  return { ...lastResult, gameOver: true, ranking: game.ranking, winner: game.winner };
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
  createGame,
  startGame,
  rollDice,
  canPick,
  pickValue,
  validPickValues,
  turnScore,
  hasWorm,
  remainingDice,
  setAsideCount,
  canTake,
  takeTile,
  endTurn,
  stealTile,
  bust,
  checkGameOver,
  calculateFinalScore,
  playerWorms,
  playerBestTile,
};
