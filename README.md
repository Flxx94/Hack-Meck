# Hack-Meck am Bratwurmeck

Webbasiertes Multiplayer-Würfelspiel nach „Heckmeck am Bratwurmeck" (Reiner Knizia / Zoch).
Spielbar gegen Bots sowie gegen andere Spieler im gleichen lokalen WLAN.

> Stand: Phase 7 (spielbar: Menü, Lobby, Spiel, Spielende – im Browser gegen Bots oder im LAN).
> Theme-Anpassung: nur `:root`-Block in `public/style.css` ändern.

## Installation

```bash
npm install
```

Benötigt: Node.js 24+ (`node --version`), npm 11+.

## Start

```bash
npm start
```

Danach öffnen:

- Lokal: http://localhost:3000
- Im WLAN: `http://<LAN-IP>:3000` (der Server loggt beim Start alle erkannten LAN-IPs)

Der WebSocket nutzt automatisch denselben Host/Port (kein hardcoded localhost).

## Spiel gegen Bots / LAN-Multiplayer

- Raum erstellen, Code teilen (z. B. `A7K2`), bis zu 7 Spieler pro Raum
- Bots hinzufügen (easy / normal / hard)
- Reconnect via Token (5 Minuten, im gleichen Zug 60 s Schutz, danach Bot-Ersatz)

### LAN-Checkliste (2+ Geräte im gleichen WLAN)

1. Auf dem Host: `npm start`, LAN-IP aus dem Log ablesen (z. B. `http://192.168.111.138:3000`)
2. Auf den anderen Geräten `http://<LAN-IP>:3000` öffnen
   (ggf. Windows-Firewall: eingehende Regel für Port 3000 erlauben)
3. Raum erstellen, Code teilen, beitreten, losspielen

## Projektstruktur

```text
server.js        HTTP (statisch) + WebSocket + Räume (einzige Quelle der Wahrheit)
game.js          reine Spiellogik, kein HTTP/WS/DOM – voll testbar
bots.js          Bot-Entscheidungen nur via game.js-API
public/          index.html, style.css, app.js (Vanilla, kein Build)
test/            node:test-Suiten (game, bots, server)
AGENTS.md        dauerhafter Projektkontext
```

Architektur: `Browser ↔ WebSocket ↔ server.js ↔ game.js`, zusätzlich `server.js ↔ bots.js ↔ game.js`.

## Tests

```bash
npm test   # node --test test/
```

Phase 1: Smoke-Tests (8 Würfel, Wurm = 5 Punkte, 16 Portionen mit Standard-Wurmverteilung).
Ab Phase 3: alle Edge Cases (Auto-BUST, Doppelwahl, BUST-Sonderfälle, Steal, Spielende, Gleichstand).

## Regeln (Kurzfassung)

2–7 Spieler, 16 Portionen 21–36, 8 Würfel (1–5 + Wurm = 5 Punkte).
Pro Wurf genau ein noch nicht gewählter Wert, alle Würfel dieses Werts beiseitelegen.
Mindestens 1 Wurm nötig. Exakt → nehmen/stehlen (bei Grill + Gegner gleichzeitig wählt der Spieler),
sonst nächstniedrigere Grillportion, sonst Fehlwurf (Rücklage + höchste Grillportion umdrehen, mit Sonderfällen).
Ende: keine offene Grillportion mehr; meiste Würmer gewinnt, Gleichstand → höchste Einzelportion.
Vollständige Regeln: siehe Spielanleitung (PDF, lokal) und `AGENTS.md`.

## Repository

https://github.com/Flxx94/Hack-Meck (Branch `main`)

## Bekannte Einschränkungen

- Max. 7 Spieler pro Raum
- Keine externen Dienste nach `npm install` nötig
- Touch-Targets ≥ 44×44 px (ab Phase 7)

## Lizenz

GPL-3.0-only (siehe LICENSE).
