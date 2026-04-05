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

// Device A calls this to create a room
app.post('/create-room', (req, res) => {
  const token = generateToken();
  const roomId = generateToken();
  rooms.set(roomId, {
    members: [], // max 2 members
    token,
    roomId,
    createdAt: Date.now(),
    mood: req.body.mood || ''
  });
  // Room expires in 10 minutes if second person never joins
  setTimeout(() => {
    const room = rooms.get(roomId);
    if (room && room.members.length < 2) {
      rooms.delete(roomId);
      console.log(`Room ${roomId} expired`);
    }
  }, 10 * 60 * 1000);

  console.log(`Room created: ${roomId}`);
  res.json({ roomId, token });
});

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // Both devices use the same join event — no host/viewer distinction
  socket.on('room:join', ({ roomId, token }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('room:error', 'Room not found or expired');
      return;
    }
    if (room.token !== token) {
      socket.emit('room:error', 'Invalid token');
      return;
    }
    if (room.members.length >= 2) {
      socket.emit('room:error', 'Room is full');
      return;
    }

    room.members.push(socket.id);
    socket.join(roomId);
    socket.roomId = roomId;
    console.log(`Socket ${socket.id} joined room ${roomId} (${room.members.length}/2)`);

    // Tell this socket they joined successfully
    socket.emit('room:joined', { memberCount: room.members.length });

    // If both people are now in the room, tell both to start
    if (room.members.length === 2) {
      console.log(`Room ${roomId} is full — notifying both members`);
      io.to(roomId).emit('room:ready');
    }
  });

  // Relay screen frames to the other person — no role check
  socket.on('frame', (data) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('frame', data);
  });

  // Relay everything else bidirectionally
  socket.on('control:request', () => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('control:request');
  });

  socket.on('control:response', (approved) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('control:response', approved);
  });

  socket.on('touch:event', (data) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('touch:event', data);
  });

  socket.on('heartbeat:pulse', () => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('heartbeat:pulse');
  });

  socket.on('mood:update', (mood) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('mood:update', mood);
  });

  // Either person can drop the connection for both
  socket.on('drop:connection', () => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('connection:dropped');
      rooms.delete(roomId);
      io.socketsLeave(roomId);
      console.log(`Room ${roomId} dropped`);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.members = room.members.filter(id => id !== socket.id);
      }
      socket.to(socket.roomId).emit('peer:disconnected');
    }
    console.log('Socket disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Presence server running on port ${PORT}`);
});