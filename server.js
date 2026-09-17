'use strict';

/**
 * Hack-Meck Server (Phase-1-Gerüst).
 *
 * - HTTP: serviert statische Dateien aus public/
 * - WebSocket: Phase-1-Echo + Willkommensnachricht (echtes Protokoll folgt in Phase 4)
 * - Lauscht auf 0.0.0.0:3000, loggt erkannte LAN-IPs für WLAN-Multiplayer
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath.slice(1));
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(normalized, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nicht gefunden');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(normalized)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'WELCOME', message: 'Hack-Meck Server (Phase 1) – Spiel-Logik folgt in Phase 4' }));
  ws.on('message', (raw) => {
    // Phase-1-Echo, damit Frontend-Verbindung getestet werden kann.
    ws.send(JSON.stringify({ t: 'ECHO', received: raw.toString().slice(0, 500) }));
  });
});

function lanIps() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hack-Meck läuft auf http://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`LAN: http://${ip}:${PORT}`);
});
