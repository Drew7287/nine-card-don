// matchmaking.mjs — Quick Play queue + auto-fill with AI

import {
  createRoom, joinRoom, sitDown, startGame, getRoom, getRoomState,
  getPlayerNames, addAiToSeat
} from './room-manager.mjs';
import { AI_NAMES } from './ai-player.mjs';
import { triggerAiPitcherChoice, triggerAiTurn, isAiSeat } from './ai-controller.mjs';
import { SEATS } from './game-engine.mjs';

const queue = new Map(); // socketId -> { playerName, joinedAt }

export function joinQueue(socketId, playerName) {
  queue.set(socketId, { playerName, joinedAt: Date.now() });
}

export function leaveQueue(socketId) {
  queue.delete(socketId);
}

export function processQueue(io) {
  if (queue.size === 0) return;

  const entries = [...queue.entries()];

  // 4 humans → create room, seat all, start
  if (entries.length >= 4) {
    createMatchedRoom(io, entries.slice(0, 4));
    return;
  }

  // 2-3 humans waiting >10s → fill with AI
  if (entries.length >= 2) {
    const oldest = entries[0][1].joinedAt;
    if (Date.now() - oldest > 10000) {
      createMatchedRoom(io, entries);
      return;
    }
  }

  // Broadcast queue status to waiting players
  for (const [socketId] of entries) {
    io.to(socketId).emit('queue-status', { count: queue.size });
  }
}

export function startWithAi(socketId, io) {
  const entry = queue.get(socketId);
  if (!entry) return;
  createMatchedRoom(io, [[socketId, entry]]);
}

function createMatchedRoom(io, group) {
  // Remove from queue
  for (const [socketId] of group) {
    queue.delete(socketId);
  }

  const room = createRoom('Quick Play');
  const code = room.code;

  // Seat humans
  let seatIdx = 0;
  const humanSockets = [];
  for (const [socketId, { playerName }] of group) {
    joinRoom(code, socketId, playerName);
    const socket = io.sockets.sockets.get(socketId);
    if (socket) socket.join(code);
    sitDown(code, socketId, SEATS[seatIdx]);
    humanSockets.push(socketId);
    seatIdx++;
  }

  // Fill remaining seats with AI
  let aiIdx = 0;
  while (seatIdx < 4) {
    addAiToSeat(code, SEATS[seatIdx], AI_NAMES[aiIdx]);
    seatIdx++;
    aiIdx++;
  }

  // Notify matched players
  for (const socketId of humanSockets) {
    io.to(socketId).emit('queue-matched', { code });
  }

  // Broadcast room state
  io.to(code).emit('room-state', getRoomState(room));

  // Start the game
  const result = startGame(code, humanSockets[0]);
  if (result.error) {
    console.error('Quick Play start error:', result.error);
    return;
  }

  // Build player names map (including AI)
  const playerNames = getPlayerNames(room);

  io.to(code).emit('cut-ceremony', { ...result.cutResult, playerNames });

  setTimeout(() => {
    const r = getRoom(code);
    if (!r || r.phase !== 'cutting') return;
    r.phase = 'choosing';

    for (const [socketId, player] of Object.entries(r.players)) {
      io.to(socketId).emit('cut-choose', {
        chooser: r.cutResult.chooser,
        winningTeam: r.cutResult.winningTeam,
        isChooser: player.seat === r.cutResult.chooser,
      });
    }

    if (isAiSeat(r, r.cutResult.chooser)) {
      triggerAiPitcherChoice(io, r);
    }
  }, 3000);
}
