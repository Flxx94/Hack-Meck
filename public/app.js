'use strict';

// Phase-1-Platzhalter: verbindet sich per WebSocket mit demselben Host/Port
// (wichtig für LAN-Multiplayer, kein hardcoded localhost).
const statusEl = document.getElementById('status');
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}`);

ws.addEventListener('open', () => { statusEl.textContent = 'Verbunden (Phase 1)'; });
ws.addEventListener('message', (ev) => { statusEl.textContent = `Server: ${ev.data}`; });
ws.addEventListener('close', () => { statusEl.textContent = '⚠ Verbindung verloren'; });
ws.addEventListener('error', () => { statusEl.textContent = '⚠ Verbindungsfehler'; });
