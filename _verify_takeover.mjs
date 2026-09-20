// Verify joining a game in progress by taking a bot's seat (Drew, 20 Sep 2026).
//
// Drives the REAL server over a real socket: starts a game against bots as one
// player, then connects a SECOND client and has it take a bot's seat. Asserting
// against room-manager alone would prove the functions, not the feature, and the
// whole point is that a second human ends up holding a seat in a live game.
//
// Runs against a local server on PORT, never production.
import { io as ioClient } from 'socket.io-client';

const URL = process.env.TEST_URL || 'http://localhost:3010';
let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  // Announce ourselves as a bot so the presence counter is not polluted by the
  // test, exactly as server.mjs documents.
  const s = ioClient(URL, { extraHeaders: { 'x-marvin-verify': '1' }, transports: ['websocket'] });
  return new Promise((res, rej) => {
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
    s.on('disconnect', (reason) => console.log(`  [client dropped: ${reason}]`));
  });
}

const emit = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));

const a = await connect();

// Alice starts a game on her own; AI fills the other three seats.
const qp = await emit(a, 'quick-play', { playerName: 'Alice' });
console.log('quick-play:', JSON.stringify(qp));
// There is a cut ceremony before any cards exist: room.gameState stays null
// until the cut winner picks a pitcher, so a game mid-cut is correctly not
// joinable. If the chooser is Alice and nobody answers, the game never starts
// at all, so the test has to play her part. Declared before the handlers that
// read it, or the first event in hits the temporal dead zone.
let roomCode = null;
a.on('room-state', (st) => { roomCode = st?.code || roomCode; });
a.on('cut-choose', ({ isChooser }) => {
  if (isChooser && roomCode) emit(a, 'choose-pitcher', { code: roomCode, choice: 'self' });
});
await emit(a, 'start-with-ai', {});
await sleep(9000);
console.log('room:', roomCode);

let listed = await emit(a, 'list-open-games', {});
check('a game in progress is listed', listed.games.length, 1);
const game = listed.games[0];
check('it offers three bot seats', game.openSeats.length, 3);
check('one human is at the table', game.humansPresent, 1);

// Bob arrives while that game is running and takes a bot's seat.
const b = await connect();
const seat = game.openSeats[0].seat;

let gotGameState = false;
b.on('game-state', () => { gotGameState = true; });

const took = await emit(b, 'take-over-seat',
  { code: game.code, seat, playerName: 'Bob' });
console.log('take-over-seat:', JSON.stringify(took));
check('Bob is seated', took.ok, true);
check('in the seat he asked for', took.seat, seat);

await sleep(800);
check('and he is dealt into the live hand', gotGameState, true);

// The table now holds two real people, which the queue has never once managed.
listed = await emit(a, 'list-open-games', {});
check('two humans are now at the table', listed.games[0].humansPresent, 2);
check('and only two bot seats are left', listed.games[0].openSeats.length, 2);

// The same seat cannot be taken twice.
const c = await connect();
const again = await emit(c, 'take-over-seat',
  { code: game.code, seat, playerName: 'Carol' });
check('the seat cannot be taken twice', again.error, 'Somebody just took that seat');

// A duplicate name is refused, because rejoin-by-name would be ambiguous later.
const dupe = await emit(c, 'take-over-seat',
  { code: game.code, seat: listed.games[0].openSeats[0].seat, playerName: 'Bob' });
check('a duplicate name is refused',
      dupe.error, 'Somebody at that table already has your name, pick another');

// An unknown table is refused rather than throwing.
const gone = await emit(c, 'take-over-seat',
  { code: 'ZZZZ', seat: 'N', playerName: 'Carol' });
check('an unknown table is refused', gone.error, 'That game has finished');

/* A seat being held for a player who dropped is THEIRS for the rejoin window,
   even once a bot is sitting in it. Offering it to a stranger would take
   somebody's game off them mid-hand. This case was added after a mutation that
   removed that guard passed the whole suite: the most consequential rule in the
   feature was the one nothing tested.

   Bob drops, an AI takes his seat 30 s later, and his seat must still never
   appear in the listing. */
console.log('  (waiting out the 30 s AI takeover window)');
b.close();
await sleep(34000);

const afterDrop = await emit(a, 'list-open-games', {});
const stillThere = afterDrop.games.find((g) => g.code === game.code);
const offeredSeats = (stillThere?.openSeats || []).map((x) => x.seat);
check('a bot now holds the dropped seat, but it is not offered',
      offeredSeats.includes(seat), false);
check('the other bot seats are still offered', offeredSeats.length, 2);

for (const s of [a, b, c]) s.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
