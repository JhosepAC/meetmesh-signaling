import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { handleSignaling } from './src/sockets/signalingHandler.js';

const app = express();

app.use(cors());

app.get('/', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Signaling server active' });
});

const httpServer = createServer(app);

const allowedOrigins = (process.env.CLIENT_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const io = new Server(httpServer, {
  connectionStateRecovery: {
    // Allows Socket.IO to replay missed packets during short network changes;
    // the authoritative snapshot on join remains the final reconciliation.
    maxDisconnectionDuration: 10_000,
    skipMiddlewares: true,
  },
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log(`[CONNECT] Client connected: ${socket.id}`);
  handleSignaling(io, socket);
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
});
