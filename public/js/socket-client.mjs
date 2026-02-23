// socket-client.mjs — Socket.IO client wrapper

const socket = io();

socket.on('connect', () => {
  console.log('Connected:', socket.id);
});

socket.on('disconnect', () => {
  console.log('Disconnected');
});

// Promisified emit with ack
export function emitAsync(event, data) {
  return new Promise((resolve) => {
    socket.emit(event, data, (response) => {
      resolve(response);
    });
  });
}

export default socket;
