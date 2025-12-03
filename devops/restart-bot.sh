#!/bin/bash

# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use Node 24
nvm use 24

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Kill existing bot process if running
pkill -f "node.*dist/bot.js" 2>/dev/null && echo "Killed existing bot process" || echo "No existing bot process found"

# Wait a moment for process to die
sleep 1

# Build TypeScript
cd "$PROJECT_DIR"
echo "Building TypeScript..."
npm run build

# Start the bot
echo "Starting bot from $PROJECT_DIR..."
nohup node dist/bot.js > /tmp/tg_bot.log 2>&1 &

echo "Bot started with PID $!"
echo "Logs at /tmp/tg_bot.log"
