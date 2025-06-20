const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { randomUUID } = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// Enable CORS for all routes
app.use(cors({
  origin: '*', // Allow all origins for now
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Game rooms for matchmaking
const gameRooms = new Map();
// Active connections
const clients = new Map();

// Heartbeat to keep connections alive
function heartbeat() {
  this.isAlive = true;
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const clientId = randomUUID();
  
  // Set up client info
  ws.isAlive = true;
  ws.id = clientId;
  ws.room = null;
  
  // Store client connection
  clients.set(clientId, ws);
  
  console.log(`Client connected: ${clientId}`);
  
  // Setup ping-pong for connection health check
  ws.on('pong', heartbeat);
  
  // Handle messages from client
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle different message types
      switch (data.type) {
        case 'create_room':
          handleCreateRoom(ws, data);
          break;
          
        case 'join_room':
          handleJoinRoom(ws, data);
          break;
          
        case 'game_message':
          handleGameMessage(ws, data);
          break;
          
        case 'leave_room':
          handleLeaveRoom(ws);
          break;
          
        case 'ping':
          // Just send a pong back with the same timestamp
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: data.timestamp
          }));
          break;
          
        default:
          console.log(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });
  
  // Handle disconnection
  ws.on('close', () => {
    handleLeaveRoom(ws);
    clients.delete(clientId);
    console.log(`Client disconnected: ${clientId}`);
  });
  
  // Send initial connection acknowledgment
  ws.send(JSON.stringify({
    type: 'connection_established',
    clientId
  }));
});

// Create a new game room
function handleCreateRoom(ws, data) {
  const { pin, playerName, timeControl, totalGames, countdown } = data;
  
  // Check if the room already exists
  if (gameRooms.has(pin)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room with this PIN already exists'
    }));
    return;
  }
  
  // Create a new room
  const room = {
    id: pin,
    creator: {
      clientId: ws.id,
      name: playerName
    },
    joiner: null,
    settings: {
      timeControl,
      totalGames,
      countdown
    },
    messages: []
  };
  
  gameRooms.set(pin, room);
  ws.room = pin;
  
  console.log(`Room created: ${pin} by ${playerName}`);
  
  ws.send(JSON.stringify({
    type: 'room_created',
    pin,
    settings: room.settings
  }));
}

// Join an existing game room
function handleJoinRoom(ws, data) {
  const { pin, playerName } = data;
  
  // Check if the room exists
  if (!gameRooms.has(pin)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room not found'
    }));
    return;
  }
  
  const room = gameRooms.get(pin);
  
  // Check if the room is already full
  if (room.joiner !== null) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room is already full'
    }));
    return;
  }
  
  // Add the joiner to the room
  room.joiner = {
    clientId: ws.id,
    name: playerName
  };
  
  ws.room = pin;
  
  console.log(`Player ${playerName} joined room: ${pin}`);
  
  // Notify both players
  ws.send(JSON.stringify({
    type: 'room_joined',
    pin,
    creatorName: room.creator.name,
    settings: room.settings
  }));
  
  // Notify the creator that someone joined
  const creatorWs = clients.get(room.creator.clientId);
  if (creatorWs && creatorWs.readyState === WebSocket.OPEN) {
    creatorWs.send(JSON.stringify({
      type: 'opponent_joined',
      name: playerName
    }));
  }
}

// Forward game messages between players
function handleGameMessage(ws, data) {
  const { pin, message } = data;
  
  if (!pin || !ws.room || ws.room !== pin) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Not in a valid room'
    }));
    return;
  }
  
  const room = gameRooms.get(pin);
  if (!room) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room not found'
    }));
    return;
  }
  
  // Determine the recipient
  let recipientId;
  if (ws.id === room.creator.clientId) {
    recipientId = room.joiner?.clientId;
  } else if (room.joiner && ws.id === room.joiner.clientId) {
    recipientId = room.creator.clientId;
  }
  
  // Forward the message to the recipient
  if (recipientId) {
    const recipientWs = clients.get(recipientId);
    if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
      recipientWs.send(JSON.stringify({
        type: 'game_message',
        message
      }));
    }
  }
  
  // Save last few messages for history (optional)
  room.messages.push({
    from: ws.id,
    message,
    timestamp: Date.now()
  });
  
  // Keep only last 20 messages
  if (room.messages.length > 20) {
    room.messages.shift();
  }
}

// Handle a player leaving a room
function handleLeaveRoom(ws) {
  if (!ws.room) return;
  
  const pin = ws.room;
  if (!gameRooms.has(pin)) return;
  
  const room = gameRooms.get(pin);
  
  // Notify the other player if they're still connected
  if (room.creator.clientId === ws.id) {
    // Creator left
    if (room.joiner) {
      const joinerWs = clients.get(room.joiner.clientId);
      if (joinerWs && joinerWs.readyState === WebSocket.OPEN) {
        joinerWs.send(JSON.stringify({
          type: 'opponent_left',
          name: room.creator.name
        }));
        joinerWs.room = null;
      }
    }
    
    // Delete the room
    gameRooms.delete(pin);
    
  } else if (room.joiner && room.joiner.clientId === ws.id) {
    // Joiner left
    const creatorWs = clients.get(room.creator.clientId);
    if (creatorWs && creatorWs.readyState === WebSocket.OPEN) {
      creatorWs.send(JSON.stringify({
        type: 'opponent_left',
        name: room.joiner.name
      }));
    }
    
    // Reset joiner slot
    room.joiner = null;
  }
  
  ws.room = null;
}

// Check for dead connections every 30 seconds
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      handleLeaveRoom(ws);
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Clean up interval on server close
wss.on('close', () => {
  clearInterval(interval);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Get active rooms (for debug)
app.get('/api/rooms', (req, res) => {
  const roomsInfo = Array.from(gameRooms.entries()).map(([pin, room]) => ({
    pin,
    creatorName: room.creator.name,
    hasJoiner: !!room.joiner,
    joinerName: room.joiner?.name || null
  }));
  
  res.json(roomsInfo);
});

// Start the server
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});