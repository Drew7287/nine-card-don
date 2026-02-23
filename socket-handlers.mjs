// socket-handlers.mjs — All Socket.IO event handlers

import {
  createRoom, joinRoom, sitDown, startGame, restartGame, choosePitcher,
  playCardInRoom, readyNextHand, handleDisconnect,
  getRoomState, getPersonalGameState, getRoom
} from './room-manager.mjs';

export function registerHandlers(io, socket) {

  socket.on('create-room', ({ playerName }, ack) => {
    if (!playerName?.trim()) return ack?.({ error: 'Name required' });
    const room = createRoom(playerName);
    const joinResult = joinRoom(room.code, socket.id, playerName.trim());
    if (joinResult.error) return ack?.({ error: joinResult.error });

    socket.join(room.code);
    ack?.({ ok: true, code: room.code });
    io.to(room.code).emit('room-state', getRoomState(room));
  });

  socket.on('join-room', ({ code, playerName }, ack) => {
    if (!playerName?.trim()) return ack?.({ error: 'Name required' });
    if (!code?.trim()) return ack?.({ error: 'Room code required' });

    const result = joinRoom(code.trim().toUpperCase(), socket.id, playerName.trim());
    if (result.error) return ack?.({ error: result.error });

    socket.join(result.room.code);
    ack?.({ ok: true, code: result.room.code, rejoined: result.rejoined, seat: result.seat });

    io.to(result.room.code).emit('room-state', getRoomState(result.room));

    // If rejoining a game in progress, send game state
    if (result.rejoined && result.room.started) {
      const gameView = getPersonalGameState(result.room, socket.id);
      if (gameView) socket.emit('game-state', gameView);
    }
  });

  socket.on('sit-down', ({ code, seat }, ack) => {
    const result = sitDown(code, socket.id, seat);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });
    io.to(code).emit('room-state', getRoomState(result.room));
  });

  socket.on('start-game', ({ code }, ack) => {
    const result = startGame(code, socket.id);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });

    // Build player names map for cut ceremony display
    const playerNames = {};
    for (const seat of ['N', 'E', 'S', 'W']) {
      const sid = result.room.seats[seat];
      if (sid && result.room.players[sid]) {
        playerNames[seat] = result.room.players[sid].name;
      }
    }

    // Emit cut ceremony to all clients
    io.to(code).emit('cut-ceremony', { ...result.cutResult, playerNames });

    // After 3s, transition to choosing phase
    setTimeout(() => {
      const room = getRoom(code);
      if (!room || room.phase !== 'cutting') return;
      room.phase = 'choosing';
      // Send personalized cut-choose to each player so chooser gets buttons
      for (const [socketId, player] of Object.entries(room.players)) {
        io.to(socketId).emit('cut-choose', {
          chooser: room.cutResult.chooser,
          winningTeam: room.cutResult.winningTeam,
          isChooser: player.seat === room.cutResult.chooser,
        });
      }
    }, 3000);
  });

  socket.on('choose-pitcher', ({ code, choice }, ack) => {
    const result = choosePitcher(code, socket.id, choice);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });

    // Tell everyone who will pitch
    io.to(code).emit('pitcher-chosen', { pitcherSeat: result.pitcherSeat });

    // After brief delay, start the game
    setTimeout(() => {
      io.to(code).emit('game-started');
      broadcastGameState(io, result.room);
    }, 1500);
  });

  socket.on('play-card', ({ code, card }, ack) => {
    const result = playCardInRoom(code, socket.id, card);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });

    const room = result.room;

    // Broadcast card played (public info)
    io.to(code).emit('card-played', {
      seat: result.seat,
      card,
      pitchRevealed: result.pitchRevealed,
      trumpSuit: result.pitchRevealed ? room.gameState.trumpSuit : undefined,
    });

    // If trick complete, broadcast result with slight delay for animation
    if (result.trickResult) {
      setTimeout(() => {
        io.to(code).emit('trick-complete', result.trickResult);

        // If hand is complete, broadcast hand result
        if (result.handResult) {
          setTimeout(() => {
            io.to(code).emit('hand-complete', result.handResult);
            broadcastGameState(io, room);
          }, 500);
        } else {
          broadcastGameState(io, room);
        }
      }, 800);
    } else {
      broadcastGameState(io, room);
    }
  });

  socket.on('ready-next-hand', ({ code }, ack) => {
    const result = readyNextHand(code, socket.id);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });

    if (result.newHand) {
      io.to(code).emit('new-hand');
      broadcastGameState(io, result.room);
    } else {
      io.to(code).emit('ready-count', { count: result.readyCount });
    }
  });

  socket.on('restart-game', ({ code }, ack) => {
    const result = restartGame(code, socket.id);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });

    // Build player names map for cut ceremony display
    const playerNames = {};
    for (const seat of ['N', 'E', 'S', 'W']) {
      const sid = result.room.seats[seat];
      if (sid && result.room.players[sid]) {
        playerNames[seat] = result.room.players[sid].name;
      }
    }

    // Fresh cut ceremony for new game
    io.to(code).emit('cut-ceremony', { ...result.cutResult, playerNames });

    setTimeout(() => {
      const room = getRoom(code);
      if (!room || room.phase !== 'cutting') return;
      room.phase = 'choosing';
      for (const [socketId, player] of Object.entries(room.players)) {
        io.to(socketId).emit('cut-choose', {
          chooser: room.cutResult.chooser,
          winningTeam: room.cutResult.winningTeam,
          isChooser: player.seat === room.cutResult.chooser,
        });
      }
    }, 3000);
  });

  socket.on('disconnect', () => {
    const result = handleDisconnect(socket.id);
    if (result?.room) {
      io.to(result.room.code).emit('room-state', getRoomState(result.room));
      io.to(result.room.code).emit('player-disconnected', {
        seat: result.seat,
        name: result.name,
      });
    }
  });
}

function broadcastGameState(io, room) {
  for (const [socketId, player] of Object.entries(room.players)) {
    if (player.seat) {
      const view = getPersonalGameState(room, socketId);
      if (view) {
        io.to(socketId).emit('game-state', view);
      }
    }
  }
}
