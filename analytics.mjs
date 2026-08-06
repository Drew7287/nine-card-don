// analytics.mjs — Server-side game analytics. No third party, no cookies, no personal data.
//
// Records what actually matters for a card game: how many games START, how many
// FINISH, whether people play other humans or bots, and where they drop out.
// Page-view analytics cannot answer any of that.
//
// Storage: newline-delimited JSON at data/events.jsonl, replayed on boot to rebuild
// the in-memory tallies. NOTE: Render's filesystem is EPHEMERAL, so a deploy or a
// platform-level restart wipes this. Surviving that needs a Render persistent disk or
// an external store; persist() below is the single seam to repoint when we decide.
// Every event is also written to stdout as a STAT line, so Render's own log stream is
// a second, independent copy.

import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const EVENTS_FILE = join(DATA_DIR, 'events.jsonl');

// Well under any plausible disk limit at this traffic; guards a runaway loop rather
// than real usage. At ~150 bytes/event that is roughly 65,000 events.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const bootedAt = new Date().toISOString();

// Live, in-flight state. Not persisted; a restart legitimately loses in-progress games.
const liveGames = new Map();   // room code -> { startedAt, humans, ais, hands, quickPlay }
let currentConnections = 0;

// Rebuilt from the event log on boot.
const tally = {
  connections: 0,
  roomsCreated: 0,
  queueJoins: 0,
  queueMatchedHumans: 0,   // matched into a game containing another human
  queueFilledWithAi: 0,    // timed out or "start with AI"
  gamesStarted: 0,
  gamesCompleted: 0,
  gamesAbandoned: 0,       // every human left mid-game
  handsPlayed: 0,
  aiTakeovers: 0,
  midGameDisconnects: 0,
  humanCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },  // humans per started game
  durationsMs: [],
  handsPerGame: [],
  byDay: {},               // 'YYYY-MM-DD' -> { started, completed, connections }
  byCountry: {},           // two-letter country code -> connections
  feedback: 0,
};

function day(iso) {
  return iso.slice(0, 10);
}

function bumpDay(iso, key) {
  const d = day(iso);
  tally.byDay[d] ||= { started: 0, completed: 0, connections: 0 };
  if (key in tally.byDay[d]) tally.byDay[d][key] += 1;
}

// Applies one event to the tallies. Used both by live recording and by the boot replay,
// so a replayed log and a live run can never diverge.
function apply(e) {
  switch (e.type) {
    case 'connect':
      tally.connections += 1;
      bumpDay(e.ts, 'connections');
      if (e.country) tally.byCountry[e.country] = (tally.byCountry[e.country] || 0) + 1;
      break;
    case 'feedback':
      tally.feedback += 1;
      break;
    case 'room_created':
      tally.roomsCreated += 1;
      break;
    case 'queue_join':
      tally.queueJoins += 1;
      break;
    case 'queue_matched':
      if (e.humans > 1) tally.queueMatchedHumans += 1;
      else tally.queueFilledWithAi += 1;
      break;
    case 'game_started':
      tally.gamesStarted += 1;
      if (tally.humanCounts[e.humans] !== undefined) tally.humanCounts[e.humans] += 1;
      bumpDay(e.ts, 'started');
      break;
    case 'hand_complete':
      tally.handsPlayed += 1;
      break;
    case 'game_completed':
      tally.gamesCompleted += 1;
      if (typeof e.durationMs === 'number') tally.durationsMs.push(e.durationMs);
      if (typeof e.hands === 'number') tally.handsPerGame.push(e.hands);
      bumpDay(e.ts, 'completed');
      break;
    case 'game_abandoned':
      tally.gamesAbandoned += 1;
      break;
    case 'ai_takeover':
      tally.aiTakeovers += 1;
      break;
    case 'disconnect_midgame':
      tally.midGameDisconnects += 1;
      break;
  }
}

function persist(line) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(EVENTS_FILE) && statSync(EVENTS_FILE).size > MAX_FILE_BYTES) return;
    appendFileSync(EVENTS_FILE, line + '\n');
  } catch (err) {
    // A read-only or full filesystem must never take the game down. stdout still has it.
    console.error('analytics persist failed:', err.message);
  }
}

/**
 * Record one event. Never throws: analytics failing must not break gameplay.
 * No IP, no user agent, no player names. Room codes are ephemeral and meaningless
 * once the room is gone, so nothing here identifies a person.
 */
export function record(type, props = {}) {
  try {
    const e = { ts: new Date().toISOString(), type, ...props };
    apply(e);
    const line = JSON.stringify(e);
    persist(line);
    console.log('STAT ' + line);
  } catch (err) {
    console.error('analytics record failed:', err.message);
  }
}

function replay() {
  try {
    if (!existsSync(EVENTS_FILE)) return 0;
    const lines = readFileSync(EVENTS_FILE, 'utf8').split('\n');
    let n = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        apply(JSON.parse(line));
        n += 1;
      } catch {
        // One corrupt line (half-written on a hard kill) must not lose the rest.
      }
    }
    return n;
  } catch (err) {
    console.error('analytics replay failed:', err.message);
    return 0;
  }
}

// --- Game lifecycle helpers -------------------------------------------------

export function gameStarted(code, { humans, ais, quickPlay = false }) {
  liveGames.set(code, { startedAt: Date.now(), humans, ais, hands: 0, quickPlay });
  record('game_started', { code, humans, ais, quickPlay });
}

export function handComplete(code) {
  const g = liveGames.get(code);
  if (g) g.hands += 1;
  record('hand_complete', { code, hand: g ? g.hands : null });
}

export function gameCompleted(code, winningTeam) {
  const g = liveGames.get(code);
  record('game_completed', {
    code,
    winningTeam,
    hands: g ? g.hands : null,
    durationMs: g ? Date.now() - g.startedAt : null,
    humans: g ? g.humans : null,
    quickPlay: g ? g.quickPlay : null,
  });
  liveGames.delete(code);
}

export function gameAbandoned(code) {
  const g = liveGames.get(code);
  if (!g) return;   // already completed, or never started; not an abandonment
  record('game_abandoned', {
    code,
    hands: g.hands,
    durationMs: Date.now() - g.startedAt,
    humans: g.humans,
  });
  liveGames.delete(code);
}

/**
 * @param country two-letter code from the edge (cf-ipcountry), or null if absent.
 * Country only, never the IP address, so nothing here identifies a person.
 */
export function connectionOpened(country = null) {
  currentConnections += 1;
  record('connect', country ? { country } : {});
}

export function connectionClosed() {
  currentConnections = Math.max(0, currentConnections - 1);
}

// --- Reporting --------------------------------------------------------------

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pct(n, d) {
  if (!d) return null;
  return Math.round((n / d) * 1000) / 10;
}

export function snapshot() {
  const avgMs = avg(tally.durationsMs);
  return {
    bootedAt,
    now: new Date().toISOString(),
    live: {
      connections: currentConnections,
      gamesInProgress: liveGames.size,
    },
    totals: {
      connections: tally.connections,
      roomsCreated: tally.roomsCreated,
      queueJoins: tally.queueJoins,
      queueMatchedWithHumans: tally.queueMatchedHumans,
      queueFilledWithAi: tally.queueFilledWithAi,
      gamesStarted: tally.gamesStarted,
      gamesCompleted: tally.gamesCompleted,
      gamesAbandoned: tally.gamesAbandoned,
      handsPlayed: tally.handsPlayed,
      aiTakeovers: tally.aiTakeovers,
      midGameDisconnects: tally.midGameDisconnects,
      feedback: tally.feedback,
    },
    rates: {
      completionPct: pct(tally.gamesCompleted, tally.gamesStarted),
      startPerConnectionPct: pct(tally.gamesStarted, tally.connections),
      avgHandsPerCompletedGame: avg(tally.handsPerGame),
      avgGameMinutes: avgMs === null ? null : Math.round(avgMs / 600) / 100,
    },
    humansPerGame: tally.humanCounts,
    byCountry: tally.byCountry,
    byDay: tally.byDay,
  };
}

const replayed = replay();
console.log(`analytics ready (${replayed} events replayed from disk)`);
