import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerHandlers } from './socket-handlers.mjs';
import { processQueue } from './matchmaking.mjs';
import { snapshot, connectionOpened, connectionClosed } from './analytics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http);

// Game stats. Gated on a shared secret so the numbers are not public; with STATS_TOKEN
// unset the route 404s exactly like any unknown path, so its existence is not advertised.
app.get('/stats', (req, res) => {
  const expected = process.env.STATS_TOKEN;
  const supplied = req.query.token || req.get('x-stats-token');
  if (!expected || supplied !== expected) return res.status(404).send('Not found');
  res.set('Cache-Control', 'no-store').json(snapshot());
});

app.use(express.static(join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log(`connected: ${socket.id}`);
  connectionOpened();
  registerHandlers(io, socket);
  socket.on('disconnect', () => {
    console.log(`disconnected: ${socket.id}`);
    connectionClosed();
  });
});

// Process matchmaking queue every 2 seconds
setInterval(() => processQueue(io), 2000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Nine-Card Don running on http://localhost:${PORT}`);
});
