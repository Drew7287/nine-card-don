// ai-controller.mjs — Orchestrates AI turns, timing, chaining
// No socket connections — calls room-manager directly.

import { aiChooseCard, aiChoosePitcher, AI_DELAY_MIN, AI_DELAY_MAX, PITCH_DELAY, READY_DELAY } from './ai-player.mjs';
import { playCardBySeat, choosePitcherBySeat, readyNextHandBySeat, getPersonalGameState } from './room-manager.mjs';

function aiDelay() {
  return AI_DELAY_MIN + Math.floor(Math.random() * (AI_DELAY_MAX - AI_DELAY_MIN));
}

export function isAiSeat(room, seat) {
  return room.aiSeats.has(seat);
}

export function getAiName(room, seat) {
  return room.aiPlayers[seat]?.name;
}

/**
 * If current player is AI, schedule their card play after a delay.
 * After play, broadcasts state and chains to next AI turn if needed.
 */
export function triggerAiTurn(io, room) {
  if (!room.gameState || room.gameState.handComplete || room.gameState.gameOver) return;
  if (room.aiProcessing) return; // Prevent double-triggers

  const currentSeat = room.gameState.currentPlayer;
  if (!isAiSeat(room, currentSeat)) return;

  room.aiProcessing = true;

  setTimeout(() => {
    room.aiProcessing = false;

    // Re-check state (may have changed during delay)
    if (!room.gameState || room.gameState.handComplete || room.gameState.gameOver) return;
    if (room.gameState.currentPlayer !== currentSeat) return;

    const card = aiChooseCard(room.gameState, currentSeat);
    if (!card) return;

    const result = playCardBySeat(room.code, currentSeat, card);
    if (result.error) {
      console.error(`AI play error (${currentSeat}):`, result.error);
      return;
    }

    // Broadcast card played
    io.to(room.code).emit('card-played', {
      seat: currentSeat,
      card,
      pitchRevealed: result.pitchRevealed,
      trumpSuit: result.pitchRevealed ? room.gameState.trumpSuit : undefined,
    });

    // Handle trick complete
    if (result.trickResult) {
      setTimeout(() => {
        io.to(room.code).emit('trick-complete', result.trickResult);

        if (result.handResult) {
          setTimeout(() => {
            io.to(room.code).emit('hand-complete', result.handResult);
            broadcastGameState(io, room);
            // AI auto-ready for next hand
            if (!result.handResult.gameOver) {
              triggerAiReadyNextHand(io, room);
            }
          }, 500);
        } else {
          broadcastGameState(io, room);
          // Chain to next AI turn
          triggerAiTurn(io, room);
        }
      }, 800);
    } else {
      broadcastGameState(io, room);
      // Chain to next AI turn
      triggerAiTurn(io, room);
    }
  }, aiDelay());
}

/**
 * AI handles pitcher choice during cut ceremony.
 * Cards aren't dealt yet, so AI defaults to pitching self.
 */
export function triggerAiPitcherChoice(io, room) {
  if (!room.cutResult) return;
  const chooserSeat = room.cutResult.chooser;
  if (!isAiSeat(room, chooserSeat)) return;

  setTimeout(() => {
    const choice = aiChoosePitcher();

    const result = choosePitcherBySeat(room.code, chooserSeat, choice);
    if (result.error) {
      console.error('AI pitcher choice error:', result.error);
      return;
    }

    // Broadcast
    io.to(room.code).emit('pitcher-chosen', { pitcherSeat: result.pitcherSeat });

    setTimeout(() => {
      io.to(room.code).emit('game-started');
      broadcastGameState(io, room);
      triggerAiTurn(io, room);
    }, 1500);
  }, PITCH_DELAY);
}

/**
 * AI auto-readies for next hand. Staggered timing.
 */
export function triggerAiReadyNextHand(io, room) {
  let delay = READY_DELAY;
  for (const seat of room.aiSeats) {
    const d = delay; // Capture for closure
    setTimeout(() => {
      if (!room.gameState || !room.gameState.handComplete || room.gameState.gameOver) return;
      if (room.readyForNext.has(seat)) return; // Already readied

      const result = readyNextHandBySeat(room.code, seat);
      if (result.error) return;

      if (result.newHand) {
        io.to(room.code).emit('new-hand');
        broadcastGameState(io, room);
        triggerAiTurn(io, room);
      } else {
        io.to(room.code).emit('ready-count', { count: result.readyCount });
      }
    }, d);
    delay += 300; // Stagger
  }
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
