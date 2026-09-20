// Verify the concurrency measure before it ships (Drew, 20 Sep 2026).
//
// Drives notePresence through a scripted arrival/departure pattern with real
// waits, then checks the report against what the pattern must produce. A test
// that only proved "a number came back" would pass on a broken accumulator, so
// every assertion below names an expected value derived from the script itself.
import { notePresence, snapshot } from './analytics.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(label, actual, expected, tolerance = 0) {
  const ok = tolerance ? Math.abs(actual - expected) <= tolerance : actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}` +
              (tolerance ? ` (+/- ${tolerance})` : ''));
  if (!ok) failures += 1;
}

// nobody on, then one person, then two together, then back to one, then empty.
await sleep(200);
notePresence(1);            // one person arrives
await sleep(400);
notePresence(2);            // second person joins them  -> episode 1
await sleep(600);
notePresence(1);            // one leaves
await sleep(300);
notePresence(0);            // empty
await sleep(200);
notePresence(3);            // three arrive at once       -> episode 2, new peak
await sleep(500);
notePresence(1);

const c = snapshot().concurrency;
console.log('\nreport:', JSON.stringify(c, null, 2));

check('onlineNow', c.onlineNow, 1);
check('peakOnline', c.peakOnline, 3);
// 1 -> 2 and 0 -> 3 both count; 2 -> 1 -> 0 does not, and neither does 3 -> 1.
check('togetherEpisodes', c.togetherEpisodes, 2);
// 600 ms at two, 500 ms at three = 1.1 s with two or more.
check('minutesWithTwoOrMore', c.minutesWithTwoOrMore, 1100 / 60000, 0.004);
check('lastTogetherAt is set', typeof c.lastTogetherAt, 'string');
// The ongoing stretch must be inside its own report, not missing until the next
// change. measuredMinutes is rounded to 2dp of a MINUTE, i.e. 0.6 s per step, so
// the wait has to clear that or the check fails on rounding rather than on the
// thing it is testing. 1.5 s must move it.
const before = snapshot().concurrency.measuredMinutes;
await sleep(1500);
const after = snapshot().concurrency.measuredMinutes;
check('an ongoing stretch is banked into the report', after > before, true);
check('and it lands at the level currently held', 
      snapshot().concurrency.minutesByOnlineCount[1] > 0, true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
