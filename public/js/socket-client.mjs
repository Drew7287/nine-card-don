// socket-client.mjs — Socket.IO client wrapper

const socket = io({
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});

socket.on('connect', () => {
  console.log('Connected:', socket.id);
  setBannerVisible(false);
});

socket.on('disconnect', () => {
  console.log('Disconnected');
  setBannerVisible(true);
});

// --- Mobile reconnection: force reconnect when tab resumes ---

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!socket.connected) {
      console.log('Page visible, forcing reconnect');
      socket.connect();
    }
  }
});

// iOS Safari back-forward cache
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !socket.connected) {
    console.log('Page restored from bfcache, forcing reconnect');
    socket.connect();
  }
});

// --- Reconnecting banner ---

function setBannerVisible(show) {
  const el = document.getElementById('reconnecting-banner');
  if (el) el.classList.toggle('visible', show);
}

// Promisified emit with ack
export function emitAsync(event, data) {
  return new Promise((resolve) => {
    socket.emit(event, data, (response) => {
      resolve(response);
    });
  });
}

export default socket;
