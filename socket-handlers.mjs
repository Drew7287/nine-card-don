// socket-handlers.mjs — All Socket.IO event handlers

import {
  createRoom, joinRoom, sitDown, startGame, restartGame, choosePitcher,
  playCardInRoom, readyNextHand, handleDisconnect,
  getRoomState, getPersonalGameState, getRoom, getPlayerNames,
  addAiToSeat, removeAiFromSeat, aiTakeoverSeat
} from './room-manager.mjs';
import { triggerAiTurn, triggerAiPitcherChoice, triggerAiReadyNextHand, isAiSeat } from './ai-controller.mjs';
import { AI_NAMES } from './ai-player.mjs';
import { joinQueue, leaveQueue, startWithAi } from './matchmaking.mjs';
import * as stats from './analytics.mjs';

export function registerHandlers(io, socket) {

  socket.on('create-room', ({ playerName }, ack) => {
    if (!playerName?.trim()) return ack?.({ error: 'Name required' });
    const room = createRoom(playerName);
    const joinResult = joinRoom(room.code, socket.id, playerName.trim());
    if (joinResult.error) return ack?.({ error: joinResult.error });

    stats.record('room_created', { code: room.code });

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

    // If rejoining a game in progress, send game state and notify others
    if (result.rejoined && result.room.started) {
      const gameView = getPersonalGameState(result.room, socket.id);
      if (gameView) socket.emit('game-state', gameView);
      io.to(result.room.code).emit('player-reconnected', {
        seat: result.seat,
        name: playerName.trim(),
      });
    }
  });

  socket.on('sit-down', ({ code, seat }, ack) => {
    const result = sitDown(code, socket.id, seat);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });
    io.to(code).emit('room-state', getRoomState(result.room));
  });

  // --- AI seat management ---

  socket.on('add-ai', ({ code, seat }, ack) => {
    const room = getRoom(code);
    if (!room) return ack?.({ error: 'Room not found' });

    const usedNames = new Set(Object.values(room.aiPlayers).map(p => p.name));
    const name = AI_NAMES.find(n => !usedNames.has(n)) || `Bot ${seat}`;

    const result = addAiToSeat(code, seat, name);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });
    io.to(code).emit('room-state', getRoomState(result.room));
  });

  socket.on('remove-ai', ({ code, seat }, ack) => {
    const result = removeAiFromSeat(code, seat);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });
    io.to(code).emit('room-state', getRoomState(result.room));
  });

  // --- Quick Play ---

  socket.on('quick-play', ({ playerName }, ack) => {
    if (!playerName?.trim()) return ack?.({ error: 'Name required' });
    joinQueue(socket.id, playerName.trim());
    stats.record('queue_join');
    ack?.({ ok: true });
  });

  socket.on('cancel-quick-play', (_, ack) => {
    leaveQueue(socket.id);
    ack?.({ ok: true });
  });

  socket.on('start-with-ai', (_, ack) => {
    startWithAi(socket.id, io);
    ack?.({ ok: true });
  });

  // --- Game flow ---

  socket.on('start-game', ({ code }, ack) => {
    const result = startGame(code, socket.id);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });

    // Build player names map (including AI)
    const playerNames = getPlayerNames(result.room);

    // Emit cut ceremony to all clients
    io.to(code).emit('cut-ceremony', { ...result.cutResult, playerNames });

    // After 3s, transition to choosing phase
    setTimeout(() => {
      const room = getRoom(code);
      if (!room || room.phase !== 'cutting') return;
      room.phase = 'choosing';
      // Send personalized cut-choose to each human player
      for (const [socketId, player] of Object.entries(room.players)) {
        io.to(socketId).emit('cut-choose', {
          chooser: room.cutResult.chooser,
          winningTeam: room.cutResult.winningTeam,
          isChooser: player.seat === room.cutResult.chooser,
        });
      }
      // If chooser is AI, trigger AI pitcher choice
      if (isAiSeat(room, room.cutResult.chooser)) {
        triggerAiPitcherChoice(io, room);
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
      triggerAiTurn(io, result.room);
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
            // AI auto-ready for next hand
            if (!result.handResult.gameOver) {
              triggerAiReadyNextHand(io, room);
            }
          }, 500);
        } else {
          broadcastGameState(io, room);
          triggerAiTurn(io, room);
        }
      }, 800);
    } else {
      broadcastGameState(io, room);
      triggerAiTurn(io, room);
    }
  });

  socket.on('ready-next-hand', ({ code }, ack) => {
    const result = readyNextHand(code, socket.id);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });

    if (result.newHand) {
      io.to(code).emit('new-hand');
      broadcastGameState(io, result.room);
      triggerAiTurn(io, result.room);
    } else {
      io.to(code).emit('ready-count', { count: result.readyCount });
      // After human readies, trigger AI to ready too
      triggerAiReadyNextHand(io, result.room);
    }
  });

  socket.on('restart-game', ({ code }, ack) => {
    const result = restartGame(code, socket.id);
    if (result.error) return ack?.({ error: result.error });

    ack?.({ ok: true });

    // Build player names map (including AI)
    const playerNames = getPlayerNames(result.room);

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
      // If chooser is AI, trigger AI pitcher choice
      if (isAiSeat(room, room.cutResult.chooser)) {
        triggerAiPitcherChoice(io, room);
      }
    }, 3000);
  });

  socket.on('disconnect', () => {
    leaveQueue(socket.id); // Remove from matchmaking queue if present
    const result = handleDisconnect(socket.id);
    if (result?.room) {
      io.to(result.room.code).emit('room-state', getRoomState(result.room));
      io.to(result.room.code).emit('player-disconnected', {
        seat: result.seat,
        name: result.name,
      });

      // Start 30-second AI takeover timer for mid-game disconnects
      if (result.room.started && result.seat) {
        const room = result.room;
        const seat = result.seat;
        const name = result.name;
        const disc = room.disconnected.get(seat);
        if (disc) {
          disc.takeoverTimeout = setTimeout(() => {
            const took = aiTakeoverSeat(room, seat, name);
            if (!took) return;

            io.to(room.code).emit('room-state', getRoomState(room));
            io.to(room.code).emit('ai-takeover', {
              seat,
              name,
              aiName: room.aiPlayers[seat].name,
            });

            // Trigger appropriate AI action based on current game phase
            if (room.gameState && !room.gameState.handComplete && !room.gameState.gameOver
                && room.gameState.currentPlayer === seat) {
              triggerAiTurn(io, room);
            } else if (room.gameState && room.gameState.handComplete && !room.gameState.gameOver) {
              triggerAiReadyNextHand(io, room);
            } else if (room.phase === 'choosing' && room.cutResult?.chooser === seat) {
              triggerAiPitcherChoice(io, room);
            }
          }, 30_000);
        }
      }
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
