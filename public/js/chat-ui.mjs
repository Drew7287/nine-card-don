// chat-ui.mjs — Table chat for the game screen.
//
// Deliberately small: a collapsible panel in the corner of the table, an unread
// count when it is shut, and nothing stored anywhere. Messages arrive over the
// same socket as the game and vanish when you leave.
//
// Every message is inserted with textContent, never innerHTML, so a player
// cannot put markup on somebody else's screen.

import socket, { emitAsync } from './socket-client.mjs';
import { getCurrentRoom } from './lobby-ui.mjs';

const $ = (id) => document.getElementById(id);

const MAX_ROWS = 60;      // trim the log so a long session cannot grow forever
const TOAST_MS = 6000;    // long enough to read mid-hand, short enough to ignore
let unread = 0;
let open = false;
let toastTimer = null;
// Auto-open on the FIRST real message of a game only. Once, so nobody can use
// chat to keep shoving the cards out of the way.
let autoOpenedThisGame = false;

function setOpen(next) {
  open = next;
  $('chat-panel')?.classList.toggle('open', open);
  if (open) {
    unread = 0;
    renderBadge();
    hideToast();
    $('chat-input')?.focus();
    const log = $('chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  }
}

function renderBadge() {
  const b = $('chat-badge');
  if (!b) return;
  b.textContent = unread > 9 ? '9+' : String(unread);
  b.style.display = unread ? '' : 'none';
}

function showToast({ name, text }) {
  const el = $('chat-toast');
  if (!el) return;
  el.innerHTML = '';
  if (name) {
    const who = document.createElement('span');
    who.className = 'ct-who';
    who.textContent = name + ': ';   // textContent, never innerHTML
    el.appendChild(who);
  }
  const body = document.createElement('span');
  body.textContent = text;           // textContent, never innerHTML
  el.appendChild(body);

  el.hidden = false;
  // Next frame, so the transition runs instead of the element just appearing.
  requestAnimationFrame(() => el.classList.add('visible'));

  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  const el = $('chat-toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.classList.remove('visible');
  // Wait out the fade before pulling it from the layout.
  setTimeout(() => { if (!el.classList.contains('visible')) el.hidden = true; }, 300);
}

function addRow({ name, text, system }) {
  const log = $('chat-log');
  if (!log) return;

  const row = document.createElement('div');
  row.className = system ? 'chat-row chat-system' : 'chat-row';

  if (!system) {
    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = name + ': ';      // textContent, not innerHTML
    row.appendChild(who);
  }
  const body = document.createElement('span');
  body.textContent = text;              // textContent, not innerHTML
  row.appendChild(body);

  log.appendChild(row);
  while (log.children.length > MAX_ROWS) log.removeChild(log.firstChild);

  // Only auto-scroll if they were already at the bottom, so reading back is not
  // yanked away every time somebody speaks.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  if (open && atBottom) log.scrollTop = log.scrollHeight;

  if (!open && !system) {
    unread += 1;
    renderBadge();
    // The badge on its own gets missed, so say it out loud. First message of
    // a game opens the panel; after that the toast carries it.
    if (!autoOpenedThisGame) {
      autoOpenedThisGame = true;
      setOpen(true);
    } else {
      showToast({ name, text });
    }
  }
}

async function send() {
  const input = $('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const code = getCurrentRoom();
  if (!code) return;

  input.value = '';
  const res = await emitAsync('chat', { code, text });
  if (res?.error) addRow({ text: res.error, system: true });
}

export function initChat() {
  $('chat-toggle')?.addEventListener('click', () => setOpen(!open));
  $('chat-close')?.addEventListener('click', () => setOpen(false));
  $('chat-send')?.addEventListener('click', send);
  $('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
    // Escape shuts the panel rather than bubbling up to anything else.
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  });

  $('chat-toast')?.addEventListener('click', () => setOpen(true));

  socket.on('chat', (m) => addRow(m));

  // A new game gets one auto-open again; a fresh table is a fresh chance that
  // nobody has noticed chat exists.
  socket.on('game-started', () => { autoOpenedThisGame = false; });

  // Table events worth saying out loud, so the panel is useful even in a bot game.
  socket.on('player-disconnected', ({ name }) =>
    addRow({ text: (name || 'A player') + ' lost connection', system: true }));
  socket.on('player-reconnected', ({ name }) =>
    addRow({ text: (name || 'A player') + ' is back', system: true }));
  socket.on('player-left', ({ name }) =>
    addRow({ text: (name || 'A player') + ' left the table', system: true }));
  socket.on('ai-takeover', ({ name, aiName }) =>
    addRow({ text: (aiName || 'A bot') + ' has taken over from ' + (name || 'a player'), system: true }));

  renderBadge();
}
