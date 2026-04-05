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

// Room structure:
// roomId -> {
//   token, createdAt, mood,
//   members: { socketId: { deviceId, online } },
//   shareState: { sharerId, viewerId } | null
// }
const rooms = new Map();

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

// Create a new pairing room
app.post('/create-room', (req, res) => {
  const token = generateId();
  const roomId = generateId();
  rooms.set(roomId, {
    token,
    roomId,
    createdAt: Date.now(),
    mood: req.body.mood || '',
    members: {},
    shareState: null
  });

  // Expire unpaired rooms after 10 minutes
  setTimeout(() => {
    const room = rooms.get(roomId);
    if (room && Object.keys(room.members).length < 2) {
      rooms.delete(roomId);
      console.log(`Room ${roomId} expired unpaired`);
    }
  }, 10 * 60 * 1000);

  console.log(`Room created: ${roomId}`);
  res.json({ roomId, token });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // Both devices join using same event
  socket.on('room:join', ({ roomId, token, deviceId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('room:error', 'Room not found or expired');
      return;
    }
    if (room.token !== token) {
      socket.emit('room:error', 'Invalid token');
      return;
    }
    if (Object.keys(room.members).length >= 2 &&
        !Object.values(room.members).find(m => m.deviceId === deviceId)) {
      socket.emit('room:error', 'Room is full');
      return;
    }

    // Remove old socket for this device if reconnecting
    const existingMember = Object.entries(room.members)
      .find(([, m]) => m.deviceId === deviceId);
    if (existingMember) {
      delete room.members[existingMember[0]];
    }

    room.members[socket.id] = { deviceId, online: true };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.deviceId = deviceId;

    const memberCount = Object.keys(room.members).length;
    console.log(`Device ${deviceId} joined room ${roomId} (${memberCount}/2)`);

    socket.emit('room:joined', {
      memberCount,
      shareState: room.shareState
    });

    // Tell everyone current state
    if (memberCount === 2) {
      io.to(roomId).emit('room:ready', {
        shareState: room.shareState
      });
    }

    // Tell partner this device came online
    socket.to(roomId).emit('partner:online');
  });

  // Device A requests to see Device B's screen
  socket.on('share:request', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    // Forward request to partner
    socket.to(socket.roomId).emit('share:requested', {
      fromDeviceId: socket.deviceId
    });
    console.log(`Share requested in room ${socket.roomId}`);
  });

  // Device B approves the request
  socket.on('share:approve', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    // B is the sharer, the other member is the viewer
    room.shareState = {
      sharerId: socket.deviceId,
      sharerSocketId: socket.id
    };
    // Tell both devices sharing is now active
    io.to(socket.roomId).emit('share:started', {
      sharerId: socket.deviceId
    });
    console.log(`Share approved in room ${socket.roomId}`);
  });

  // Device B declines the request
  socket.on('share:decline', ({ message }) => {
    socket.to(socket.roomId).emit('share:declined', { message });
  });

  // Device B starts sharing proactively
  socket.on('share:start', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.shareState = {
      sharerId: socket.deviceId,
      sharerSocketId: socket.id
    };
    // Notify partner that B is sharing
    socket.to(socket.roomId).emit('share:partnerStarted', {
      sharerId: socket.deviceId
    });
    socket.emit('share:started', { sharerId: socket.deviceId });
    console.log(`Share started proactively in room ${socket.roomId}`);
  });

  // Device B stops sharing
  socket.on('share:stop', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.shareState = null;
    // Tell both devices sharing has stopped
    io.to(socket.roomId).emit('share:stopped');
    console.log(`Share stopped in room ${socket.roomId}`);
  });

  // Relay screen frames — only from active sharer
  socket.on('frame', (base64) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('frame', base64);
  });

  // Control request
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

  // Heartbeat — works anytime
  socket.on('heartbeat:pulse', () => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('heartbeat:pulse');
  });

  // Mood update
  socket.on('mood:update', (mood) => {
    const room = rooms.get(socket.roomId);
    if (room) room.mood = mood;
    socket.to(socket.roomId).emit('mood:update', {
      mood,
      fromDeviceId: socket.deviceId
    });
  });

  // Unpair — removes the room entirely
  socket.on('room:unpair', () => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('room:unpaired');
      rooms.delete(roomId);
      io.socketsLeave(roomId);
      console.log(`Room ${roomId} unpaired`);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        delete room.members[socket.id];
      }
      socket.to(socket.roomId).emit('partner:offline');
    }
    console.log('Socket disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Presence server running on port ${PORT}`);
});