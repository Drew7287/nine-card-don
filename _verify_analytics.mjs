// _verify_analytics.mjs — drives real games through the real room-manager and engine,
// then prints the snapshot. Not part of the app; delete or keep as a smoke test.
//
//   node _verify_analytics.mjs

import {
  createRoom, joinRoom, sitDown, startGame, addAiToSeat,
  choosePitcherBySeat, playCardBySeat, readyNextHandBySeat, handleDisconnect, getRoom,
} from './room-manager.mjs';
import { aiChooseCard } from './ai-player.mjs';
import { snapshot } from './analytics.mjs';
import { SEATS } from './game-engine.mjs';

function must(result, what) {
  if (!result || result.error) throw new Error(`${what} failed: ${result?.error}`);
  return result;
}

function playToCompletion(code, maxHands = 60) {
  const room = getRoom(code);
  let guard = 0;
  while (!room.gameState.gameOver && guard++ < 5000) {
    if (room.gameState.handComplete) {
      for (const seat of SEATS) readyNextHandBySeat(code, seat);
      if (--maxHands <= 0) throw new Error('hand limit hit');
      continue;
    }
    const seat = room.gameState.currentPlayer;
    const card = aiChooseCard(room.gameState, seat);
    if (!card) throw new Error(`no card chosen for ${seat}`);
    playCardBySeat(code, seat, card);
  }
  if (guard >= 5000) throw new Error('play loop did not terminate');
  return room.gameState;
}

// --- Game 1: one human, three bots, played to a real finish -----------------
const r1 = createRoom('Tester');
joinRoom(r1.code, 'sock-1', 'Tester');
sitDown(r1.code, 'sock-1', 'N');
for (const s of ['E', 'S', 'W']) addAiToSeat(r1.code, s, `Bot ${s}`);
startGame(r1.code, 'sock-1');
// Live, socket-handlers flips this after the 3s cut ceremony; choosePitcher rejects
// anything not in 'choosing'.
getRoom(r1.code).phase = 'choosing';
must(choosePitcherBySeat(r1.code, r1.cutResult.chooser, 'self'), 'choose pitcher g1');
const end1 = playToCompletion(r1.code);
console.log(`\ngame 1 finished: winner ${end1.winner}, scores`, end1.scores);

// --- Game 2: two humans, two bots, abandoned mid-game -----------------------
const r2 = createRoom('A');
joinRoom(r2.code, 'sock-2', 'A');
sitDown(r2.code, 'sock-2', 'N');
joinRoom(r2.code, 'sock-3', 'B');
sitDown(r2.code, 'sock-3', 'S');
for (const s of ['E', 'W']) addAiToSeat(r2.code, s, `Bot ${s}`);
startGame(r2.code, 'sock-2');
getRoom(r2.code).phase = 'choosing';
must(choosePitcherBySeat(r2.code, r2.cutResult.chooser, 'self'), 'choose pitcher g2');

// Play a few cards, then both humans walk.
const room2 = getRoom(r2.code);
for (let i = 0; i < 6; i++) {
  const seat = room2.gameState.currentPlayer;
  playCardBySeat(r2.code, seat, aiChooseCard(room2.gameState, seat));
}
handleDisconnect('sock-2');
handleDisconnect('sock-3');
console.log('game 2 abandoned mid-hand (2 mid-game disconnects recorded)');
console.log('  abandonment itself fires on the 5-minute rejoin timer, not now');

console.log('\n=== SNAPSHOT ===');
console.log(JSON.stringify(snapshot(), null, 2));
process.exit(0);
