const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10e6
});

const rooms = new Map();

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

app.post('/create-room', (req, res) => {
  const token = generateToken();
  const roomId = generateToken();
  rooms.set(roomId, {
    hostSocketId: null,
    viewerSocketId: null,
    token,
    roomId,
    createdAt: Date.now(),
    mood: req.body.mood || ''
  });
  setTimeout(() => {
    const room = rooms.get(roomId);
    if (room && !room.viewerSocketId) {
      rooms.delete(roomId);
    }
  }, 10 * 60 * 1000);
  res.json({ roomId, token });
});

app.post('/validate-token', (req, res) => {
  const { roomId, token } = req.body;
  const room = rooms.get(roomId);
  if (room && room.token === token) {
    res.json({ valid: true, mood: room.mood });
  } else {
    res.json({ valid: false });
  }
});

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('host:join', ({ roomId, token }) => {
    const room = rooms.get(roomId);
    if (!room || room.token !== token) {
      socket.emit('error', 'Invalid token');
      return;
    }
    room.hostSocketId = socket.id;
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = 'host';
    console.log(`Host joined room ${roomId}`);
  });

  socket.on('viewer:join', ({ roomId, token }) => {
    const room = rooms.get(roomId);
    if (!room || room.token !== token) {
      socket.emit('error', 'Invalid token');
      return;
    }
    room.viewerSocketId = socket.id;
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = 'viewer';
    socket.to(roomId).emit('viewer:connected');
    console.log(`Viewer joined room ${roomId}`);
  });

  // Bidirectional — any role can send frames, relayed to the other person
  socket.on('frame', (data) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('frame', data);
  });

  // Bidirectional control request — anyone can request control
  socket.on('control:request', () => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('control:request');
  });

  // Bidirectional control response
  socket.on('control:response', (approved) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('control:response', approved);
  });

  // Bidirectional touch events
  socket.on('touch:event', (data) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('touch:event', data);
  });

  // Bidirectional heartbeat
  socket.on('heartbeat:pulse', () => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('heartbeat:pulse');
  });

  // Bidirectional mood
  socket.on('mood:update', (mood) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('mood:update', mood);
  });

  socket.on('drop:connection', () => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('connection:dropped');
      rooms.delete(roomId);
      io.socketsLeave(roomId);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('peer:disconnected');
    }
    console.log('Socket disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Presence server running on port ${PORT}`);
});