import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerHandlers } from './socket-handlers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http);

app.use(express.static(join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log(`connected: ${socket.id}`);
  registerHandlers(io, socket);
  socket.on('disconnect', () => {
    console.log(`disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Nine-Card Don running on http://localhost:${PORT}`);
});
