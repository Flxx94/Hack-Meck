'use strict';

/**
 * Hack-Meck Server (Phase 4): HTTP + WebSocket + Räume.
 *
 * - Einzige Quelle der Wahrheit: alle Aktionen werden validiert,
 *   Würfel/BUST/Portionen/Ende/Gewinner entscheidet der Server via game.js.
 * - Räume mit 4-stelligem Code, max. 7 Spieler, Start ab 2 Spielern (Bots zählen).
 * - Reconnect via reconnectToken (5 Min); verliert der aktive Spieler die
 *   Verbindung, wird er nach 60 s durch einen Bot ersetzt (nie blockieren).
 *
 * Protokoll, Client → Server (JSON, Feld `t`):
 *   create {name} | join {code,name} | rejoin {code,token} | addBot {difficulty?}
 *   start | roll | pick {value} | take {choice?} | stop
 * Protokoll, Server → Client:
 *   WELCOME | JOINED | REJOINED | PLAYER_JOINED | PLAYER_LEFT | GAME_STARTED
 *   TURN_STARTED | DICE_ROLLED | DICE_SELECTED | BUST | TILE_TAKEN | TURN_ENDED
 *   GAME_OVER | NEED_CHOICE | STATE | ERROR
 * Nach jeder Mutation sendet der Server zusätzlich STATE (Voll-State).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const game = require('./game');
const bots = require('./bots');
const { DIFFICULTIES } = bots;

const BOT_MOVE_DELAY_MS = 800;

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 7;
const RECONNECT_MS = 5 * 60 * 1000;
const TURN_GRACE_MS = 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I/O/0/1 (Verwechslung)
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

function generateId(prefix) {
  return `${prefix}${crypto.randomBytes(4).toString('hex')}`;
}

/** Baut einen Heck-Meck-Server (für Tests mit beliebigem Port nutzbar). */
function createHeckMeckServer(port = PORT, host = '0.0.0.0') {
  const rooms = new Map(); // code -> room

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1)));
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

  // ---------- Nachrichten-Helfer ----------

  function send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function broadcast(room, msg) {
    for (const p of room.players) {
      if (p.ws && p.connected) send(p.ws, msg);
    }
  }

  /** Voll-State für Clients (inkl. abgeleiteter Zug-Infos für die UI). */
  function stateMessage(room, event = null) {
    const st = {
      t: 'STATE',
      code: room.code,
      status: room.status,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, isBot: p.isBot, connected: p.connected,
      })),
      game: null,
      event,
    };
    if (room.game) {
      const gm = room.game;
      st.game = {
        grill: gm.grill,
        players: gm.players.map((p) => ({ id: p.id, name: p.name, stack: p.stack, isBot: p.isBot })),
        currentPlayer: gm.currentPlayer,
        currentPlayerId: gm.players[gm.currentPlayer]?.id || null,
        turn: {
          phase: gm.turn.phase,
          rolled: gm.turn.rolled,
          setAside: gm.turn.setAside,
          picked: gm.turn.picked,
          score: game.turnScore(gm),
          hasWorm: game.hasWorm(gm),
          validPicks: game.validPickValues(gm),
          remaining: game.remainingDice(gm),
          over: gm.turn.over,
        },
        over: gm.over,
        winner: gm.winner,
        ranking: gm.ranking,
      };
    }
    return st;
  }

  function sendState(room, event = null) {
    broadcast(room, stateMessage(room, event));
  }

  function errorTo(ws, message) {
    send(ws, { t: 'ERROR', message: String(message) });
  }

  // ---------- Raum-Logik ----------

  function getRoom(code) {
    if (!code) return null;
    return rooms.get(String(code).toUpperCase().trim()) || null;
  }

  function bindPlayer(room, player, ws) {
    if (player.botTimer) {
      clearTimeout(player.botTimer);
      player.botTimer = null;
    }
    player.ws = ws;
    player.connected = true;
    player.tokenExpiry = 0;
    ws.roomCode = room.code;
    ws.playerId = player.id;
  }

  function newRoom(hostName) {
    let code = generateCode();
    while (rooms.has(code)) code = generateCode();
    const room = { code, players: [], game: null, status: 'lobby', createdAt: Date.now() };
    const player = {
      id: generateId('p'), name: hostName, isBot: false, botDifficulty: null,
      connected: false, ws: null, reconnectToken: generateId('tok'), tokenExpiry: 0, botTimer: null,
    };
    room.players.push(player);
    rooms.set(code, room);
    return { room, player };
  }

  function publicJoin(room, name, isBot = false, difficulty = null) {
    if (room.status !== 'lobby') throw new Error('Spiel läuft bereits – Beitritt nicht möglich.');
    if (room.players.length >= MAX_PLAYERS) throw new Error('Raum ist voll (max. 7 Spieler).');
    const base = String(name || (isBot ? 'Bot' : 'Spieler')).slice(0, 20) || 'Spieler';
    const player = {
      id: generateId('p'), name: base, isBot, botDifficulty: difficulty,
      connected: isBot, ws: null, reconnectToken: generateId('tok'), tokenExpiry: 0, botTimer: null,
    };
    room.players.push(player);
    return player;
  }

  function syncGamePlayers(room) {
    room.game.players.forEach((gp, i) => {
      gp.id = room.players[i].id;
      gp.name = room.players[i].name;
      gp.isBot = room.players[i].isBot;
    });
  }

  function startRoomGame(room) {
    if (room.status !== 'lobby') throw new Error('Spiel läuft bereits.');
    if (room.players.length < 2) throw new Error('Mindestens 2 Spieler nötig (Bots zählen mit).');
    room.game = game.createGame(room.players.map((p) => p.name));
    syncGamePlayers(room);
    game.startGame(room.game);
    room.status = 'playing';
  }

  function currentPlayerId(room) {
    const gm = room.game;
    return gm.players[gm.currentPlayer].id;
  }

  function requireActor(room, ws) {
    const player = room.players.find((p) => p.id === ws.playerId);
    if (!player) throw new Error('Unbekannter Spieler.');
    if (player.isBot) throw new Error('Bots spielen automatisch.');
    if (room.status !== 'playing' || !room.game || room.game.over) {
      throw new Error('Kein laufendes Spiel.');
    }
    if (currentPlayerId(room) !== player.id) throw new Error('Du bist nicht am Zug.');
    return player;
  }

  // ---------- Spielzüge (Mensch + Bot teilen sich diese) ----------

  function performRoll(room) {
    const res = game.rollDice(room.game);
    if (res.bust) {
      broadcast(room, { t: 'BUST', ...res });
    } else {
      broadcast(room, { t: 'DICE_ROLLED', rolled: res.rolled });
    }
    if (!room.game.over) broadcast(room, { t: 'TURN_STARTED', playerId: currentPlayerId(room) });
    if (room.game.over) {
      room.status = 'over';
      broadcast(room, { t: 'GAME_OVER', ranking: room.game.ranking, winner: room.game.winner });
    }
    sendState(room, res.bust ? 'BUST' : 'DICE_ROLLED');
    scheduleBot(room);
  }

  function performPick(room, value) {
    const res = game.pickValue(room.game, value);
    broadcast(room, { t: 'DICE_SELECTED', ...res });
    sendState(room, 'DICE_SELECTED');
    scheduleBot(room);
  }

  /** ws ist gesetzt bei menschlichen Spielern (für NEED_CHOICE), Bots bekommen Default. */
  function performTake(room, choice, ws = null) {
    const res = game.takeTile(room.game, choice);
    if (res.needChoice) {
      if (ws) {
        send(ws, { t: 'NEED_CHOICE', score: res.score, options: res.options });
        return;
      }
      // Bot ohne Wahl (sollte nicht vorkommen): Grill bevorzugen.
      performTake(room, { source: 'grill' });
      return;
    }
    if (res.bust) {
      broadcast(room, { t: 'BUST', ...res });
    } else {
      broadcast(room, { t: 'TILE_TAKEN', ...res });
    }
    if (room.game.over) {
      room.status = 'over';
      broadcast(room, { t: 'GAME_OVER', ranking: room.game.ranking, winner: room.game.winner });
    } else {
      broadcast(room, { t: 'TURN_ENDED' });
      broadcast(room, { t: 'TURN_STARTED', playerId: currentPlayerId(room) });
    }
    sendState(room, res.bust ? 'BUST' : 'TILE_TAKEN');
    scheduleBot(room);
  }

  // ---------- Bot-Engine (nur Timer hier, Logik in bots.js) ----------

  function botDifficulty(room) {
    const p = room.players.find((x) => x.id === currentPlayerId(room));
    return p && p.botDifficulty ? p.botDifficulty : 'normal';
  }

  function currentIsBot(room) {
    if (room.status !== 'playing' || !room.game || room.game.over) return false;
    const p = room.players.find((x) => x.id === currentPlayerId(room));
    return !!(p && p.isBot);
  }

  /** Plant den nächsten Bot-Schritt (~800 ms), genau ein Timer pro Raum. */
  function scheduleBot(room) {
    if (room.botEngineTimer || !currentIsBot(room)) return;
    room.botEngineTimer = setTimeout(() => {
      room.botEngineTimer = null;
      botStep(room);
    }, BOT_MOVE_DELAY_MS);
    if (room.botEngineTimer.unref) room.botEngineTimer.unref();
  }

  /** Führt genau eine Bot-Aktion aus und plant die nächste (Verkettung). */
  function botStep(room) {
    if (!currentIsBot(room)) return;
    try {
      const gm = room.game;
      const level = botDifficulty(room);
      if (gm.turn.phase === 'pick') {
        performPick(room, bots.choosePick(gm, level, Math.random));
      } else if (gm.turn.phase === 'take' || gm.turn.picked.length > 0) {
        const dec = bots.decideStop(gm, level, Math.random);
        if (dec.stop || gm.turn.phase === 'take') {
          performTake(room, dec.choice);
        } else {
          performRoll(room);
        }
      } else {
        performRoll(room);
      }
    } catch {
      // Ein Bot darf ein Spiel niemals crashen: Zug sicher beenden.
      try {
        if (room.game && !room.game.over && !room.game.turn.over) {
          if (room.game.turn.picked.length > 0) performTake(room, { source: 'grill' });
          else room.game.turn.phase = 'roll';
        }
      } catch { /* aufgeben, nächster Zug regelt */ }
      scheduleBot(room);
    }
  }

  // ---------- Nachrichten-Handler ----------

  function handle(ws, msg) {
    switch (msg.t) {
      case 'create': {
        const name = String(msg.name || 'Spieler').slice(0, 20) || 'Spieler';
        const { room, player } = newRoom(name);
        bindPlayer(room, player, ws);
        send(ws, { t: 'JOINED', code: room.code, playerId: player.id, token: player.reconnectToken });
        broadcast(room, { t: 'PLAYER_JOINED', playerId: player.id, name: player.name });
        sendState(room, 'PLAYER_JOINED');
        break;
      }
      case 'join': {
        const room = getRoom(msg.code);
        if (!room) throw new Error('Unbekannter Raumcode.');
        const player = publicJoin(room, msg.name);
        bindPlayer(room, player, ws);
        send(ws, { t: 'JOINED', code: room.code, playerId: player.id, token: player.reconnectToken });
        broadcast(room, { t: 'PLAYER_JOINED', playerId: player.id, name: player.name });
        sendState(room, 'PLAYER_JOINED');
        break;
      }
      case 'rejoin': {
        const room = getRoom(msg.code);
        if (!room) throw new Error('Unbekannter Raumcode.');
        const player = room.players.find((p) => p.reconnectToken === msg.token);
        if (!player || player.isBot) throw new Error('Ungültiger Reconnect-Token.');
        if (!player.connected && player.tokenExpiry && Date.now() > player.tokenExpiry) {
          throw new Error('Reconnect-Zeit abgelaufen (5 Minuten).');
        }
        bindPlayer(room, player, ws);
        send(ws, { t: 'REJOINED', code: room.code, playerId: player.id, token: player.reconnectToken });
        broadcast(room, { t: 'PLAYER_JOINED', playerId: player.id, name: player.name });
        sendState(room, 'PLAYER_JOINED');
        break;
      }
      case 'addBot': {
        const room = rooms.get(ws.roomCode);
        if (!room) throw new Error('Kein Raum.');
        if (room.status !== 'lobby') throw new Error('Spiel läuft bereits.');
        const difficulty = DIFFICULTIES.includes(msg.difficulty) ? msg.difficulty : 'normal';
        const n = room.players.filter((p) => p.isBot).length + 1;
        const bot = publicJoin(room, `Bot ${n} (${difficulty})`, true, difficulty);
        broadcast(room, { t: 'PLAYER_JOINED', playerId: bot.id, name: bot.name });
        sendState(room, 'PLAYER_JOINED');
        break;
      }
      case 'start': {
        const room = rooms.get(ws.roomCode);
        if (!room) throw new Error('Kein Raum.');
        startRoomGame(room);
        broadcast(room, { t: 'GAME_STARTED' });
        broadcast(room, { t: 'TURN_STARTED', playerId: currentPlayerId(room) });
        sendState(room, 'TURN_STARTED');
        scheduleBot(room);
        break;
      }
      case 'roll': {
        const room = rooms.get(ws.roomCode);
        if (!room) throw new Error('Kein Raum.');
        requireActor(room, ws);
        performRoll(room);
        break;
      }
      case 'pick': {
        const room = rooms.get(ws.roomCode);
        if (!room) throw new Error('Kein Raum.');
        requireActor(room, ws);
        performPick(room, msg.value);
        break;
      }
      case 'take':
      case 'stop': {
        const room = rooms.get(ws.roomCode);
        if (!room) throw new Error('Kein Raum.');
        requireActor(room, ws);
        if (room.game.turn.picked.length === 0) throw new Error('Noch nichts gewählt – erst würfeln und wählen.');
        performTake(room, msg.choice, ws);
        break;
      }
      default:
        throw new Error(`Unbekannte Aktion: ${msg.t}`);
    }
  }

  // ---------- Disconnect / Reconnect ----------

  function onClose(ws) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === ws.playerId);
    if (!player || player.isBot) return;
    player.connected = false;
    player.ws = null;
    player.tokenExpiry = Date.now() + RECONNECT_MS;
    broadcast(room, { t: 'PLAYER_LEFT', playerId: player.id, name: player.name });
    sendState(room, 'PLAYER_LEFT');
    // Eigener Zug: 60 s Schutz, danach Bot-Ersatz – Spiel blockiert nie.
    if (room.status === 'playing' && room.game && !room.game.over && currentPlayerId(room) === player.id) {
      player.botTimer = setTimeout(() => {
        player.botTimer = null;
        if (player.connected || room.game.over) return;
        player.isBot = true;
        player.botDifficulty = 'normal';
        player.name = `${player.name} (Bot)`;
        syncGamePlayers(room);
        broadcast(room, { t: 'PLAYER_JOINED', playerId: player.id, name: player.name });
        sendState(room, 'PLAYER_JOINED');
        scheduleBot(room);
      }, TURN_GRACE_MS);
      if (player.botTimer.unref) player.botTimer.unref();
    }
  }

  wss.on('connection', (ws) => {
    send(ws, { t: 'WELCOME', message: 'Willkommen bei Hack-Meck!' });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        errorTo(ws, 'Ungültiges JSON.');
        return;
      }
      try {
        handle(ws, msg);
      } catch (err) {
        errorTo(ws, err.message);
      }
    });
    ws.on('close', () => onClose(ws));
  });

  // Aufräumen: leere Räume mit abgelaufenen Tokens löschen.
  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const anyone = room.players.some((p) => p.connected);
      const validToken = room.players.some((p) => !p.connected && !p.isBot && p.tokenExpiry > now);
      if (!anyone && !validToken && (room.status === 'over' || now - room.createdAt > RECONNECT_MS)) {
        rooms.delete(code);
      }
    }
  }, 60 * 1000);
  if (cleaner.unref) cleaner.unref();

  function listen() {
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve(server.address()));
    });
  }

  async function close() {
    clearInterval(cleaner);
    for (const room of rooms.values()) {
      if (room.botEngineTimer) clearTimeout(room.botEngineTimer);
      for (const p of room.players) if (p.botTimer) clearTimeout(p.botTimer);
    }
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, wss, rooms, listen, close };
}

function lanIps() {
  const out = [];
  for (const ifaces of Object.values(require('node:os').networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

module.exports = { createHeckMeckServer, generateCode, MAX_PLAYERS };

if (require.main === module) {
  const { server } = createHeckMeckServer(PORT, '0.0.0.0');
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Hack-Meck läuft auf http://localhost:${PORT}`);
    for (const ip of lanIps()) console.log(`LAN: http://${ip}:${PORT}`);
  });
}
