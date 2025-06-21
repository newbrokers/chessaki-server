const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { randomUUID } = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

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

// Game rooms for matchmaking - now indexed by both player and viewer PINs
const gameRooms = new Map();
// PIN mapping - maps PINs to room objects
const pinToRoom = new Map();
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
  
  console.log(`Client connected: ${clientId} from ${req.headers.origin || req.headers.host}`);
  console.log(`Total connections: ${clients.size}, Total rooms: ${gameRooms.size}`);
  
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
  ws.on('close', (code, reason) => {
    console.log(`Client disconnected: ${clientId}, Code: ${code}, Reason: ${reason || 'No reason'}`);
    console.log(`Remaining connections: ${clients.size - 1}, Remaining rooms: ${gameRooms.size}`);
    handleLeaveRoom(ws);
    clients.delete(clientId);
  });
  
  // Handle WebSocket errors
  ws.on('error', (error) => {
    console.error(`WebSocket error for client ${clientId}:`, error);
  });
  
  // Send initial connection acknowledgment
  ws.send(JSON.stringify({
    type: 'connection_established',
    clientId
  }));
});

// Generate a random PIN
function generatePin() {
  const letters = Array(2)
    .fill(0)
    .map(() => String.fromCharCode(65 + Math.floor(Math.random() * 26)))
    .join("");
  const digits = String(Math.floor(100 + Math.random() * 900));
  return letters + digits;
}

// Create a new game room with two PINs - NO WebSocket connection yet
function handleCreateRoom(ws, data) {
  const { playerName, timeControl, totalGames, countdown } = data;
  
  // Generate two unique PINs
  let playerPin, viewerPin;
  do {
    playerPin = generatePin();
  } while (pinToRoom.has(playerPin));
  
  do {
    viewerPin = generatePin();
  } while (pinToRoom.has(viewerPin) || viewerPin === playerPin);
  
  // Create a new room with unique room ID - LOBBY state (no active connections)
  const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const room = {
    id: roomId,
    playerPin: playerPin,
    viewerPin: viewerPin,
    state: 'lobby', // New state: lobby -> active -> ended
    creator: {
      name: playerName,
      connected: false
    },
    joiner: {
      name: null,
      connected: false
    },
    viewers: [], // Array to store viewer connections
    originalCreatorName: playerName, // Track original creator
    originalJoinerName: null, // Track original joiner
    lastActivity: Date.now(), // Track activity for auto-close
    settings: {
      timeControl,
      totalGames,
      countdown
    },
    gameState: {
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", // Starting position
      moves: [], // Array of moves in UCI format
      turn: "w", // Current turn
      status: "waiting" // waiting, playing, ended
    },
    messages: []
  };
  
  // Store room and create PIN mappings
  gameRooms.set(roomId, room);
  pinToRoom.set(playerPin, room);
  pinToRoom.set(viewerPin, room);
  
  console.log(`Room lobby created: ${roomId} by ${playerName}`);
  console.log(`Player PIN: ${playerPin}, Viewer PIN: ${viewerPin}`);
  console.log(`Room data:`, JSON.stringify(room, null, 2));
  
  // Send a response with both PINs - then CLOSE this connection to save costs
  const responseData = {
    type: 'room_created',
    playerPin: playerPin,
    viewerPin: viewerPin,
    creatorName: playerName,
    settings: room.settings,
    // Add a full response for debugging
    debugInfo: {
      timestamp: Date.now(),
      roomCount: gameRooms.size,
      clientCount: clients.size
    }
  };
  
  console.log('Sending room_created response:', JSON.stringify(responseData));
  
  try {
    ws.send(JSON.stringify(responseData));
    console.log('Room created response sent successfully');
    
    // Close the connection immediately to save costs - player will reconnect when game is ready
    setTimeout(() => {
      console.log('Closing room creation connection to save costs');
      ws.close(1000, 'Room created successfully');
    }, 1000);
    
  } catch (error) {
    console.error('Error sending room_created response:', error);
  }
}

// Join an existing game room
function handleJoinRoom(ws, data) {
  const { pin, playerName } = data;
  
  console.log(`Join room request: PIN=${pin}, Player=${playerName}, ClientID=${ws.id}`);
  console.log(`Current PIN mappings:`, Array.from(pinToRoom.keys()));
  
  // Check if the PIN exists
  if (!pinToRoom.has(pin)) {
    console.log(`PIN ${pin} not found`);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'PIN not found'
    }));
    return;
  }
  
  const room = pinToRoom.get(pin);
  console.log(`Found room for PIN ${pin}:`, JSON.stringify(room, null, 2));
  
  // Determine if this is a player PIN or viewer PIN
  const isPlayerPin = (pin === room.playerPin);
  const isViewerPin = (pin === room.viewerPin);
  
  console.log(`PIN type: ${isPlayerPin ? 'player' : 'viewer'} PIN`);
  
  // Handle joining based on PIN type
  if (isViewerPin) {
    // Viewer PIN - check if game is active before allowing connection
    
    if (room.state === 'lobby') {
      // Game not started yet - deny WebSocket connection and tell them to wait
      console.log(`Viewer ${playerName} trying to join lobby room - sending wait response`);
      
      const waitResponse = {
        type: 'viewer_wait',
        message: 'Game not started yet - please wait for players to connect',
        playerPin: room.playerPin,
        viewerPin: room.viewerPin,
        creatorName: room.creator.name,
        settings: room.settings,
        gameReady: false
      };
      
      ws.send(JSON.stringify(waitResponse));
      
      // Close connection after sending response to save costs
      setTimeout(() => {
        console.log('Closing viewer connection - game not ready');
        ws.close(1000, 'Game not started yet');
      }, 1000);
      
      return;
      
    } else if (room.state === 'active') {
      // Game is active - allow viewer to connect
      console.log(`Viewer PIN used, adding ${playerName} as viewer to active game`);
      
      const viewer = {
        clientId: ws.id,
        name: playerName
      };
      
      room.viewers.push(viewer);
      ws.room = room.id;
      ws.isViewer = true;
      ws.pinType = 'viewer';
      
      console.log(`Player ${playerName} joined active room as viewer via viewer PIN`);
      
      // Notify the viewer they joined as a viewer
      const viewerResponse = {
        type: 'room_joined',
        pin: pin,
        playerPin: room.playerPin,
        viewerPin: room.viewerPin,
        creatorName: room.creator.name,
        joinerName: room.joiner?.name || null,
        settings: room.settings,
        isViewer: true,
        viewerCount: room.viewers.length,
        gameActive: true
      };
      
      console.log('Sending viewer room_joined response:', JSON.stringify(viewerResponse));
      ws.send(JSON.stringify(viewerResponse));
      
      // Notify all players and viewers about updated viewer count
      broadcastViewerUpdate(room);
    }
    
  } else if (isPlayerPin) {
    // Player PIN - check room state and handle accordingly
    
    if (room.state === 'lobby') {
      // Room is in lobby state - this is the SECOND player joining!
      console.log(`Second player ${playerName} joining lobby room - activating game!`);
      
      // Set joiner info with client ID
      room.joiner.name = playerName;
      room.joiner.connected = true;
      room.joiner.clientId = ws.id;
      room.originalJoinerName = playerName;
      
      // Activate the room
      room.state = 'active';
      room.lastActivity = Date.now();
      
      // This player stays connected
      ws.room = room.id;
      ws.isViewer = false;
      ws.pinType = 'player';
      
      // Send response to joiner with complete game settings
      const joinResponse = {
        type: 'room_joined',
        pin: pin,
        playerPin: room.playerPin,
        viewerPin: room.viewerPin,
        creatorName: room.creator.name,
        joinerName: playerName,
        settings: room.settings, // Include all game settings from creator
        isViewer: false,
        viewerCount: room.viewers.length,
        gameReady: true,
        gameActive: true // Signal that both players are ready
      };
      
      ws.send(JSON.stringify(joinResponse));
      console.log('Joiner connected - game ready to start');
      
      // Broadcast game start to all connected clients in the room
      broadcastGameStart(room);
      
    } else if (room.state === 'active') {
      // Room is already active - check if this is the creator reconnecting
      
      if (playerName === room.creator.name && !room.creator.clientId) {
        // This is the creator reconnecting
        console.log(`Creator ${playerName} reconnecting to active room`);
        
        room.creator.clientId = ws.id;
        room.creator.connected = true;
        ws.room = room.id;
        ws.isViewer = false;
        ws.pinType = 'player';
        
        const creatorResponse = {
          type: 'room_joined',
          pin: pin,
          playerPin: room.playerPin,
          viewerPin: room.viewerPin,
          creatorName: room.creator.name,
          joinerName: room.joiner.name,
          settings: room.settings,
          isViewer: false,
          viewerCount: room.viewers.length,
          gameActive: true,
          gameReady: true
        };
        
        ws.send(JSON.stringify(creatorResponse));
        console.log('Creator reconnected successfully');
        
        // Broadcast game start to synchronize both players
        broadcastGameStart(room);
        
      } else {
        // Room is already active - add as viewer
        console.log(`Room is active, adding ${playerName} as viewer`);
        
        const viewer = {
          clientId: ws.id,
          name: playerName
        };
        
        room.viewers.push(viewer);
        ws.room = room.id;
        ws.isViewer = true;
        ws.pinType = 'player';
        
        const viewerResponse = {
          type: 'room_joined',
          pin: pin,
          playerPin: room.playerPin,
          viewerPin: room.viewerPin,
          creatorName: room.creator.name,
          joinerName: room.joiner.name,
          settings: room.settings,
          isViewer: true,
          viewerCount: room.viewers.length,
          message: 'Game already active - joined as viewer'
        };
        
        ws.send(JSON.stringify(viewerResponse));
        broadcastViewerUpdate(room);
      }
    }
  }
}

// Broadcast viewer count update to all participants in a room
function broadcastViewerUpdate(room) {
  const viewerUpdateMsg = {
    type: 'viewer_update',
    viewerCount: room.viewers.length
  };
  
  // Send to creator if connected
  if (room.creator.clientId) {
    const creatorWs = clients.get(room.creator.clientId);
    if (creatorWs && creatorWs.readyState === WebSocket.OPEN) {
      creatorWs.send(JSON.stringify(viewerUpdateMsg));
    }
  }
  
  // Send to joiner if exists and connected
  if (room.joiner && room.joiner.clientId) {
    const joinerWs = clients.get(room.joiner.clientId);
    if (joinerWs && joinerWs.readyState === WebSocket.OPEN) {
      joinerWs.send(JSON.stringify(viewerUpdateMsg));
    }
  }
  
  // Send to all viewers
  room.viewers.forEach(viewer => {
    const viewerWs = clients.get(viewer.clientId);
    if (viewerWs && viewerWs.readyState === WebSocket.OPEN) {
      viewerWs.send(JSON.stringify(viewerUpdateMsg));
    }
  });
  
  console.log(`Broadcast viewer update: ${room.viewers.length} viewers`);
}

// Broadcast game start to synchronize both players
function broadcastGameStart(room) {
  console.log('Broadcasting game start to both players...');
  
  const gameStartMsg = {
    type: 'game_start',
    creatorName: room.creator.name,
    joinerName: room.joiner.name,
    settings: room.settings,
    playerPin: room.playerPin,
    viewerPin: room.viewerPin,
    viewerCount: room.viewers.length,
    timestamp: Date.now(), // Add synchronized timestamp
    gameState: room.gameState // Include current game state for sync
  };
  
  console.log('Game start message:', JSON.stringify(gameStartMsg));
  
  // Send to creator if connected
  if (room.creator.clientId) {
    const creatorWs = clients.get(room.creator.clientId);
    if (creatorWs && creatorWs.readyState === WebSocket.OPEN) {
      console.log('Sending game start to creator');
      creatorWs.send(JSON.stringify(gameStartMsg));
    } else {
      console.log('Creator WebSocket not available');
    }
  } else {
    console.log('Creator clientId not set');
  }
  
  // Send to joiner if exists and connected
  if (room.joiner && room.joiner.clientId) {
    const joinerWs = clients.get(room.joiner.clientId);
    if (joinerWs && joinerWs.readyState === WebSocket.OPEN) {
      console.log('Sending game start to joiner');
      joinerWs.send(JSON.stringify(gameStartMsg));
    } else {
      console.log('Joiner WebSocket not available');
    }
  } else {
    console.log('Joiner clientId not set');
  }
  
  // Send to all viewers
  room.viewers.forEach(viewer => {
    const viewerWs = clients.get(viewer.clientId);
    if (viewerWs && viewerWs.readyState === WebSocket.OPEN) {
      viewerWs.send(JSON.stringify(gameStartMsg));
    }
  });
  
  console.log(`Broadcast game start complete`);
}

// Forward game messages between players
function handleGameMessage(ws, data) {
  const { pin, message } = data;
  
  if (!pin || !ws.room) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Not in a valid room'
    }));
    return;
  }
  
  // Find room by PIN (could be player or viewer PIN)
  const room = pinToRoom.get(pin);
  if (!room) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room not found'
    }));
    return;
  }
  
  // Verify the WebSocket is actually in this room
  if (ws.room !== room.id) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'WebSocket not in the correct room'
    }));
    return;
  }
  
  // Update room activity timestamp
  room.lastActivity = Date.now();
  
  // Track moves in room game state
  if (message.type === 'move') {
    room.gameState.moves.push(message.uci);
    room.gameState.turn = room.gameState.turn === 'w' ? 'b' : 'w';
    console.log(`Move tracked: ${message.uci}, moves: ${room.gameState.moves.length}, turn: ${room.gameState.turn}`);
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
  
  // Also send game messages to all viewers so they can watch the game
  if (message.type === 'move' || message.type === 'resign' || message.type === 'rematch-offer' || message.type === 'rematch-accept') {
    room.viewers.forEach(viewer => {
      const viewerWs = clients.get(viewer.clientId);
      if (viewerWs && viewerWs.readyState === WebSocket.OPEN) {
        viewerWs.send(JSON.stringify({
          type: 'game_message',
          message
        }));
      }
    });
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
  
  const roomId = ws.room;
  if (!gameRooms.has(roomId)) return;
  
  const room = gameRooms.get(roomId);
  
  // Check if the leaving client is a viewer
  if (ws.isViewer) {
    // Remove from viewers list
    room.viewers = room.viewers.filter(viewer => viewer.clientId !== ws.id);
    console.log(`Viewer left room ${roomId}. Remaining viewers: ${room.viewers.length}`);
    
    // Notify all participants about updated viewer count
    broadcastViewerUpdate(room);
    
  } else if (room.creator.clientId === ws.id) {
    // Creator disconnected (likely temporary due to Railway timeout)
    console.log(`Creator temporarily disconnected from room ${roomId}`);
    
    // Mark creator as disconnected but preserve their slot
    room.creator.connected = false;
    room.creator.clientId = null;
    
    // Don't send opponent_left immediately - this might be a temporary disconnect
    console.log(`Creator slot preserved for reconnection in room ${roomId}`);
    
  } else if (room.joiner && room.joiner.clientId === ws.id) {
    // Joiner disconnected (likely temporary due to Railway timeout)
    console.log(`Joiner temporarily disconnected from room ${roomId}`);
    
    // Mark joiner as disconnected but preserve their slot
    room.joiner.connected = false;
    room.joiner.clientId = null;
    
    // Don't send opponent_left immediately - this might be a temporary disconnect
    console.log(`Joiner slot preserved for reconnection in room ${roomId}`);
  }
  
  ws.room = null;
  ws.isViewer = false;
}

// Check for dead connections and inactive rooms every 30 seconds
const interval = setInterval(() => {
  const now = Date.now();
  const INACTIVE_TIMEOUT = 5 * 60 * 1000; // 5 minutes of inactivity - give more time for players to join
  
  // Check for dead connections
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      handleLeaveRoom(ws);
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
  
  // Check for inactive rooms to close
  for (const [pin, room] of gameRooms.entries()) {
    const timeSinceActivity = now - room.lastActivity;
    
    if (timeSinceActivity > INACTIVE_TIMEOUT) {
      console.log(`Closing inactive room ${pin} (inactive for ${Math.round(timeSinceActivity/1000)}s)`);
      
      // Notify all participants before closing
      const closeMessage = {
        type: 'room_closed',
        reason: 'Room closed due to inactivity'
      };
      
      // Notify creator
      if (room.creator) {
        const creatorWs = clients.get(room.creator.clientId);
        if (creatorWs && creatorWs.readyState === WebSocket.OPEN) {
          creatorWs.send(JSON.stringify(closeMessage));
          creatorWs.close();
        }
      }
      
      // Notify joiner
      if (room.joiner) {
        const joinerWs = clients.get(room.joiner.clientId);
        if (joinerWs && joinerWs.readyState === WebSocket.OPEN) {
          joinerWs.send(JSON.stringify(closeMessage));
          joinerWs.close();
        }
      }
      
      // Notify viewers
      room.viewers.forEach(viewer => {
        const viewerWs = clients.get(viewer.clientId);
        if (viewerWs && viewerWs.readyState === WebSocket.OPEN) {
          viewerWs.send(JSON.stringify(closeMessage));
          viewerWs.close();
        }
      });
      
      // Delete the room and PIN mappings
      pinToRoom.delete(room.playerPin);
      pinToRoom.delete(room.viewerPin);
      gameRooms.delete(pin);
    }
  }
  
  console.log(`Active rooms: ${gameRooms.size}, Active connections: ${clients.size}`);
}, 30000);

// Clean up interval on server close
wss.on('close', () => {
  clearInterval(interval);
});

// Health check endpoint
app.get('/health', (req, res) => {
  const serverInfo = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: {
      total: wss.clients.size,
      rooms: gameRooms.size
    },
    uptime: process.uptime()
  };
  res.status(200).json(serverInfo);
});

// Check if game is ready to start (for creators and viewers to poll)
app.get('/api/game-status/:pin', (req, res) => {
  const { pin } = req.params;
  
  const room = pinToRoom.get(pin);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const gameReady = room.state === 'active' && room.joiner.name;
  const isPlayerPin = pin === room.playerPin;
  const isViewerPin = pin === room.viewerPin;
  
  res.json({
    gameReady,
    state: room.state,
    creatorName: room.creator.name,
    joinerName: room.joiner.name,
    playerPin: room.playerPin,
    viewerPin: room.viewerPin,
    settings: room.settings,
    pinType: isPlayerPin ? 'player' : (isViewerPin ? 'viewer' : 'unknown'),
    allowConnection: gameReady || isPlayerPin // Players can connect to lobby, viewers need active game
  });
});

// Get active rooms (for debug)
app.get('/api/rooms', (req, res) => {
  const roomsInfo = Array.from(gameRooms.entries()).map(([roomId, room]) => ({
    roomId,
    playerPin: room.playerPin,
    viewerPin: room.viewerPin,
    state: room.state,
    creatorName: room.creator.name,
    hasJoiner: !!room.joiner,
    joinerName: room.joiner?.name || null,
    viewerCount: room.viewers.length
  }));
  
  res.json(roomsInfo);
});

// Log WebSocket server info
wss.on('listening', () => {
  console.log(`WebSocket server is listening on port ${port}`);
});

// Log WebSocket errors
wss.on('error', (error) => {
  console.error('WebSocket server error:', error);
});

// Start the server
server.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
  console.log(`Health check available at: http://localhost:${port}/health`);
  console.log(`WebSocket server ready for connections`);
});// Updated
