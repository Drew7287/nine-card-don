// share-ui.mjs — "Players online" counter and the share/invite buttons.

import socket from './socket-client.mjs';
import { getCurrentRoom } from './lobby-ui.mjs';

const $ = (id) => document.getElementById(id);

// --- Players online ---------------------------------------------------------

function renderPresence({ online, inQueue }) {
  const el = $('presence');
  if (!el) return;

  // "1 player online" is technically true and reads as a ghost town. Say the useful
  // thing instead: whether there is anybody here to actually play against.
  let text;
  if (online <= 1) text = 'You are the only one here right now, bots will fill the seats';
  else text = `${online} players online`;

  if (inQueue > 0) {
    text += `, ${inQueue} waiting for a game`;
  }
  el.textContent = text;
}

// --- Sharing ----------------------------------------------------------------

function shareUrl(roomCode) {
  const base = `${location.origin}/`;
  return roomCode ? `${base}?room=${encodeURIComponent(roomCode)}` : base;
}

function shareText(roomCode) {
  return roomCode
    ? `Join my game of Nine-Card Don, room ${roomCode}`
    : 'Nine-Card Don, the Welsh trick-taking card game. Free to play online.';
}

function setStatus(id, message, ok = true) {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.className = `share-status ${ok ? 'ok' : 'error'}`;
  setTimeout(() => { el.textContent = ''; el.className = 'share-status'; }, 3000);
}

async function doShare(statusId, roomCode) {
  const url = shareUrl(roomCode);
  const text = shareText(roomCode);

  // navigator.share is the native sheet on mobile, which is where sharing actually
  // happens. It requires a user gesture and HTTPS, so it silently does not exist on
  // desktop browsers and on a plain-http local run; clipboard is the fallback.
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Nine-Card Don', text, url });
      return;   // no status message: the OS sheet is its own feedback
    } catch (err) {
      // AbortError means they opened the sheet and backed out. That is not a failure
      // and must not show an error.
      if (err?.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    setStatus(statusId, 'Link copied, paste it to your friends');
  } catch {
    // Clipboard needs a secure context and permission; neither is guaranteed.
    setStatus(statusId, url, false);
  }
}

// --- Join by link -----------------------------------------------------------

function prefillRoomFromUrl() {
  const code = new URLSearchParams(location.search).get('room');
  if (!code) return;
  const input = $('room-code');
  if (!input) return;
  input.value = code.trim().toUpperCase().slice(0, 4);
  // Their name is the only thing still missing, so put the cursor there.
  $('player-name')?.focus();
}

export function initShare() {
  socket.on('presence', renderPresence);

  $('share-site-btn')?.addEventListener('click', () => doShare('share-site-status', null));
  $('share-room-btn')?.addEventListener('click',
    () => doShare('share-room-status', getCurrentRoom()));

  prefillRoomFromUrl();
}
