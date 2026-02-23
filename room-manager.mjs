// room-manager.mjs — Room lifecycle, player join/leave

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

  // Check if this name was disconnected — allow rejoin
  for (const [seat, disc] of room.disconnected.entries()) {
    if (disc.name === playerName) {
      clearTimeout(disc.timeout);
      room.disconnected.delete(seat);
      room.seats[seat] = socketId;
      room.players[socketId] = { name: playerName, seat };
      socketToRoom.set(socketId, { code: room.code, seat });
      return { ok: true, room, seat, rejoined: true };
    }
  }

  if (Object.keys(room.players).length >= 4 && !room.disconnected.size) {
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

  if (room.seats[seat] && room.seats[seat] !== socketId) {
    return { error: 'Seat taken' };
  }

  room.seats[seat] = socketId;
  player.seat = seat;
  socketToRoom.set(socketId, { code: room.code, seat });
  return { ok: true, room };
}

export function startGame(code, socketId) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };

  // All 4 seats must be filled
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
      // Mark as disconnected with 2-min rejoin window
      const timeout = setTimeout(() => {
        room.disconnected.delete(seat);
        // If all players gone, delete room
        if (Object.keys(room.players).length === 0 && room.disconnected.size === 0) {
          rooms.delete(room.code);
        }
      }, 120_000);

      room.disconnected.set(seat, { name, timeout });
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
    const socketId = room.seats[seat];
    if (socketId && room.players[socketId]) {
      seats[seat] = { name: room.players[socketId].name, connected: true };
    } else if (room.disconnected.has(seat)) {
      seats[seat] = { name: room.disconnected.get(seat).name, connected: false };
    } else {
      seats[seat] = null;
    }
  }

  return {
    code: room.code,
    seats,
    started: room.started,
    playerCount: Object.keys(room.players).length,
  };
}

export function getPersonalGameState(room, socketId) {
  if (!room.gameState) return null;
  const player = room.players[socketId];
  if (!player || !player.seat) return null;
  const view = personalView(room.gameState, player.seat);

  // Attach player names keyed by seat
  view.playerNames = {};
  for (const seat of SEATS) {
    const sid = room.seats[seat];
    if (sid && room.players[sid]) {
      view.playerNames[seat] = room.players[sid].name;
    } else if (room.disconnected.has(seat)) {
      view.playerNames[seat] = room.disconnected.get(seat).name;
    }
  }

  return view;
}
