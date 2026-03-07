import { WebSocketServer } from 'ws';

const PORT = 81;
const wss = new WebSocketServer({ port: PORT });

let state = {
  speed: 0.0,
  direction: true
};

function sendStatus(ws) {
  ws.send(JSON.stringify({
    type: 'status',
    speed: state.speed,
    direction: state.direction,
    connected: true
  }));
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  sendStatus(ws);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.cmd) {
        case 'speed':
          state.speed = Math.max(0, Math.min(1, msg.value || 0));
          console.log(`Speed: ${(state.speed * 100).toFixed(0)}%`);
          sendStatus(ws);
          break;

        case 'direction':
          state.direction = msg.value !== false;
          console.log(`Direction: ${state.direction ? 'FWD' : 'REV'}`);
          sendStatus(ws);
          break;

        case 'stop':
          state.speed = 0;
          console.log('STOP');
          sendStatus(ws);
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          console.log('Unknown command:', msg.cmd);
      }
    } catch (e) {
      console.log('Bad message:', data.toString());
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

console.log(`Mock WebSocket server running on ws://localhost:${PORT}`);
