
import { WebSocketServer } from 'ws';
import { GameManager } from './GameManager';

const DEFAULT_PORT = 8080;
const port = process.env.PORT ? parseInt(process.env.PORT) : DEFAULT_PORT;

const wss = new WebSocketServer({ port });

const gameManager = new GameManager();

wss.on('listening', () => {
  console.log(`WebSocket server listening on port ${port}`);
});

wss.on('connection', function connection(ws) {
  gameManager.addUser(ws)
  // 'close' is the standard ws event for when the socket disconnects
  ws.on("close", () => gameManager.removeUser(ws))
});
