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

## WebSocket-Protokoll (Plan, final ab Phase 4)
Client → Server: `create, join, addBot, start, roll, pick {value}, take {choice?}, stop, rejoin {token}`
Server → Client: `PLAYER_JOINED, PLAYER_LEFT, GAME_STARTED, TURN_STARTED, DICE_ROLLED, DICE_SELECTED, BUST, TILE_TAKEN, TURN_ENDED, GAME_OVER, ERROR` + Voll-State nach jeder Mutation.
Phase 1: nur `WELCOME` + `ECHO`.

## Serverlogik (Plan)
- Einzige Quelle der Wahrheit: Würfel, Punkte, Reihenfolge, Grill, Besitz, BUST, Ende, Gewinner
- Jede Aktion validieren: am Zug? Phase ok? Wert wählbar/nicht doppelt? Portion vorhanden/nehmbar?
- Reconnect via `reconnectToken` (5 Min), 60 s Schutz im eigenen Zug → danach Bot-Ersatz, nie blockieren

## Bot-System (Plan ab Phase 6)
easy (zufällig), normal (Würmer/Punkte/Portionen/Risiko/Restwürfel), hard (Erwartungswert, BUST-Risiko, Grill+Gegner, Restwürfel). Nur via Game-Core-API, 800 ms Timer serverseitig.

## Designentscheidungen
- CommonJS (keine ESM-Risiken mit ws + node:test)
- PDF aus Git ausgeschlossen (Binary), Regeln hier + in Tests dokumentiert
- Branch `main` (remote hatte `main` mit 1 Commit; lokales leeres `master` verworfen)
- Repo-Name `Hack-Meck` (GitHub) vs. Ordner `Heck_Meck` beibehalten, nicht umbenannt
- `takeTile/endTurn` nur in Phase `roll` (nach Pick, vor nächstem Wurf = normaler Stop) und `take` (alle 8 beiseite); in Phase `pick` muss erst der Wurf verwertet werden. Fix am 17.09.2026: 11 Tests fanden falschen Phasen-Guard (`pick|take` statt `roll|take`).
- `rollDice(game, {dice, rng})`: Würfel injizierbar (deterministische Tests), Standard `Math.random`
- Ungültige Aktionen werfen `Error` (Server mappt auf `ERROR`-Nachricht); `bust()` ist idempotent (`alreadyOver`), `takeTile` bei Grill+Gegner-Ambiguität ohne Wahl verändert nichts (`needChoice`)

## Aktuelle Implementierung (Phase 3)
- `game.js`: Voll-Core – `createGame/startGame/rollDice/canPick/pickValue/validPickValues/turnScore/hasWorm/remainingDice/canTake/takeTile/endTurn/stealTile/bust/checkGameOver/calculateFinalScore/playerWorms/playerBestTile` (+ Konstanten/Helfer). State: `{grill, players[{id,name,stack,isBot,connected}], currentPlayer, turn{active,rolled,setAside,picked,phase,over,bust,result}, over, winner, ranking}`.
- `test/game.test.js`: 29 Tests, alle grün – inkl. Thomas-Beispiel (27 vom Grill), Birgit-Fehlwurf, Auto-BUST (nur gewählte Werte, nur Würmer), Wurm-Pflicht, Steal direkt + via take, needChoice beide Wahlen, nächstniedrigere, keine-niedrigere→BUST, BUST-Sonderfälle (ohne eigene / höchste zurückgelegt), Idempotenz, alle-8-beiseite, Spielende+Rangliste, Gleichstand.
- Rest Phase 1 unverändert: `server.js` (statisch + WS-Echo + LAN-Log), `bots.js` (Stub), `public/*` (Minimal-Shell)

## Fortschritt
### Abgeschlossen
- [x] Projektstruktur (Phase 1)
- [x] Game Core (Phase 2)
- [x] Game-Core-Tests (Phase 3)
- [ ] Multiplayer (Phase 4)
- [ ] Multiplayer-Tests (Phase 5)
- [ ] Bots (Phase 6)
- [ ] UI (Phase 7)
- [ ] Integrationstests (Phase 8)
- [ ] LAN-Test (Phase 9)
### Aktuell
Phase 2+3 abgeschlossen (29/29 Tests grün). Nächster Schritt: Phase 4 HTTP-Server + WebSocket + Räume.
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
