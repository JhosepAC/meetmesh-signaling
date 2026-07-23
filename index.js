import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { handleSignaling } from './src/sockets/signalingHandler.js';

const app = express();

app.use(cors());

app.get('/', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Signaling server is active' });
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*", // TODO: Update to frontend URL in production
    methods: ["GET", "POST"]
  }
});

// Setup socket connections using the modular handler
io.on('connection', (socket) => {
  console.log(`[CONNECT] Client connected: ${socket.id}`);
  
  // Inject dependencies into our handler
  handleSignaling(io, socket);
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
});