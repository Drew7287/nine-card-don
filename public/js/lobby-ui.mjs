// lobby-ui.mjs — Lobby/room screens + Quick Play + AI management

import socket, { emitAsync } from './socket-client.mjs';
import { showScreen } from './app.mjs';

const SEATS = ['N', 'E', 'S', 'W'];

let currentRoom = null;
let mySeat = null;

export function getCurrentRoom() {
  return currentRoom;
}

export function getMySeat() {
  return mySeat;
}

// --- Session persistence for auto-rejoin ---

function saveSession(roomCode, playerName) {
  try {
    localStorage.setItem('don-session', JSON.stringify({ roomCode, playerName }));
  } catch { /* localStorage unavailable */ }
}

function loadSession() {
  try {
    const data = localStorage.getItem('don-session');
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

export function clearSession() {
  try { localStorage.removeItem('don-session'); } catch { /* noop */ }
}

export function initLobby() {
  const createBtn = document.getElementById('create-btn');
  const joinBtn = document.getElementById('join-btn');
  const codeInput = document.getElementById('room-code');
  const quickPlayBtn = document.getElementById('quick-play-btn');
  const startWithAiBtn = document.getElementById('start-with-ai-btn');
  const cancelQueueBtn = document.getElementById('cancel-queue-btn');

  // Restore player name from previous session
  const savedSession = loadSession();
  if (savedSession?.playerName) {
    document.getElementById('player-name').value = savedSession.playerName;
  }

  // Auto-rejoin on connect (handles page refresh + socket reconnection)
  //
  // 6 Aug 2026: this used to call clearSession() on ANY outcome that was not a
  // successful rejoin. One transient failure therefore destroyed the stored room
  // and name permanently, so every later attempt had nothing to work with. Drew
  // dropped out of room EFAL on 6 Aug, tried three times in 23 seconds, failed
  // every time, and a bot took his seat on the 30 second timer.
  //
  // Now only a definite answer clears the session. Anything that might be
  // temporary (the server still holding the old socket, a seat not yet released,
  // no answer at all) is retried, because on a phone those are normal.
  const REJOIN_RETRIES = 4;
  const REJOIN_BACKOFF_MS = [300, 900, 2000, 4000];
  const GONE = ['room not found'];   // definitive: nothing to go back to
  let rejoinTimer = null;

  const attemptAutoRejoin = async (attempt = 0) => {
    clearTimeout(rejoinTimer);
    const session = loadSession();
    if (!session) return;

    const res = await emitAsync('join-room', {
      code: session.roomCode,
      playerName: session.playerName,
    });

    if (res?.ok && res.rejoined) {
      currentRoom = res.code;
      mySeat = res.seat;
      return;   // game-state event from the server pushes us to the game screen
    }

    // Joined, but not into our old seat: we are in the room, so keep the session.
    if (res?.ok) {
      currentRoom = res.code;
      return;
    }

    const why = String(res?.error || '').toLowerCase();
    if (GONE.some(g => why.includes(g))) {
      clearSession();
      return;
    }

    if (attempt < REJOIN_RETRIES) {
      rejoinTimer = setTimeout(
        () => attemptAutoRejoin(attempt + 1),
        REJOIN_BACKOFF_MS[attempt] || 4000,
      );
    }
    // Out of retries: the session STAYS. The next reconnect tries again, which
    // costs nothing and is the whole point on a flaky connection.
  };

  if (socket.connected) attemptAutoRejoin();
  socket.on('connect', attemptAutoRejoin);

  // Auto-uppercase room code input
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase();
  });

  // --- Quick Play ---
  quickPlayBtn.addEventListener('click', async () => {
    const name = document.getElementById('player-name').value.trim();
    if (!name) return showError('Enter your name');
    const res = await emitAsync('quick-play', { playerName: name });
    if (res?.error) return showError(res.error);
    showQueueOverlay();
  });

  startWithAiBtn.addEventListener('click', async () => {
    const res = await emitAsync('start-with-ai', {});
    if (res?.error) showError(res.error);
  });

  cancelQueueBtn.addEventListener('click', async () => {
    await emitAsync('cancel-quick-play', {});
    hideQueueOverlay();
  });

  // --- Private Room ---
  createBtn.addEventListener('click', async () => {
    const name = document.getElementById('player-name').value.trim();
    if (!name) return showError('Enter your name');
    const res = await emitAsync('create-room', { playerName: name });
    if (res.error) return showError(res.error);
    currentRoom = res.code;
    saveSession(res.code, name);
    showScreen('room');
  });

  joinBtn.addEventListener('click', async () => {
    const name = document.getElementById('player-name').value.trim();
    const code = document.getElementById('room-code').value.trim().toUpperCase();
    if (!name) return showError('Enter your name');
    if (!code) return showError('Enter room code');
    const res = await emitAsync('join-room', { code, playerName: name });
    if (res.error) return showError(res.error);
    currentRoom = res.code;
    saveSession(res.code, name);
    showScreen('room');

    if (res.rejoined && res.seat) {
      mySeat = res.seat;
      // Rejoining mid-game — game-state event will push us to game screen
    }
  });

  // --- Socket listeners ---

  socket.on('room-state', (state) => {
    currentRoom = state.code;
    renderRoomState(state);
  });

  socket.on('game-started', () => {
    if (!document.getElementById('game-screen').classList.contains('active')) {
      showScreen('game');
    }
  });

  socket.on('queue-status', ({ count }) => {
    const el = document.getElementById('queue-count');
    if (el) el.textContent = `${count} in queue`;
  });

  socket.on('queue-matched', ({ code }) => {
    hideQueueOverlay();
    currentRoom = code;
    const name = document.getElementById('player-name').value.trim();
    if (name) saveSession(code, name);
    showScreen('game');
  });
}

function renderSeatSlot(state, seat) {
  const info = state.seats[seat];
  const div = document.createElement('div');
  div.className = 'seat-slot';

  if (info) {
    div.classList.add('occupied');
    if (info.isAi) {
      // AI player — show bot badge with remove button
      div.classList.add('ai-seat');
      div.innerHTML = `
        <div class="ai-player">
          <span class="ai-badge">🤖</span>
          <span class="seat-player">${info.name}</span>
          ${!state.started ? `<button class="remove-ai-btn" data-seat="${seat}" title="Remove bot">✕</button>` : ''}
        </div>
      `;
    } else {
      if (!info.connected) div.classList.add('disconnected');
      div.innerHTML = `<div class="seat-player">${info.name}${!info.connected ? ' (disconnected)' : ''}</div>`;
    }
  } else {
    // Empty seat — show Sit Here + Add Bot
    div.innerHTML = `
      <div class="seat-actions">
        <button class="sit-btn" data-seat="${seat}">Sit Here</button>
        <button class="add-ai-btn" data-seat="${seat}">+ Bot</button>
      </div>
    `;
  }
  return div;
}

function renderRoomState(state) {
  document.getElementById('room-code-display').textContent = state.code;

  const seatsDiv = document.getElementById('seats');
  seatsDiv.innerHTML = '';

  // Team 1 (N + S)
  const team1 = document.createElement('div');
  team1.className = 'team-group';
  team1.innerHTML = '<div class="team-group-label team-ns">Team 1</div>';
  const team1Seats = document.createElement('div');
  team1Seats.className = 'team-seats';
  team1Seats.appendChild(renderSeatSlot(state, 'N'));
  team1Seats.innerHTML += '<span class="team-amp">&</span>';
  team1Seats.appendChild(renderSeatSlot(state, 'S'));
  team1.appendChild(team1Seats);
  seatsDiv.appendChild(team1);

  // VS divider
  const vs = document.createElement('div');
  vs.className = 'teams-vs';
  vs.textContent = 'vs';
  seatsDiv.appendChild(vs);

  // Team 2 (E + W)
  const team2 = document.createElement('div');
  team2.className = 'team-group';
  team2.innerHTML = '<div class="team-group-label team-ew">Team 2</div>';
  const team2Seats = document.createElement('div');
  team2Seats.className = 'team-seats';
  team2Seats.appendChild(renderSeatSlot(state, 'E'));
  team2Seats.innerHTML += '<span class="team-amp">&</span>';
  team2Seats.appendChild(renderSeatSlot(state, 'W'));
  team2.appendChild(team2Seats);
  seatsDiv.appendChild(team2);

  // Partnership labels
  const nsNames = [state.seats.N?.name, state.seats.S?.name].filter(Boolean);
  const ewNames = [state.seats.E?.name, state.seats.W?.name].filter(Boolean);
  const nsLabel = nsNames.length ? nsNames.join(' & ') : 'Team 1';
  const ewLabel = ewNames.length ? ewNames.join(' & ') : 'Team 2';
  document.getElementById('partnerships').innerHTML =
    `<span class="team-ns">${nsLabel}</span> vs <span class="team-ew">${ewLabel}</span>`;

  // Sit-down handlers
  seatsDiv.querySelectorAll('.sit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const seat = btn.dataset.seat;
      const res = await emitAsync('sit-down', { code: state.code, seat });
      if (res.error) showError(res.error);
      else mySeat = seat;
    });
  });

  // Add AI handlers
  seatsDiv.querySelectorAll('.add-ai-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const seat = btn.dataset.seat;
      const res = await emitAsync('add-ai', { code: state.code, seat });
      if (res?.error) showError(res.error);
    });
  });

  // Remove AI handlers
  seatsDiv.querySelectorAll('.remove-ai-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const seat = btn.dataset.seat;
      const res = await emitAsync('remove-ai', { code: state.code, seat });
      if (res?.error) showError(res.error);
    });
  });

  // Start game button — enabled when all 4 seats filled (min 1 human)
  const startBtn = document.getElementById('start-btn');
  const allSeated = SEATS.every(s => state.seats[s]);
  startBtn.disabled = !allSeated;
  startBtn.onclick = async () => {
    const res = await emitAsync('start-game', { code: state.code });
    if (res.error) showError(res.error);
  };
}

function showQueueOverlay() {
  document.getElementById('queue-overlay').classList.add('visible');
}

function hideQueueOverlay() {
  document.getElementById('queue-overlay').classList.remove('visible');
}

function showError(msg) {
  const el = document.getElementById('lobby-error');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}
