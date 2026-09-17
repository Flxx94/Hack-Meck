'use strict';

/**
 * Bot-System (Phase 6).
 *
 * Drei Schwierigkeitsstufen:
 * - easy: zufällige gültige Auswahl, einfache Stop-/Weiter-Entscheidung
 * - normal: sichert Würmer, greedy Auswahl, Punkte-/Risiko-Schwellen
 * - hard: Heuristik mit BUST-Risiko ((gewählte/6)^rest), Grill+Gegner,
 *   eigenem Punktestand, Restwürfeln und Portionswert
 *
 * Bots verändern den State niemals direkt, sondern nutzen dieselben
 * Game-Core-Funktionen wie menschliche Spieler (pickValue/takeTile/…).
 * Das ~800-ms-Timing zwischen Aktionen lebt auf Server-Ebene (Timer),
 * nicht hier. Alle Entscheidungen akzeptieren ein injizierbares `rng`
 * (Standard: Math.random) für deterministische Tests.
 */

const game = require('./game');

const DIFFICULTIES = ['easy', 'normal', 'hard'];

function normalizeDifficulty(difficulty) {
  return DIFFICULTIES.includes(difficulty) ? difficulty : 'normal';
}

/**
 * Exakte BUST-Wahrscheinlichkeit für den nächsten Wurf (faire Würfel):
 * Alle Restwürfel zeigen bereits gewählte Werte.
 * picked = Anzahl bereits gewählter Werte (0–5, Wurm zählt mit), rest = Restwürfel.
 */
function bustRisk(gameState) {
  const picked = gameState.turn.picked.length;
  const rest = game.remainingDice(gameState);
  if (rest <= 0 || picked <= 0) return 0;
  return Math.pow(picked / game.DICE_VALUES.length, rest);
}

/** Würfel-Häufigkeiten im aktuellen Wurf. */
function rollCounts(gameState) {
  const counts = {};
  for (const d of gameState.turn.rolled) counts[d] = (counts[d] || 0) + 1;
  return counts;
}

function pointsOf(value) {
  return game.dicePoints(value);
}

/**
 * Wählt einen Wert aus dem aktuellen Wurf (muss gültig sein).
 * @returns {string} einer aus validPickValues()
 */
function choosePick(gameState, difficulty = 'normal', rng = Math.random) {
  const level = normalizeDifficulty(difficulty);
  const valid = game.validPickValues(gameState);
  if (valid.length === 0) throw new Error('Keine gültige Auswahl möglich.');
  if (valid.length === 1) return valid[0];
  const counts = rollCounts(gameState);

  if (level === 'easy') {
    return valid[Math.floor(rng() * valid.length)];
  }

  // normal + hard sichern zuerst den Pflicht-Wurm.
  if (!game.hasWorm(gameState) && valid.includes('W')) return 'W';

  if (level === 'normal') {
    // Greedy: höchste Anzahl, Gleichstand → höhere Punkte.
    return [...valid].sort((a, b) => counts[b] - counts[a] || pointsOf(b) - pointsOf(a))[0];
  }

  // hard: Bei sicherem Punktestand Würfel schonen (kleinste Anzahl → geringeres
  // Folge-Risiko), sonst maximalen Erwartungswert (Anzahl × Punkte) sichern.
  const score = game.turnScore(gameState);
  if (game.hasWorm(gameState) && score >= 26) {
    return [...valid].sort((a, b) => counts[a] - counts[b] || pointsOf(a) - pointsOf(b))[0];
  }
  return [...valid].sort((a, b) => counts[b] * pointsOf(b) - counts[a] * pointsOf(a))[0];
}

/**
 * Wählt bei Grill+Gegner-Ambiguität (oder mehreren Gegnern) eine Option.
 * Stehlen ist strikt besser (eigener Gewinn + Gegner verliert Portion),
 * easy entscheidet zufällig.
 */
function chooseTakeOption(gameState, score, options, difficulty = 'normal', rng = Math.random) {
  const level = normalizeDifficulty(difficulty);
  if (!options || options.length === 0) return undefined;
  if (options.length === 1) return options[0];
  if (level === 'easy') return options[Math.floor(rng() * options.length)];
  const steals = options.filter((o) => o.source === 'steal');
  if (steals.length === 0) return options[0];
  if (level === 'normal') return steals[0];
  // hard: vom führenden Gegner stehlen (meiste Würmer).
  let best = steals[0];
  let bestWorms = -1;
  for (const s of steals) {
    const w = game.playerWorms(gameState, s.fromPlayer);
    if (w > bestWorms) {
      bestWorms = w;
      best = s;
    }
  }
  return best;
}

/**
 * Stop- oder Weiter-Entscheidung (Phase `roll` nach Pick, oder `take`).
 * @returns {{stop: boolean, choice?: object}}
 */
function decideStop(gameState, difficulty = 'normal', rng = Math.random) {
  const level = normalizeDifficulty(difficulty);
  const score = game.turnScore(gameState);
  const worm = game.hasWorm(gameState);
  const rem = game.remainingDice(gameState);
  const phase = gameState.turn.phase;
  const ct = game.canTake(gameState);
  const choice = ct.needChoice
    ? chooseTakeOption(gameState, score, ct.options, level, rng)
    : undefined;

  // Alle Würfel beiseite: Zug muss beendet werden (ggf. BUST per Regel).
  if (phase === 'take' || rem <= 0) return { stop: true, choice };
  if (gameState.turn.picked.length === 0) return { stop: false };
  // Ohne Wurm würde das Beenden fehlschlagen → weiterwürfeln.
  if (!worm) return { stop: false };

  const risk = bustRisk(gameState);
  const exact = ct.ok && !ct.fallback && !ct.needChoice;

  if (level === 'easy') {
    return { stop: score >= 21 && rng() < 0.35, choice };
  }

  if (level === 'normal') {
    // Schwelle sinkt mit schwindenden Restwürfeln (wenig Würfel = viel Risiko).
    // Exakte Treffer und Steals werden früh gesichert, Hochwertiges immer.
    if (score >= 31) return { stop: true, choice };
    if (ct.needChoice && score >= 22) return { stop: true, choice };
    if (exact && score >= 24) return { stop: true, choice };
    if (risk > 0.6) return { stop: true, choice };
    if (score >= 21 + rem) return { stop: true, choice };
    return { stop: false };
  }

  // hard: BUST-Risiko gegen Portionswert abwägen.
  if (score >= 30) return { stop: true, choice };
  if (ct.needChoice) return { stop: true, choice }; // exakter Treffer + Wahlrecht sichern
  if (exact) {
    if (score >= 27 || risk > 0.2) return { stop: true, choice };
    return { stop: false };
  }
  // Nur nächstniedrigere machbar: niedrige Portion bei kleinem Risiko verbessern.
  if (risk > 0.45) return { stop: true, choice };
  if (score >= 24 && risk > 0.25) return { stop: true, choice };
  if (score >= 21 && rem <= 1) return { stop: true, choice };
  return { stop: false };
}

/**
 * Spielt einen kompletten Bot-Zug über die öffentliche Game-Core-API.
 * Für Tests und Simulationen (der Server nutzt schrittweise Aktionen mit Timer).
 * @returns Ergebnis von takeTile/bust (ggf. mit gameOver/ranking).
 */
function playBotTurn(gameState, difficulty = 'normal', rng = Math.random) {
  const level = normalizeDifficulty(difficulty);
  for (let i = 0; i < 30; i++) {
    const phase = gameState.turn.phase;
    if (phase === 'pick') {
      game.pickValue(gameState, choosePick(gameState, level, rng));
      continue;
    }
    if (phase === 'take') {
      const dec = decideStop(gameState, level, rng);
      return game.takeTile(gameState, dec.choice);
    }
    // phase 'roll'
    if (gameState.turn.picked.length > 0) {
      const dec = decideStop(gameState, level, rng);
      if (dec.stop) return game.takeTile(gameState, dec.choice);
    }
    const res = game.rollDice(gameState, { rng });
    if (res.bust) return res; // Auto-BUST (nur gewählte Werte)
  }
  throw new Error('Bot-Zug hängt (30 Schritte überschritten).');
}

/** Kompatibilitäts-Alias (Phase-1-Stub-Signatur): eine Pick-Entscheidung. */
function chooseBotMove(gameState, difficulty = 'normal') {
  return choosePick(gameState, difficulty, Math.random);
}

module.exports = {
  DIFFICULTIES,
  bustRisk,
  choosePick,
  chooseTakeOption,
  decideStop,
  playBotTurn,
  chooseBotMove,
};
