// room-manager.mjs — Room lifecycle, player join/leave, AI seat management

import { createGameState, newHand, personalView, playCard as enginePlayCard, performCut, getPartner, SEATS } from './game-engine.mjs';

const rooms = new Map(); // code -> room
const socketToRoom = new Map(); // socketId -> { code, seat }

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // No I or O to avoid confusion
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

export function createRoom(hostName) {
  const code = generateCode();
  const room = {
    code,
    seats: { N: null, E: null, S: null, W: null },
    players: {}, // socketId -> { name, seat }
    aiSeats: new Set(),   // seats occupied by AI
    aiPlayers: {},        // seat -> { name }
    gameState: null,
    started: false,
    readyForNext: new Set(), // seats ready for next hand
    disconnected: new Map(), // seat -> { name, timeout }
  };
  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

export function joinRoom(code, socketId, playerName) {
  const room = rooms.get(code.toUpperCase());
  if (!room) return { error: 'Room not found' };
  if (room.players[socketId]) return { error: 'Already in room' };

  // Check if this name was disconnected — allow rejoin (case-insensitive)
  for (const [seat, disc] of room.disconnected.entries()) {
    if (disc.name.toLowerCase() === playerName.toLowerCase()) {
      clearTimeout(disc.timeout);
      if (disc.takeoverTimeout) clearTimeout(disc.takeoverTimeout);
      room.disconnected.delete(seat);

      // Reclaim from AI if it took over during absence
      const wasAiTakeover = room.aiSeats.has(seat);
      if (wasAiTakeover) {
        room.aiSeats.delete(seat);
        delete room.aiPlayers[seat];
      }

      room.seats[seat] = socketId;
      room.players[socketId] = { name: playerName, seat };
      socketToRoom.set(socketId, { code: room.code, seat });
      return { ok: true, room, seat, rejoined: true, wasAiTakeover };
    }
  }

  // Count human players (exclude AI)
  const humanCount = Object.keys(room.players).length;
  const aiCount = room.aiSeats.size;
  if (humanCount + aiCount >= 4 && !room.disconnected.size) {
    return { error: 'Room is full' };
  }

  room.players[socketId] = { name: playerName, seat: null };
  socketToRoom.set(socketId, { code: room.code, seat: null });
  return { ok: true, room };
}

export function sitDown(code, socketId, seat) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };
  const player = room.players[socketId];
  if (!player) return { error: 'Not in room' };
  if (!SEATS.includes(seat)) return { error: 'Invalid seat' };
  if (room.started) return { error: 'Game already started' };

  // Unseat from current seat if any
  if (player.seat) {
    room.seats[player.seat] = null;
  }

  // If AI is in this seat, remove it first
  if (room.aiSeats.has(seat)) {
    room.aiSeats.delete(seat);
    delete room.aiPlayers[seat];
  } else if (room.seats[seat] && room.seats[seat] !== socketId) {
    return { error: 'Seat taken' };
  }

  room.seats[seat] = socketId;
  player.seat = seat;
  socketToRoom.set(socketId, { code: room.code, seat });
  return { ok: true, room };
}

// --- AI seat management ---

export function addAiToSeat(code, seat, aiName) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };
  if (!SEATS.includes(seat)) return { error: 'Invalid seat' };
  if (room.started) return { error: 'Game already started' };
  if (room.seats[seat] && !room.aiSeats.has(seat)) return { error: 'Seat taken' };

  room.seats[seat] = `ai-${seat}`;
  room.aiSeats.add(seat);
  room.aiPlayers[seat] = { name: aiName };
  return { ok: true, room };
}

export function removeAiFromSeat(code, seat) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };
  if (!room.aiSeats.has(seat)) return { error: 'No AI in that seat' };
  if (room.started) return { error: 'Game already started' };

  room.seats[seat] = null;
  room.aiSeats.delete(seat);
  delete room.aiPlayers[seat];
  return { ok: true, room };
}

// --- BySeat functions (for AI — no socketId needed) ---

export function playCardBySeat(code, seat, card) {
  const room = rooms.get(code);
  if (!room || !room.gameState) return { error: 'No active game' };

  const result = enginePlayCard(room.gameState, seat, card);
  return { ...result, room, seat };
}

export function choosePitcherBySeat(code, seat, choice) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };
  if (room.phase !== 'choosing') return { error: 'Not in choosing phase' };
  if (seat !== room.cutResult.chooser) return { error: 'Not the chooser' };

  let pitcherSeat;
  if (choice === 'self') {
    pitcherSeat = room.cutResult.chooser;
  } else {
    pitcherSeat = getPartner(room.cutResult.chooser);
  }

  room.phase = 'playing';
  room.gameState = createGameState(pitcherSeat);
  return { ok: true, room, pitcherSeat };
}

export function readyNextHandBySeat(code, seat) {
  const room = rooms.get(code);
  if (!room || !room.gameState) return { error: 'No active game' };
  if (!room.gameState.handComplete) return { error: 'Hand not complete' };
  if (room.gameState.gameOver) return { error: 'Game is over' };

  room.readyForNext.add(seat);

  if (room.readyForNext.size === 4) {
    room.gameState = newHand(room.gameState);
    room.readyForNext = new Set();
    return { ok: true, newHand: true, room };
  }

  return { ok: true, newHand: false, readyCount: room.readyForNext.size, room };
}

// --- Existing functions (unchanged or lightly modified) ---

export function startGame(code, socketId) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };

  // All 4 seats must be filled (human or AI)
  for (const seat of SEATS) {
    if (!room.seats[seat]) return { error: `Seat ${seat} is empty` };
  }

  room.started = true;
  room.gameState = null; // No game state yet — waiting for cut ceremony
  room.phase = 'cutting';
  room.cutResult = performCut();
  room.readyForNext = new Set();
  return { ok: true, room, cutResult: room.cutResult };
}

export function restartGame(code, socketId) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };
  if (!room.started) return { error: 'Game not started' };

  for (const seat of SEATS) {
    if (!room.seats[seat]) return { error: `Seat ${seat} is empty` };
  }

  room.gameState = null;
  room.phase = 'cutting';
  room.cutResult = performCut();
  room.readyForNext = new Set();
  return { ok: true, room, cutResult: room.cutResult };
}

export function choosePitcher(code, socketId, choice) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };
  if (room.phase !== 'choosing') return { error: 'Not in choosing phase' };

  const player = room.players[socketId];
  if (!player || !player.seat) return { error: 'Not seated' };
  if (player.seat !== room.cutResult.chooser) return { error: 'Not the chooser' };

  let pitcherSeat;
  if (choice === 'self') {
    pitcherSeat = room.cutResult.chooser;
  } else {
    pitcherSeat = getPartner(room.cutResult.chooser);
  }

  room.phase = 'playing';
  room.gameState = createGameState(pitcherSeat);
  return { ok: true, room, pitcherSeat };
}

export function playCardInRoom(code, socketId, card) {
  const room = rooms.get(code);
  if (!room || !room.gameState) return { error: 'No active game' };
  const player = room.players[socketId];
  if (!player || !player.seat) return { error: 'Not seated' };

  const result = enginePlayCard(room.gameState, player.seat, card);
  return { ...result, room, seat: player.seat };
}

export function readyNextHand(code, socketId) {
  const room = rooms.get(code);
  if (!room || !room.gameState) return { error: 'No active game' };
  if (!room.gameState.handComplete) return { error: 'Hand not complete' };
  if (room.gameState.gameOver) return { error: 'Game is over' };

  const player = room.players[socketId];
  if (!player || !player.seat) return { error: 'Not seated' };

  room.readyForNext.add(player.seat);

  if (room.readyForNext.size === 4) {
    room.gameState = newHand(room.gameState);
    room.readyForNext = new Set();
    return { ok: true, newHand: true, room };
  }

  return { ok: true, newHand: false, readyCount: room.readyForNext.size, room };
}

export function handleDisconnect(socketId) {
  const info = socketToRoom.get(socketId);
  if (!info) return null;

  const room = rooms.get(info.code);
  if (!room) { socketToRoom.delete(socketId); return null; }

  const player = room.players[socketId];
  if (!player) { socketToRoom.delete(socketId); return null; }

  const seat = player.seat;
  const name = player.name;

  delete room.players[socketId];
  socketToRoom.delete(socketId);

  if (seat) {
    room.seats[seat] = null;

    if (room.started) {
      // Mark as disconnected with 5-min rejoin window (AI takes over after 30s)
      const timeout = setTimeout(() => {
        room.disconnected.delete(seat);
        // If all humans gone and no one reconnecting, delete room
        if (Object.keys(room.players).length === 0 && room.disconnected.size === 0) {
          rooms.delete(room.code);
        }
      }, 300_000);

      room.disconnected.set(seat, { name, timeout, takeoverTimeout: null });
    }
  }

  // Clean up empty unstarted rooms
  if (!room.started && Object.keys(room.players).length === 0) {
    rooms.delete(room.code);
  }

  return { room, seat, name };
}

export function getRoomState(room) {
  const seats = {};
  for (const seat of SEATS) {
    if (room.aiSeats.has(seat)) {
      seats[seat] = { name: room.aiPlayers[seat].name, connected: true, isAi: true };
    } else {
      const socketId = room.seats[seat];
      if (socketId && room.players[socketId]) {
        seats[seat] = { name: room.players[socketId].name, connected: true };
      } else if (room.disconnected.has(seat)) {
        seats[seat] = { name: room.disconnected.get(seat).name, connected: false };
      } else {
        seats[seat] = null;
      }
    }
  }

  return {
    code: room.code,
    seats,
    started: room.started,
    playerCount: Object.keys(room.players).length + room.aiSeats.size,
  };
}

export function getPersonalGameState(room, socketId) {
  if (!room.gameState) return null;
  const player = room.players[socketId];
  if (!player || !player.seat) return null;
  const view = personalView(room.gameState, player.seat);

  // Attach player names keyed by seat (including AI)
  view.playerNames = {};
  for (const seat of SEATS) {
    if (room.aiSeats.has(seat)) {
      view.playerNames[seat] = room.aiPlayers[seat].name;
    } else {
      const sid = room.seats[seat];
      if (sid && room.players[sid]) {
        view.playerNames[seat] = room.players[sid].name;
      } else if (room.disconnected.has(seat)) {
        view.playerNames[seat] = room.disconnected.get(seat).name;
      }
    }
  }

  // Include AI seat list for UI indicators
  view.aiSeats = [...room.aiSeats];

  return view;
}

/**
 * AI takes over a disconnected player's seat.
 * Returns true if takeover succeeded, false if seat was already reclaimed or taken over.
 */
export function aiTakeoverSeat(room, seat, originalName) {
  if (!room.disconnected.has(seat)) return false; // Already rejoined
  if (room.aiSeats.has(seat)) return false; // Already taken over

  room.seats[seat] = `ai-${seat}`;
  room.aiSeats.add(seat);
  room.aiPlayers[seat] = { name: `Bot (${originalName})` };
  return true;
}

/**
 * Build player names map including AI (used for cut ceremony display).
 */
export function getPlayerNames(room) {
  const playerNames = {};
  for (const seat of SEATS) {
    if (room.aiSeats.has(seat)) {
      playerNames[seat] = room.aiPlayers[seat].name;
    } else {
      const sid = room.seats[seat];
      if (sid && room.players[sid]) {
        playerNames[seat] = room.players[sid].name;
      }
    }
  }
  return playerNames;
}
