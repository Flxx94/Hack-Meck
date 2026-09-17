# AGENTS.md – Hack-Meck (dauerhafter Projektkontext)

> Pflichtdatei: nach jeder größeren Phase aktualisieren. Lesesprache: Deutsch.

## Ziel
Webbasiertes Multiplayer-Würfelspiel „Heckmeck am Bratwurmeck" (Reiner Knizia / Zoch),
spielbar gegen Bots und gegen andere Spieler im gleichen lokalen WLAN.
Server-authoritative, Vanilla JS/CSS/HTML, kein Build-System.

## Architektur
```text
Browser (public/index.html, style.css, app.js)
  ↕ WebSocket (JSON, ws, gleicher Host:Port)
server.js (HTTP statisch + Räume + Validierung, einzige Quelle der Wahrheit)
  ↕ ruft auf
game.js (reine Spiellogik, kein HTTP/WS/DOM – voll testbar)
bots.js (nutzt nur öffentliche game.js-API, ~800ms Timer auf Server-Ebene)
```

## Technologien
- Node.js 24 (geprüft: v24.11.0), npm 11.6.1
- `ws` für WebSockets, `node:test` + `node:assert/strict` für Tests
- Kein React, kein TypeScript, kein Build-System

## Spielregeln (Quelle: „Heckmeck am Bratwurmeck Spielanleitung.pdf", lokal, nicht committet)
Regel-PDF wurde am 17.09.2026 vollständig gelesen (deutscher Teil S. 1–6, Beispiele Thomas/Birgit).
Die PDF liegt bewusst NICHT im Git (`.gitignore: *.pdf`, 2,2 MB Binary).

- 2–7 Spieler, 16 Portionen 21–36, 8 Würfel (1–5 + Wurm), Wurm = 5 Punkte
- Wurmverteilung (nutzerbestätigt, Original): 21–24→1, 25–28→2, 29–32→3, 33–36→4
- Pro Wurf genau ein noch nicht gewählter Wert; alle Würfel dieses Werts beiseitelegen
- Bereits gewählte Werte dürfen im gleichen Zug nicht erneut gewählt werden (gilt auch für Wurm)
- Zug kann jederzeit freiwillig beendet werden; mind. 1 Wurm nötig, sonst Fehlwurf
- Exakt passend + auf Grill → nehmen; exakt + oben auf Gegnerstapel → stehlen
- **Entscheidung: liegt der exakte Wert gleichzeitig auf Grill UND Gegnerstapel, wählt der Spieler** (Server validiert beide, Client bietet Wahl an)
- Sonst: nächstniedrigere verfügbare Grillportion nehmen; keine niedrigere → Fehlwurf
- Fehlwurf: leer ausgehen + oberste eigene Portion zurück auf Grill (falls vorhanden) + höchste noch offene Grillportion umdrehen, AUSSER: zurückgelegte ist danach höchste → bleibt offen, nichts umdrehen; ohne eigene Portion → nichts umdrehen
- Spielende: keine offene Grillportion mehr; meiste Würmer gewinnt; Gleichstand → wertvollste einzelne Portion (höchster Zahlenwert)
- Validiert an PDF-Beispielen: Thomas (4/4/4=12 → Wurm=17 → 5er=27 → 3 → 2 = 32, steal von Anika), Birgit (3er+5er+Wurm=26 → 3+Wurm erneut = Fehlwurf + Rücklage + Umdrehen)

## Game-State-Struktur (Plan, final ab Phase 2)
```js
{
  grill: [{ value: 21, worms: 1, faceUp: true }, ...], // 16 Einträge
  players: [{ id, name, stack: [21, ...], isBot, connected }], // stack: unten→oben, oben = sichtbar
  turn: { playerIndex, rolled: [], setAside: { '1': n, ..., 'W': n }, picked: [], phase: 'roll|pick|take', over: bool },
  winner / ranking am Ende
}
```

## WebSocket-Protokoll (final, implementiert Phase 4)
Client → Server (JSON, Feld `t`): `create {name}, join {code,name}, rejoin {code,token}, addBot {difficulty?}, start, roll, pick {value}, take {choice?}, stop`
Server → Client: `WELCOME, JOINED {code,playerId,token}, REJOINED, PLAYER_JOINED, PLAYER_LEFT, GAME_STARTED, TURN_STARTED {playerId}, DICE_ROLLED {rolled}, DICE_SELECTED, BUST, TILE_TAKEN, TURN_ENDED, GAME_OVER {ranking,winner}, NEED_CHOICE {score,options} (nur an Entscheider), STATE (Voll-State nach jeder Mutation), ERROR {message}`.
`STATE` enthält `code, status, players[], game{grill, players, currentPlayer(Id), turn{phase,rolled,setAside,picked,score,hasWorm,validPicks,remaining,over}, over, winner, ranking}`.

## Serverlogik (implementiert Phase 4)
- Einzige Quelle der Wahrheit: Würfel, Punkte, Reihenfolge, Grill, Besitz, BUST, Ende, Gewinner (alles via game.js; `game.js`-Errors → `ERROR`-Nachricht)
- Jede Aktion validiert: Raum? Spieler bekannt? Lobby vs. laufend? aktueller Spieler? Bots spielen automatisch (Aktionen abgelehnt)
- `stop/take` ohne Pick → `ERROR` (kein BUST durch Fehlklick); `take` ohne Wahl bei Ambiguität → `NEED_CHOICE` nur an Entscheider (kein State-Wechsel)
- Reconnect via `reconnectToken` (5 Min, `tokenExpiry` bei Disconnect), 60 s Schutz im eigenen Zug → danach Bot-Ersatz (`(Bot)`-Suffix, `syncGamePlayers`), nie blockieren; leere Räume mit abgelaufenen Tokens werden minütlich gelöscht
- Raumcode: 4-stellig, `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (ohne I/O/0/1); Export `createHeckMeckServer(port,host)` für Tests, Direktstart lauscht `0.0.0.0:3000`

## Bot-System (implementiert Phase 6)
- `bots.js` (reine Entscheidungen, `rng` injizierbar): `choosePick` (easy zufällig / normal+hard sichern Wurm zuerst, normal greedy nach Anzahl, hard bei ≥26 Würfel-schonend sonst max. Anzahl×Punkte), `decideStop` (easy 35%-Stopp ab 21 / normal Schwelle `21+Restwürfel` + exakte/Steals früh sichern + Risiko>0,6 / hard BUST-Risiko vs. Portionswert, Stopp ab 30, needChoice immer sichern), `chooseTakeOption` (easy zufällig, normal+hard stehlen, hard vom Führenden), `bustRisk=(gewählte/6)^rest`, `playBotTurn` (kompletter Zug für Tests/Simulation).
- Server-Engine: `scheduleBot/botStep` – genau ein Timer pro Raum, ~800 ms zwischen Aktionen, Mensch+Bot teilen `performRoll/performPick/performTake`; Bot-Crash führt nie zum Spiel-Crash (Fallback: Zug sicher beenden). Trigger: nach `start`, jeder Aktion, 60-s-Bot-Ersatz. `close()` räumt alle Timer weg.
- Nur via Game-Core-API, nie direkte State-Manipulation.

## Designentscheidungen
- CommonJS (keine ESM-Risiken mit ws + node:test)
- PDF aus Git ausgeschlossen (Binary), Regeln hier + in Tests dokumentiert
- Branch `main` (remote hatte `main` mit 1 Commit; lokales leeres `master` verworfen)
- Repo-Name `Hack-Meck` (GitHub) vs. Ordner `Heck_Meck` beibehalten, nicht umbenannt
- `takeTile/endTurn` nur in Phase `roll` (nach Pick, vor nächstem Wurf = normaler Stop) und `take` (alle 8 beiseite); in Phase `pick` muss erst der Wurf verwertet werden. Fix am 17.09.2026: 11 Tests fanden falschen Phasen-Guard (`pick|take` statt `roll|take`).
- `rollDice(game, {dice, rng})`: Würfel injizierbar (deterministische Tests), Standard `Math.random`
- Ungültige Aktionen werfen `Error` (Server mappt auf `ERROR`-Nachricht); `bust()` ist idempotent (`alreadyOver`), `takeTile` bei Grill+Gegner-Ambiguität ohne Wahl verändert nichts (`needChoice`)

## Aktuelle Implementierung (Phase 6)
- `game.js`: Voll-Core (unverändert seit Phase 3, 29 Tests grün).
- `server.js`: + Bot-Engine (`scheduleBot/botStep`, `perform*`-Refaktor, Timer-Cleanup in `close()`); Rest unverändert (Räume, Protokoll, Reconnect).
- `bots.js`: voll implementiert (s. Bot-System); `chooseBotMove` als Alias erhalten.
- `test/bots.test.js`: 15 Tests – Pick-Gültigkeit (Fuzz), kein Doppel-Pick, Wurm-Sicherung, easy-Zufall, Weiter ohne Wurm, Pflicht-Stopp, hard-vs-easy-Tendenz, bustRisk-Formel, Nehmen+Zugende, Stehlen (hard vom Führenden), TakeOption-Stufen, BUST-Verträglichkeit, volle Spiele je Stufe + normal-vs-hard, WS-Integration (Bot würfelt/beendet automatisch).
- `npm test` läuft seriell (`--test-concurrency=1`): parallele WS-Suite hing (17.09.2026, >120 s ohne Ergebnis); seriell ~9 s stabil.
- `public/*` weiter Minimal-Shell (UI folgt Phase 7).

## Fortschritt
### Abgeschlossen
- [x] Projektstruktur (Phase 1)
- [x] Game Core (Phase 2)
- [x] Game-Core-Tests (Phase 3)
- [x] Multiplayer (Phase 4)
- [x] Multiplayer-Tests (Phase 5)
- [x] Bots (Phase 6)
- [ ] UI (Phase 7)
- [ ] Integrationstests (Phase 8)
- [ ] LAN-Test (Phase 9)
### Aktuell
Phase 6 abgeschlossen (55/55 Tests grün). Nächster Schritt: Phase 7 UI.
### Bekannte Probleme
Keine.
### Offene Aufgaben
Phasen 4–9 gemäß Aufgabe.

## Wichtige Tests
`npm test` (node --test test/). Phase-1-Smoke: Würfel/Wurm/Grill. Ab Phase 3: alle Edge Cases (nur gewählte Werte → Auto-BUST, Wurm doppelt → BUST, BUST ohne eigene Portion, höchste-zurückgelegt-Sonderfall, nächstniedrigere, keine-niedrigere → BUST, Steal, Spielende, Gleichstand).

## Startbefehle
```bash
npm install
npm start   # http://localhost:3000 + LAN-IPs werden geloggt
npm test
```

## LAN-Nutzung
Server lauscht `0.0.0.0:3000`; im WLAN `http://<LAN-IP>:3000` öffnen; WebSocket nutzt automatisch gleichen Host/Port.

## Technische Einschränkungen
- Max. 7 Spieler pro Raum; 4-stelliger alphanumerischer Raumcode
- Keine externen Dienste nach `npm install` nötig
- Touch-Targets ≥ 44×44 px (Phase 7)
