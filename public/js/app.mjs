// app.mjs — Client entry, screen management

import { initLobby } from './lobby-ui.mjs';
import { initGameUI } from './game-ui.mjs';
import { initFeedback } from './feedback-ui.mjs';
import { initWelcome } from './welcome-ui.mjs';
import { initShare } from './share-ui.mjs';

const screens = ['lobby', 'room', 'game'];

export function showScreen(name) {
  for (const s of screens) {
    const el = document.getElementById(`${s}-screen`);
    if (el) el.classList.toggle('active', s === name);
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  showScreen('lobby');
  initLobby();
  initGameUI();
  initFeedback();
  initWelcome();
  initShare();
});
