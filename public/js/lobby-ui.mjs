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

export function initLobby() {
  const createBtn = document.getElementById('create-btn');
  const joinBtn = document.getElementById('join-btn');
  const codeInput = document.getElementById('room-code');
  const quickPlayBtn = document.getElementById('quick-play-btn');
  const startWithAiBtn = document.getElementById('start-with-ai-btn');
  const cancelQueueBtn = document.getElementById('cancel-queue-btn');

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
