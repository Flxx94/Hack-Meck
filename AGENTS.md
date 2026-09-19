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
- `public/*`: volles Spiel-UI (s. Frontend) – Screens Menü/Lobby/Spiel/Ende, rendert nur Server-`STATE`, Würfel als Buttons (gültige klickbar), Grill, Stapel, Punkt-/Wurm-Anzeige, NEED_CHOICE-Modal, BUST/Take-Banner, Event-Feed, Reconnect-Overlay + Auto-Rejoin, Session in localStorage.

## Frontend (Light-Minimal-Redesign nach Referenz, 19.09.2026 – ersetzt Holz-Tisch)
- Referenz: `a_clean_minimal_modern_ui_ux_design_spec_screens.png` (Repo-Root, committet) – maßgeblich für Layout/Farben/Proportionen. Nur `public/*` geändert; Protokoll/Regeln/Server/Bots unberührt.
- Palette: fast nur Weiß/Off-White/Hellgrau (`--bg #f6f7f6`, Panels `#fff`, Trays `#edecec`), Text `#23282a`, genau zwei Akzente: Hellgrün `#2fbf71` (aktiv/positiv/WÜRFELN) + Blutrot `#e5484d` (BUST/hohe Karten). Kein Dark Mode mehr (`color-scheme: light`). Holz-/Filz-Vars ersatzlos gestrichen.
- Layout (`.stage`-Grid): Status-Pill oben-mittig (`#turnPill`, grüner Puls-Punkt, animiert nur bei Wechsel), Spieler in Eck-Panels (ich fest unten-links `#seatME`, Gegner `#seatTL/#seatTR/#seatBR`, 5.–7. Spieler in `#seatMore`-Zeile), Gegner-Würfel-Schale oben / eigene unten (`#trayTop/#trayBottom`), Wurmkarten mittig (`#grillPanel`), hauchdünne Bottom-Bar (Spieler/Würmer links, Sound/Menü rechts – **kein Runden-Zähler**, Nutzer-Entscheid).
- Spielerpanel: weiß, 1,5 px `#e4e7e4`-Rand, 16 px Radius, Initialen-Avatar (Pastell, Hash aus Name, 🤖-Badge bei Bots), Name, grüne Wurm-Anzahl, Mini-Stapel (oberste Karte + Count-Badge, `.seat-stack[data-pid]` für Kartenflug erhalten).
- Grill: **nur offene** Karten (genommen = weg wie Referenz), Zahl + 1–4 Wurm-Icons (Nutzer-Entscheid: Icons wiederholt; ≤28 grün `#wormIconGreen`, ≥29 rot `#wormIconRed`); Würfel-Die weiß + grüner Wurm; Pips schwarz, Standard-Layouts (kein 6er – Mechanik hat 1–5+W; Fantasie-Layouts der Referenz-Grafik bewusst nicht kopiert).
- Würfelfeld wandert weiter per FLIP zwischen den Schalen (leere Schale zeigt dezenten Hint: „Bereit“ / „X ist am Zug“ via `updateSlotHints` nach dem Move); Wurf mit 3-Phasen-Keyframe (`rollsettle`, Stagger 70 ms, deterministische `--rd`-Variation pro Würfel); Beiseite-Pop + Karten-Einblendung nur bei inhaltlicher Änderung (`S.grillKeys`/`S.setAsideKey`), sonst ruhig.
- Events/Flug/Sound aus Game-Feel-Update übernommen, minimal restylt: weiße Pillen statt Farbkästen (BUST rot + sanfter Stage-Shake, STEAL grün), `Sfx` unverändert.
- Verifiziert 19.09.2026: `npm test` 66/66 grün, `node --check`, ID-Crosscheck (0 Alt-IDs, 0 Mismatches), HTTP-Smoke (neue Marker da, Holz-Marker weg). Manuelle Browser-Probe (Referenztreue, Flug, Sound, 390 px) steht aus.
- Take-Gating (nur Client, Server bleibt autoritativ): `takeReadiness()` in `app.js` spiegelt `game.canTake()` aus dem STATE (Wurm + erreichbare Portion nötig) – Button disabled + Grund im `title`, sonst wäre ein Klick ein sofortiger BUST mit Strafe. Ausnahme Phase `take` (alle 8 beiseite, Würfeln unmöglich): Nehmen bleibt einzige Aktion, endet ggf. als BUST (wie Bots). BUST-Flip (`flipped`) und genommene Portion werden via `S.lastFlipped` im Grill geflasht (überlebt Neu-Render). Kernlogik dazu (`no-worm`/`no-lower` → BUST + höchste offene Portion umdrehen) war bereits in `game.js` + Tests; neu: 2 `canTake`-Tests (`ok:false` ohne Wurm / bei unerreichbarem Score). Suite jetzt 59/59 grün.

## RNG-Prüfung (19.09.2026 – kein Fehler, `game.js` unverändert)
- Anlass: Gefühl, man könne „ungewöhnlich weit ohne BUST" spielen. Objektiv geprüft statt RNG zu verändern.
- Pfad: `randomDie = DICE_VALUES[Math.floor(rng()*6)]` (`game.js:150`), Produktion via `Math.random`, Tests via `opts.dice/opts.rng` (gleicher Codepfad); Restwürfel = `8 − beiseite`, `picked` via `validPickValues` ausgeschlossen, kein State-/Reuse-/Off-by-one-Fehler, kein Mensch/Bot-Unterschied.
- `test/rng.test.js` (7 Tests): 100.000 Würfel → Chi²=2,8–8,0 (df=5, Schranke 30), jede Seite ±4 %, Wurm ≈16,7 %; Bin-Mitten-Test aller 6 Seiten; rng-Aufrufzahl = Restwürfel; Test-/Prod-Pfad identisch.
- BUST-Simulation (echte `game.js`+`bots.js`-Regeln, normal-Bot, n=2000): BUST-Rate ≈30 %, Ø 3,7 Würfe/Zug, Gründe `only-picked-values` ≫ `no-lower` > `no-worm`; Wurm-Quote bei Take ≈98 %. Erklärung für das Gefühl: Erst-Wurf kann nie Auto-BUSTen, Risiko nach 1 Pick bei 5 Restwürfeln ≈0,01 % (`(picked/6)^rest`).
- Fazit: RNG korrekt → **nicht verändert**; Spielregeln unangetastet.

## Game-Feel-Update (19.09.2026 – nur `public/*`, Protokoll/Regeln/Server unberührt; im Light-Redesign restylt)
- Echte Würfel: 1–5 als Pip-Raster (`renderDie` in `app.js`, `.pips`-Grid in CSS), Wurm als eigenes Inline-SVG (segmentierter Erdwurm; Holz-Ära: `#wormIcon` braun/orange → Referenz-Redesign: `#wormIconGreen`/`#wormIconRed`, weißer Die + grüner Wurm). Mitgeliefertes Hotdog-SVG bewusst NICHT verwendet (Foto-Autotrace mit weißem Hintergrund, 1742×980, passt nicht zum Konzept).
- Wurf-Animation: Fall+Rotation+Aufprall (`rollin`-Keyframe, Stagger 70 ms), reine Visualisierung des Server-Werts.
- Kartenflug per FLIP-Klon (WAAPI, 600 ms): Grill→Stapel (`take-grill`), Stapel→Stapel (Steal, Nehmer per stabiler Spieler-ID, Fallback Rail-Chip bei 3+ Spielern; Referenz-Redesign: Fallback ist `#seatMore`-Panel, Ziel `.mini`), Stapel→Grill (BUST-Rücklage). Quelle aus altem DOM vor STATE-Render, Ziel nach Render; fehlt etwas → still übersprungen.
- Big-Flash-Overlay (`#bigFlash`): `STEAL!`, `BUST!` (+Screen-Shake), `+ WURM!`, `DU BIST DRAN` (nur bei Zugwechsel), `GEWONNEN!` (einmalig in `renderOver`). Auto-Hide ~1,35 s, `pointer-events:none`.
- Sound (WebAudio-Synth, keine Assets, `Sfx` in `app.js`): Würfel-Rasseln, Pick-Click, Take-Fanfare, BUST-Abstieg, Steal-Whoosh, Win-Arpeggio, Zug-Blip. Toggle `#btnSound` in `⋯`-Menü (persistiert `heckmeck-muted`), Start erst nach Nutzer-Geste (Autoplay-Policy).
- Hover/Click: Pickable-Hover mit Lift+Glow, `:active`-Press (Dice `scale(.93)`, Buttons `scale(.97)`), `.dice-table.mine` mit Accent-Glow; statische Elemente ruhig.
- Sync/Performance: Animationen lesen nur Server-Events, entscheiden nichts; nur `transform/opacity`/Keyframes; `prefers-reduced-motion` deaktiviert Flug/Shake/Roll (Flash sofort).
- Verifiziert 19.09.2026: `npm test` 66/66 grün (59 Bestand + 7 RNG), `node --check public/app.js`, ID-Crosscheck (kein JS↔HTML-Mismatch), HTTP-Smoke (200 + `bigFlash`/`wormIcon`/`renderDie`/`Sfx` vorhanden). Manuelle Browser-Probe (Flug, Flash, Sound auf 2 Geräten) steht aus. (Holz-Ära; Referenz-Redesign: weiße Flash-Pillen, `#wormIconGreen`, Sound-Toggle in Bottom-Bar statt ⋯-Menü.)

## Aktuelle Implementierung (Phase 8)
- `test/integration.test.js`: 2 End-to-End-Spiele über WS – (1) 2 Menschen bis `GAME_OVER` (Strategie: Wurm sichern, weiter bis 21+, NEED_CHOICE→Grill) mit Validierung von Ranglisten-Sortierung, Wurm-Nachrechnung aus Stapeln, leerem Grill, Grill-Konsistenz und Aktionen-nach-Ende→`ERROR`; (2) Mensch + normal-Bot bis `GAME_OVER` (Bot über 800-ms-Engine, `waitHumanTurn` mit Silence-Erkennung).
- Test-Helfer-Disziplin: `waitAny` (kein Nachrichtenklau durch verwaiste Racer), Sequenznummern statt Queue-Indizes (splice-sicher), `mark` vor Senden. `server.close()` terminiert jetzt Clients (kein Hängen der Suite).
- Suite: 57/57 grün seriell (~3 Min, Bot-Vollspiel dominiert).

## LAN-Test (Phase 9, Stand 17.09.2026)
- Verifiziert lokal: Server lauscht `0.0.0.0:3000`, loggt LAN-IPs (z. B. `http://192.168.111.138:3000`), WS nutzt gleichen Host/Port.
- Echter Mehrgeräte-Test steht aus (nur 1 Rechner verfügbar). Checkliste:
  1. `npm start` auf Host, LAN-IP aus Log ablesen
  2. Gleiches WLAN auf allen Geräten prüfen
  3. `http://<LAN-IP>:3000` auf 2+ Geräten öffnen (ggf. Windows-Firewall: Port 3000 freigeben)
  4. Raum erstellen, Code teilen, beitreten, Spiel mit Bots + Menschen bis Ende spielen

## Fortschritt
### Abgeschlossen
- [x] Projektstruktur (Phase 1)
- [x] Game Core (Phase 2)
- [x] Game-Core-Tests (Phase 3)
- [x] Multiplayer (Phase 4)
- [x] Multiplayer-Tests (Phase 5)
- [x] Bots (Phase 6)
- [x] UI (Phase 7)
- [x] Integrationstests (Phase 8)
- [ ] LAN-Test mit mehreren Geräten (Phase 9, Checkliste bereit)
### Aktuell
Phase 8 + Light-Minimal-Redesign abgeschlossen (Suite 66/66 grün). Offen: echter LAN-Test mit 2+ Geräten (Phase 9) + manuelle Browser-Probe des Redesigns (Referenztreue, Flug, Sound, 390 px).
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
