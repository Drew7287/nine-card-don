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
let unread = 0;
let open = false;

function setOpen(next) {
  open = next;
  $('chat-panel')?.classList.toggle('open', open);
  if (open) {
    unread = 0;
    renderBadge();
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

  socket.on('chat', (m) => addRow(m));

  // Table events worth saying out loud, so the panel is useful even in a bot game.
  socket.on('player-disconnected', ({ name }) =>
    addRow({ text: (name || 'A player') + ' lost connection', system: true }));
  socket.on('player-reconnected', ({ name }) =>
    addRow({ text: (name || 'A player') + ' is back', system: true }));
  socket.on('ai-takeover', ({ name, aiName }) =>
    addRow({ text: (aiName || 'A bot') + ' has taken over from ' + (name || 'a player'), system: true }));

  renderBadge();
}
