# Chessaki WebSocket Server

A WebSocket server for the Chessaki chess application, providing real-time communication between players.

## Features

- WebSocket-based communication for low-latency chess gameplay
- Room-based matchmaking with PIN codes
- Game state synchronization
- Connection health monitoring with ping/pong
- RTT (Round Trip Time) measurement

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Start the server in development mode:
```bash
npm run dev
```

The server will be available at `ws://localhost:3001`.

## Deployment on Railway

This repository is configured for easy deployment on [Railway.app](https://railway.app/).

### Steps to Deploy

1. Fork or clone this repository to your GitHub account
2. Create an account on Railway.app (you can use your GitHub account)
3. Create a new project on Railway and select "Deploy from GitHub repo"
4. Select this repository
5. Railway will automatically detect the Node.js project and deploy it
6. Once deployed, Railway will provide a URL for your WebSocket server

## Environment Variables

Railway automatically sets the `PORT` environment variable, which is all this server needs to run.

## Client-Side Integration

When deploying your Next.js client, set the WebSocket server URL as an environment variable:

```
NEXT_PUBLIC_WEBSOCKET_SERVER=wss://your-railway-app-url
```

For local development, use:
```
NEXT_PUBLIC_WEBSOCKET_SERVER=ws://localhost:3001
```