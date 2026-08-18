// game-ui.mjs — Game table rendering

import socket, { emitAsync } from './socket-client.mjs';
import { getCurrentRoom, getMySeat, clearSession } from './lobby-ui.mjs';
import { suitSymbol, suitColor, cardLabel, cardId, sortHand } from './card-utils.mjs';
import { showScreen } from './app.mjs';
import { openFeedback, hasSentFeedback } from './feedback-ui.mjs';

const GAME_BONUS = 8;
let cachedPlayerNames = {};
let currentState = null;
let lastTrickResult = null;
let animatingTrick = false;
let cutOverlayActive = false;
let prevScores = { NS: 0, EW: 0 };

const RELATIVE_POSITIONS = {
  // Maps absolute seat to relative position based on "my" seat
  N: { N: 'bottom', E: 'left', S: 'top', W: 'right' },
  E: { E: 'bottom', S: 'left', W: 'top', N: 'right' },
  S: { S: 'bottom', W: 'left', N: 'top', E: 'right' },
  W: { W: 'bottom', N: 'left', E: 'top', S: 'right' },
};

export function initGameUI() {
  socket.on('game-state', (state) => {
    currentState = state;
    // Don't render game behind cut overlay — wait until it's dismissed
    if (!animatingTrick && !cutOverlayActive) renderGame(state);
    // If we get a game-state and we're not on the game screen, switch to game
    if (!document.getElementById('game-screen').classList.contains('active')) {
      showScreen('game');
    }
  });

  socket.on('card-played', (data) => {
    // Animate card being played
    renderCardPlayed(data);
  });

  socket.on('trick-complete', (result) => {
    lastTrickResult = result;
    animatingTrick = true;
    renderTrickWon(result);
    setTimeout(() => {
      animatingTrick = false;
      if (currentState) renderGame(currentState);
    }, 1200);
  });

  socket.on('hand-complete', (result) => {
    renderHandComplete(result);
  });

  socket.on('new-hand', () => {
    clearHandSummary();
  });

  socket.on('player-disconnected', ({ seat, name }) => {
    showGameMessage(`${name} disconnected`);
  });

  socket.on('player-left', ({ name }) => {
    showGameMessage(`${name || 'A player'} left the table`);
  });

  socket.on('player-reconnected', ({ seat, name }) => {
    showGameMessage(`${name} reconnected`);
  });

  socket.on('ai-takeover', ({ seat, name, aiName }) => {
    showGameMessage(`${aiName} is playing for ${name}`);
  });

  // --- Cut ceremony events ---
  socket.on('cut-ceremony', (data) => {
    showScreen('game');
    renderCutCeremony(data);
  });

  socket.on('cut-choose', (data) => {
    renderCutChoose(data);
  });

  socket.on('pitcher-chosen', (data) => {
    renderPitcherChosen(data);
  });

  socket.on('game-started', () => {
    hideCutOverlay();
  });
}

function playerName(seat) {
  return cachedPlayerNames[seat] || seat;
}

function teamName(team) {
  if (team === 'NS') {
    return `${playerName('N')} & ${playerName('S')}`;
  }
  return `${playerName('E')} & ${playerName('W')}`;
}

function renderGame(state) {
  if (state.playerNames) cachedPlayerNames = state.playerNames;
  const mySeat = state.mySeat;
  const positions = RELATIVE_POSITIONS[mySeat];

  // Render my hand (bottom)
  renderMyHand(state);

  // Render opponent areas
  renderOpponentAreas(state, positions);

  // Render trick area
  renderTrickArea(state, positions);

  // Render info panel
  renderInfoPanel(state);

  // Turn indicator
  renderTurnIndicator(state);
}

let lastHandCardCount = 0;

function renderMyHand(state) {
  const container = document.getElementById('my-hand');
  container.innerHTML = '';

  const sorted = sortHand(state.myHand, state.trumpSuit);
  const playableIds = new Set(state.playableCards.map(c => cardId(c)));
  const isMyTurn = state.currentPlayer === state.mySeat;
  const isNewDeal = sorted.length === 9 && lastHandCardCount !== 9;

  for (let i = 0; i < sorted.length; i++) {
    const card = sorted[i];
    const el = createCardElement(card);
    const canPlay = isMyTurn && playableIds.has(cardId(card));

    if (!isMyTurn || !canPlay) {
      el.classList.add('dimmed');
    }

    if (canPlay) {
      el.classList.add('playable');
      el.addEventListener('click', () => playCard(card));
    }

    // Deal animation for fresh hands
    if (isNewDeal) {
      el.classList.add('card-dealing');
      el.style.animationDelay = `${i * 80}ms`;
    }

    container.appendChild(el);
  }

  lastHandCardCount = sorted.length;

  // My seat label — show name
  document.getElementById('my-seat-label').textContent = playerName(state.mySeat);
}

function renderOpponentAreas(state, positions) {
  const SEATS_ALL = ['N', 'E', 'S', 'W'];

  for (const seat of SEATS_ALL) {
    if (seat === state.mySeat) continue;
    const pos = positions[seat];
    const area = document.getElementById(`player-${pos}`);
    if (!area) continue;

    const nameEl = area.querySelector('.player-name');
    const cardsEl = area.querySelector('.player-cards');

    const isAi = state.aiSeats?.includes(seat);
    nameEl.textContent = (isAi ? '🤖 ' : '') + playerName(seat);

    cardsEl.innerHTML = '';

    // Show card backs for all opponents (including partner)
    const count = state.handCounts[seat] || 0;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'card card-back';
      cardsEl.appendChild(el);
    }

    // Highlight current player
    area.classList.toggle('active-player', state.currentPlayer === seat);
  }
}

function renderTrickArea(state, positions) {
  const area = document.getElementById('trick-area');

  // Only clear if not animating
  if (!animatingTrick) {
    area.querySelectorAll('.trick-card').forEach(el => {
      if (!el.classList.contains('animating')) {
        el.innerHTML = '';
      }
    });
  }

  for (const play of state.currentTrick) {
    const pos = positions[play.seat];
    const slot = area.querySelector(`.trick-card.trick-${pos}`);
    if (slot && !slot.classList.contains('animating')) {
      slot.innerHTML = '';
      slot.appendChild(createCardElement(play.card));
    }
  }
}

function renderCardPlayed(data) {
  if (!currentState) return;
  const positions = RELATIVE_POSITIONS[currentState.mySeat];
  const pos = positions[data.seat];
  const area = document.getElementById('trick-area');
  const slot = area.querySelector(`.trick-card.trick-${pos}`);
  if (!slot) return;

  slot.innerHTML = '';
  const cardEl = createCardElement(data.card);
  cardEl.classList.add(`fly-from-${pos}`);
  slot.appendChild(cardEl);
}

function renderTrickWon(result) {
  if (result.points > 0) {
    const cardDescs = result.scoringCards
      .map(sc => `${sc.card.rank}${suitSymbol(sc.card.suit)}=${sc.points}`)
      .join(' ');
    showGameMessage(`${playerName(result.winner)} wins +${result.points}pts  (${cardDescs})`);
  } else {
    showGameMessage(`${playerName(result.winner)} wins the trick`);
  }

  // Sweep animation — cards fly toward winner
  if (currentState) {
    const positions = RELATIVE_POSITIONS[currentState.mySeat];
    const winnerPos = positions[result.winner];
    const area = document.getElementById('trick-area');
    area.querySelectorAll('.trick-card .card').forEach(card => {
      card.classList.add(`sweep-to-${winnerPos}`);
    });
  }
}

function renderInfoPanel(state) {
  // Scores — detect changes and flash
  const nsEl = document.getElementById('score-ns');
  const ewEl = document.getElementById('score-ew');

  if (state.scores.NS !== prevScores.NS) {
    const delta = state.scores.NS - prevScores.NS;
    nsEl.textContent = state.scores.NS;
    if (delta > 0) flashScore('ns', delta);
  } else {
    nsEl.textContent = state.scores.NS;
  }

  if (state.scores.EW !== prevScores.EW) {
    const delta = state.scores.EW - prevScores.EW;
    ewEl.textContent = state.scores.EW;
    if (delta > 0) flashScore('ew', delta);
  } else {
    ewEl.textContent = state.scores.EW;
  }

  prevScores = { ...state.scores };

  // Progress bars
  document.getElementById('progress-ns').style.width =
    `${Math.min(100, (state.scores.NS / 121) * 100)}%`;
  document.getElementById('progress-ew').style.width =
    `${Math.min(100, (state.scores.EW / 121) * 100)}%`;

  // Trump
  const trumpEl = document.getElementById('trump-display');
  if (state.trumpSuit) {
    trumpEl.innerHTML = `<span style="color:${suitColor(state.trumpSuit)}">${suitSymbol(state.trumpSuit)}</span>`;
    trumpEl.title = state.trumpSuit;
  } else {
    trumpEl.textContent = '?';
  }

  // Pitcher
  document.getElementById('pitcher-display').textContent = playerName(state.pitcherSeat);

  // Trick count
  document.getElementById('trick-count').textContent =
    `Trick ${state.trickNumber + 1} / 9`;

  // Tricks won
  document.getElementById('tricks-ns').textContent = state.tricksWonCount.NS;
  document.getElementById('tricks-ew').textContent = state.tricksWonCount.EW;

  // Hand points (pegged this hand)
  document.getElementById('hand-pts-ns').textContent = state.handPoints.NS;
  document.getElementById('hand-pts-ew').textContent = state.handPoints.EW;

  // Team labels — show player names
  document.getElementById('team-ns-label').textContent = teamName('NS');
  document.getElementById('team-ew-label').textContent = teamName('EW');
}

function flashScore(team, delta) {
  const el = document.getElementById(`score-${team}`);
  el.classList.remove('score-flash', 'score-flash-big');
  void el.offsetWidth; // Force reflow to restart animation
  el.classList.add(delta >= 10 ? 'score-flash-big' : 'score-flash');

  // Show floating +N
  const group = el.closest('.info-bar-group') || el.parentElement;
  const floater = document.createElement('span');
  floater.className = 'score-delta';
  floater.textContent = `+${delta}`;
  group.appendChild(floater);
  setTimeout(() => floater.remove(), 1200);
}

function renderTurnIndicator(state) {
  const el = document.getElementById('turn-indicator');
  if (state.handComplete) {
    el.textContent = 'Hand complete';
    el.className = 'turn-indicator';
  } else if (state.currentPlayer === state.mySeat) {
    el.textContent = state.pitched ? 'Your turn, play a card' : 'Your pitch, choose trump';
    el.className = 'turn-indicator my-turn';
  } else {
    el.textContent = `${playerName(state.currentPlayer)}'s turn`;
    el.className = 'turn-indicator';
  }
}

function renderTrickCard(card, trumpSuit) {
  const sym = suitSymbol(card.suit);
  const color = suitColor(card.suit);
  const isTrump = card.suit === trumpSuit;
  return `<span class="trick-card-mini${isTrump ? ' is-trump' : ''}" style="color:${color}">${card.rank}${sym}</span>`;
}

function renderHandComplete(result) {
  const overlay = document.getElementById('hand-summary');
  overlay.classList.add('visible');

  const nsTeam = teamName('NS');
  const ewTeam = teamName('EW');
  const tricks = result.trickHistory || [];
  const nsTricks = tricks.filter(t => t.winnerTeam === 'NS');
  const ewTricks = tricks.filter(t => t.winnerTeam === 'EW');
  const trumpSuit = currentState?.trumpSuit;

  const gameBonusLine = result.gameBonusWinner
    ? `${result.gameBonusWinner === 'NS' ? nsTeam : ewTeam} wins "game" (+${GAME_BONUS}pts)`
    : '"Game" tied, no bonus';

  function renderTrickRow(trick) {
    const cards = trick.cards.map(c => renderTrickCard(c.card, trumpSuit)).join(' ');
    const ptsLabel = trick.points > 0 ? `<span class="trick-pts">+${trick.points}</span>` : '';
    return `<div class="trick-row"><span class="trick-num">#${trick.trickNumber}</span>${cards}${ptsLabel}</div>`;
  }

  let html = '<h2>Hand Complete</h2>';
  html += `
    <div class="hand-scores">
      <div class="score-detail">
        <h3 class="team-ns">${nsTeam}</h3>
        <div class="tricks-list">${nsTricks.length ? nsTricks.map(renderTrickRow).join('') : '<div class="no-tricks">No tricks won</div>'}</div>
        <div class="team-summary">
          <div>Trump pts: ${result.handPoints.NS - (result.gameBonus.NS || 0)}</div>
          <div>Game count: ${result.gameCount?.NS ?? 0}</div>
          <div>Game bonus: ${result.gameBonus.NS}</div>
          <div class="score-total">Hand total: ${result.handPoints.NS}</div>
        </div>
      </div>
      <div class="score-detail">
        <h3 class="team-ew">${ewTeam}</h3>
        <div class="tricks-list">${ewTricks.length ? ewTricks.map(renderTrickRow).join('') : '<div class="no-tricks">No tricks won</div>'}</div>
        <div class="team-summary">
          <div>Trump pts: ${result.handPoints.EW - (result.gameBonus.EW || 0)}</div>
          <div>Game count: ${result.gameCount?.EW ?? 0}</div>
          <div>Game bonus: ${result.gameBonus.EW}</div>
          <div class="score-total">Hand total: ${result.handPoints.EW}</div>
        </div>
      </div>
    </div>
    <div class="game-bonus-line">${gameBonusLine}</div>
    <div class="running-scores">
      ${nsTeam} ${result.scores.NS} v ${ewTeam} ${result.scores.EW}
    </div>
  `;

  if (result.gameOver) {
    clearSession();
    html += `<h2 class="game-winner">${result.winner === 'NS' ? nsTeam : ewTeam} wins the game!</h2>`;
    html += `<button id="new-game-btn" class="btn btn-primary">New Game</button>`;
    html += `<button id="home-btn" class="btn btn-secondary">Home</button>`;
    if (!hasSentFeedback()) {
      html += `<button id="endgame-feedback-btn" class="btn btn-secondary">How was that game?</button>`;
    }
  } else {
    html += `<button id="ready-btn" class="btn btn-primary">Ready for Next Hand</button>`;
    html += `<div id="ready-status"></div>`;
  }

  overlay.innerHTML = html;

  if (result.gameOver) {
    document.getElementById('endgame-feedback-btn')?.addEventListener('click', () => {
      openFeedback('You just finished a game. What worked, what did not, anything broken?');
    });
    document.getElementById('new-game-btn').addEventListener('click', async () => {
      const res = await emitAsync('restart-game', { code: getCurrentRoom() });
      if (res.error) showGameMessage(res.error);
      overlay.classList.remove('visible');
    });
    // Home: tell the server first so the seat frees for whoever is left, then
    // clear the table down. Wrapped because a failed emit must not strand the
    // player on a finished game with no way out - the point of the button.
    document.getElementById('home-btn').addEventListener('click', async () => {
      try { await emitAsync('leave-room'); } catch { /* leaving anyway */ }
      clearSession();
      overlay.classList.remove('visible');
      overlay.innerHTML = '';
      showScreen('lobby');
    });
  } else {
    document.getElementById('ready-btn').addEventListener('click', async () => {
      const res = await emitAsync('ready-next-hand', { code: getCurrentRoom() });
      if (res.error) showGameMessage(res.error);
      else document.getElementById('ready-btn').disabled = true;
    });

    socket.on('ready-count', ({ count }) => {
      const el = document.getElementById('ready-status');
      if (el) el.textContent = `${count}/4 players ready`;
    });
  }
}

function clearHandSummary() {
  const overlay = document.getElementById('hand-summary');
  overlay.classList.remove('visible');
  overlay.innerHTML = '';
}

async function playCard(card) {
  const code = getCurrentRoom();
  const res = await emitAsync('play-card', { code, card });
  if (res.error) showGameMessage(res.error);
}

function createCardElement(card, small = false) {
  const el = document.createElement('div');
  el.className = `card ${small ? 'card-small' : ''} suit-${card.suit}`;
  el.dataset.card = cardId(card);
  const sym = suitSymbol(card.suit);
  const color = suitColor(card.suit);
  el.innerHTML = `
    <span class="card-corner card-corner-top" style="color:${color}">
      <span class="card-corner-rank">${card.rank}</span>
      <span class="card-corner-suit">${sym}</span>
    </span>
    <span class="card-center-pip" style="color:${color}">${sym}</span>
    <span class="card-corner card-corner-bottom" style="color:${color}">
      <span class="card-corner-rank">${card.rank}</span>
      <span class="card-corner-suit">${sym}</span>
    </span>
  `;
  return el;
}

// --- Cut ceremony rendering ---

function renderCutCeremony(data) {
  cutOverlayActive = true;
  if (data.playerNames) cachedPlayerNames = data.playerNames;
  const overlay = document.getElementById('cut-overlay');
  overlay.classList.add('visible');

  // Update cut team labels with player names
  document.getElementById('cut-label-ns').textContent = teamName('NS');
  document.getElementById('cut-label-ew').textContent = teamName('EW');

  // Render NS cut card
  const nsSlot = document.getElementById('cut-card-ns');
  nsSlot.innerHTML = '';
  nsSlot.appendChild(createCardElement(data.nsCutCard));

  // Render EW cut card
  const ewSlot = document.getElementById('cut-card-ew');
  ewSlot.innerHTML = '';
  ewSlot.appendChild(createCardElement(data.ewCutCard));

  // Result text
  const resultEl = document.getElementById('cut-result');
  resultEl.textContent = `${teamName(data.winningTeam)} wins the cut!`;

  // Clear choose area until cut-choose event
  document.getElementById('cut-choose-area').innerHTML =
    '<div class="cut-waiting">Revealing cards...</div>';
}

function renderCutChoose(data) {
  const chooseArea = document.getElementById('cut-choose-area');

  if (data.isChooser) {
    chooseArea.innerHTML = `
      <div class="cut-choose-prompt">You won the cut! Who pitches first?</div>
      <div class="cut-choose-buttons">
        <button class="btn btn-primary cut-btn" data-choice="self">I pitch</button>
        <button class="btn btn-secondary cut-btn" data-choice="partner">My partner pitches</button>
      </div>
    `;
    chooseArea.querySelectorAll('.cut-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const choice = btn.dataset.choice;
        chooseArea.querySelectorAll('.cut-btn').forEach(b => b.disabled = true);
        const res = await emitAsync('choose-pitcher', { code: getCurrentRoom(), choice });
        if (res.error) showGameMessage(res.error);
      });
    });
  } else {
    chooseArea.innerHTML = `
      <div class="cut-waiting">${playerName(data.chooser)} is choosing who pitches...</div>
    `;
  }
}

function renderPitcherChosen(data) {
  const chooseArea = document.getElementById('cut-choose-area');
  chooseArea.innerHTML = `
    <div class="cut-chosen">${playerName(data.pitcherSeat)} will pitch first!</div>
  `;
}

function hideCutOverlay() {
  cutOverlayActive = false;
  const overlay = document.getElementById('cut-overlay');
  overlay.classList.remove('visible');
  // Render the game state that arrived while overlay was up
  if (currentState) renderGame(currentState);
}

function showGameMessage(msg) {
  const el = document.getElementById('game-message');
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2500);
}
