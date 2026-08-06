import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerHandlers } from './socket-handlers.mjs';
import { processQueue, queueSize } from './matchmaking.mjs';
import { snapshot, connectionOpened, connectionClosed, record } from './analytics.mjs';
import * as notify from './notify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http);

// Render sits behind a proxy; without this req.ip is the proxy, so the feedback rate
// limit would treat every visitor on earth as one client.
app.set('trust proxy', 1);

// Game stats. Gated on a shared secret so the numbers are not public; with STATS_TOKEN
// unset the route 404s exactly like any unknown path, so its existence is not advertised.
app.get('/stats', (req, res) => {
  const expected = process.env.STATS_TOKEN;
  const supplied = req.query.token || req.get('x-stats-token');
  if (!expected || supplied !== expected) return res.status(404).send('Not found');
  res.set('Cache-Control', 'no-store').json(snapshot());
});

// Broadcast line shown to every player. Set ANNOUNCEMENT in the Render environment;
// empty or unset means the banner never renders.
app.get('/announcement', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ text: (process.env.ANNOUNCEMENT || '').trim() });
});

// --- Player feedback --------------------------------------------------------
// Goes straight to Telegram. Disk is ephemeral here, so a file would be lost at the
// next deploy, and unlike a counter a player's message cannot be reconstructed.

const MAX_MESSAGE = 2000;
const RATE_WINDOW_MS = 60 * 60_000;
const RATE_MAX = 5;
const rate = new Map();   // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const hits = (rate.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rate.set(ip, hits);
  if (rate.size > 5000) rate.clear();   // crude bound; this is a hobby game, not a SaaS
  return hits.length > RATE_MAX;
}

app.post('/feedback', express.json({ limit: '16kb' }), (req, res) => {
  try {
    const message = String(req.body?.message || '').trim().slice(0, MAX_MESSAGE);
    if (message.length < 3) return res.status(400).json({ error: 'Message required' });
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many messages, try later' });

    const name = String(req.body?.name || '').trim().slice(0, 40);
    const email = String(req.body?.email || '').trim().slice(0, 120);
    const context = String(req.body?.context || '').trim().slice(0, 300);

    // Everything above is treated as text end to end: it is sent to Telegram as a plain
    // string with no parse_mode, and never rendered as HTML anywhere.
    notify.feedback({ message, name, email, context });
    record('feedback', { hasEmail: Boolean(email), len: message.length });
    res.json({ ok: true });
  } catch (err) {
    console.error('feedback failed:', err.message);
    res.status(500).json({ error: 'Could not send' });
  }
});

app.use(express.static(join(__dirname, 'public')));

// Headless browsers, crawlers and our own Playwright verification runs are not visits.
// Left unfiltered they ping the phone and inflate the connection count; the morning of
// 6 Aug produced five Telegram pings, all of them our own test runs.
const BOT_UA = /headless|bot\b|crawler|spider|slurp|bingpreview|playwright|puppeteer|python-requests|curl\/|wget|axios|lighthouse|pingdom|uptime/i;

// --- Presence ---------------------------------------------------------------
// "Players online" counts real people only. Counting crawlers and our own test runs
// would show a busy site to someone sitting on their own, which is worse than a
// truthful 1: they would wait for a Quick Play match that is never coming.

const humanSockets = new Set();
let lastPresence = '';

function broadcastPresence() {
  const payload = { online: humanSockets.size, inQueue: queueSize() };
  const key = JSON.stringify(payload);
  if (key === lastPresence) return;   // nothing changed; do not chatter at every client
  lastPresence = key;
  io.emit('presence', payload);
}

io.on('connection', (socket) => {
  console.log(`connected: ${socket.id}`);

  // Country only, taken from the edge header. No IP is recorded or stored.
  const h = socket.handshake.headers || {};
  const country = h['cf-ipcountry'] || h['x-vercel-ip-country'] || null;
  const ua = (h['user-agent'] || '').slice(0, 200);
  // Our own verification runs spoof a real Chrome user agent on purpose, to prove the
  // presence counter counts humans. That defeats BOT_UA, so they announce themselves
  // with a header instead. A real player's browser never sends it.
  const isBot = h['x-marvin-verify'] === '1' || BOT_UA.test(ua);

  connectionOpened(country, isBot);
  if (!isBot) {
    notify.visit({ country, ua: ua.slice(0, 120) });
    humanSockets.add(socket.id);
  }
  broadcastPresence();

  registerHandlers(io, socket);
  socket.on('disconnect', () => {
    console.log(`disconnected: ${socket.id}`);
    connectionClosed();
    humanSockets.delete(socket.id);
    broadcastPresence();
  });
});

// Process matchmaking queue every 2 seconds
setInterval(() => {
  processQueue(io);
  broadcastPresence();   // keeps the queue figure fresh without its own timer
}, 2000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Nine-Card Don running on http://localhost:${PORT}`);
});
