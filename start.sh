#!/usr/bin/env bash
set -e

echo "🎮 Cinematic Bazaar — Starting server..."
echo "📱 Frontend: http://localhost:3000"
echo "🔌 WebSocket: ws://localhost:3000/ws"
echo ""

# Start the Node.js server (handles both static files and WebSocket)
node dist/server.js
