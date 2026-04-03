// presence-server/server.js
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
  maxHttpBufferSize: 5e6 // 5MB for screen frames
});

// In-memory store for pairing rooms
// In production, use Redis
const rooms = new Map();
// roomId -> { hostSocketId, viewerSocketId, token, createdAt, mood }

// Generate a secure room token
function generateToken() {
  return crypto.randomBytes(16).toString('hex'); // 32 char hex
}

// REST: Phone B calls this to create a room and get a pairing token
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
  // Token expires in 10 minutes
  setTimeout(() => {
    const room = rooms.get(roomId);
    if (room && !room.viewerSocketId) {
      rooms.delete(roomId);
    }
  }, 10 * 60 * 1000);

  res.json({ roomId, token });
});

// REST: Phone A uses this to validate the token before connecting
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

  // Phone B (host) joins their room
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

  // Phone A (viewer) joins the room
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
    // Notify host that viewer has connected
    socket.to(roomId).emit('viewer:connected');
    console.log(`Viewer joined room ${roomId}`);
  });

  // Host sends a screen frame (JPEG bytes as base64)
  socket.on('frame', (data) => {
    if (socket.role !== 'host') return;
    socket.to(socket.roomId).emit('frame', data);
  });

  // Viewer requests remote control
  socket.on('control:request', () => {
    if (socket.role !== 'viewer') return;
    socket.to(socket.roomId).emit('control:request');
  });

  // Host approves or denies control
  socket.on('control:response', (approved) => {
    if (socket.role !== 'host') return;
    socket.to(socket.roomId).emit('control:response', approved);
  });

  // Viewer sends a touch event to host
  socket.on('touch:event', (data) => {
    if (socket.role !== 'viewer') return;
    socket.to(socket.roomId).emit('touch:event', data);
  });

  // Heartbeat pulse (viewer sends vibration to host)
  socket.on('heartbeat:pulse', () => {
    if (socket.role !== 'viewer') return;
    socket.to(socket.roomId).emit('heartbeat:pulse');
  });

  // Mood update
  socket.on('mood:update', (mood) => {
    socket.to(socket.roomId).emit('mood:update', mood);
  });

  // Either side drops the connection
  socket.on('drop:connection', () => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('connection:dropped');
      rooms.delete(roomId);
      io.socketsLeave(roomId);
    }
  });

  // Handle disconnects gracefully
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