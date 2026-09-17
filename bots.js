'use strict';

/**
 * Bot-System (Phase-1-Stub).
 *
 * Drei Schwierigkeitsstufen sind geplant:
 * - easy: zufällige gültige Auswahl, einfache Stop-Entscheidung
 * - normal: berücksichtigt Würmer, Punkte, Portionen, Risiko, Restwürfel
 * - hard: Heuristik mit Erwartungswert, BUST-Risiko, Grill + Gegner, Restwürfel
 *
 * Bots dürfen den Game State niemals direkt verändern, sondern nutzen
 * dieselben Game-Core-Funktionen wie menschliche Spieler.
 * Die ~800ms Verzögerung wird erst auf Server-Ebene (Timer) umgesetzt,
 * nicht in der Core-Logik. Implementierung folgt in Phase 6.
 */

const DIFFICULTIES = ['easy', 'normal', 'hard'];

function chooseBotMove(gameState, difficulty) {
  throw new Error(`Bot-System noch nicht implementiert (Phase 6, difficulty=${difficulty})`);
}

module.exports = { DIFFICULTIES, chooseBotMove };
