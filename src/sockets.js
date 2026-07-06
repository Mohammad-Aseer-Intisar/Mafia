'use strict';

// Socket transport: routes events to the engine and owns connection
// lifecycle (identity binding, reconnect grace periods, room cleanup).
// Identity is bound to the socket at join time — later events can't
// impersonate another player by sending a different token.

const engine = require('./engine');

const DISCONNECT_GRACE_MS = 90 * 1000; // time to reconnect before elimination
const ROOM_REAP_MS = 10 * 60 * 1000; // empty-room cleanup

module.exports = function attachSockets(io) {
  const rooms = new Map();

  function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O — easy to read aloud
    let code;
    do {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (rooms.has(code));
    return code;
  }

  function getContext(socket) {
    const { roomCode, token } = socket.data;
    const room = roomCode && rooms.get(roomCode);
    const player = room && room.players.get(token);
    return room && player ? { room, player } : null;
  }

  function cancelReap(room) {
    if (room.reapTimer) {
      clearTimeout(room.reapTimer);
      room.reapTimer = null;
    }
  }

  function scheduleReap(room) {
    cancelReap(room);
    room.reapTimer = setTimeout(() => {
      engine.destroyRoom(room);
      rooms.delete(room.code);
    }, ROOM_REAP_MS);
  }

  function bind(socket, room, player) {
    socket.data.roomCode = room.code;
    socket.data.token = player.token;
    player.socketId = socket.id;
    player.connected = true;
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    socket.join(room.code);
    cancelReap(room);
  }

  function doRejoin(socket, room, token) {
    const player = room.players.get(token);
    // Same identity connecting again (refresh, second tab): the newest
    // socket takes over the seat and the old one is dropped.
    if (player.socketId && player.socketId !== socket.id) {
      const ghost = io.sockets.sockets.get(player.socketId);
      if (ghost) {
        ghost.data = {};
        ghost.disconnect(true);
      }
    }
    bind(socket, room, player);
    socket.emit('joined', { code: room.code, selfId: token });
    engine.rejoin(room, player);
  }

  io.on('connection', (socket) => {
    socket.on('create-room', (payload = {}) => {
      const { name, token } = payload;
      if (typeof name !== 'string' || typeof token !== 'string' || !token) return;
      const code = generateCode();
      const room = engine.createRoom(io, code);
      const result = engine.addPlayer(room, token, name, true);
      if (result.error) {
        return socket.emit('app-error', { message: result.error });
      }
      rooms.set(code, room);
      bind(socket, room, result.player);
      socket.emit('joined', { code, selfId: token });
      engine.afterJoin(room, result.player);
    });

    socket.on('join-room', (payload = {}) => {
      const { name, token } = payload;
      const code = String(payload.code || '').trim().toUpperCase();
      if (typeof name !== 'string' || typeof token !== 'string' || !token) return;

      const room = rooms.get(code);
      if (!room) {
        return socket.emit('app-error', { message: 'Room not found — double-check the code.' });
      }
      if (room.players.has(token)) {
        return doRejoin(socket, room, token); // same browser coming back
      }
      if (room.phase !== 'lobby') {
        return socket.emit('app-error', { message: 'That game has already started.' });
      }
      if (room.players.size >= engine.MAX_PLAYERS) {
        return socket.emit('app-error', { message: `Room is full (max ${engine.MAX_PLAYERS} players).` });
      }

      const result = engine.addPlayer(room, token, name, false);
      if (result.error) {
        return socket.emit('app-error', { message: result.error });
      }
      bind(socket, room, result.player);
      socket.emit('joined', { code, selfId: token });
      engine.afterJoin(room, result.player);
    });

    socket.on('rejoin-room', (payload = {}) => {
      const { token } = payload;
      const code = String(payload.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room || typeof token !== 'string' || !room.players.has(token)) {
        return socket.emit('rejoin-failed');
      }
      doRejoin(socket, room, token);
    });

    socket.on('update-settings', (payload = {}) => {
      const ctx = getContext(socket);
      if (ctx) engine.updateSettings(ctx.room, ctx.player, payload.settings);
    });

    socket.on('start-game', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const error = engine.startGame(ctx.room, ctx.player);
      if (error) socket.emit('app-error', { message: error });
    });

    socket.on('night-action', (payload = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { target } = payload;
      if (target !== 'skip' && typeof target !== 'string') return;
      engine.handleNightAction(ctx.room, ctx.player, target);
    });

    socket.on('day-vote', (payload = {}) => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { target } = payload;
      if (target !== 'skip' && typeof target !== 'string') return;
      engine.handleDayVote(ctx.room, ctx.player, target);
    });

    socket.on('mayor-reveal', () => {
      const ctx = getContext(socket);
      if (ctx) engine.handleMayorReveal(ctx.room, ctx.player);
    });

    socket.on('end-discussion', () => {
      const ctx = getContext(socket);
      if (ctx) engine.handleEndDiscussion(ctx.room, ctx.player);
    });

    socket.on('mafia-chat', (payload = {}) => {
      const ctx = getContext(socket);
      if (ctx) engine.handleChat(ctx.room, ctx.player, payload.text);
    });

    socket.on('play-again', () => {
      const ctx = getContext(socket);
      if (ctx) engine.handlePlayAgain(ctx.room, ctx.player);
    });

    socket.on('leave-room', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      socket.leave(room.code);
      socket.data = {};
      handleDeparture(room, player);
    });

    socket.on('disconnect', () => {
      const ctx = getContext(socket);
      if (!ctx) return;
      const { room, player } = ctx;
      if (player.socketId !== socket.id) return; // seat already taken over
      handleDeparture(room, player);
    });

    function handleDeparture(room, player) {
      engine.markDisconnected(room, player);

      if (room.players.size === 0) {
        engine.destroyRoom(room);
        rooms.delete(room.code);
        return;
      }
      if (room.phase !== 'lobby' && room.phase !== 'game-over' && !player.disconnectTimer) {
        player.disconnectTimer = setTimeout(
          () => engine.eliminateAbandoned(room, player),
          DISCONNECT_GRACE_MS
        );
      }
      if (![...room.players.values()].some(p => p.connected)) {
        scheduleReap(room);
      }
    }
  });
};
