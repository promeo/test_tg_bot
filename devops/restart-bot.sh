#!/bin/bash

# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Kill existing bot process if running
pkill -f "node.*src/bot.js" 2>/dev/null && echo "Killed existing bot process" || echo "No existing bot process found"

# Wait a moment for process to die
sleep 1

# Start the bot
cd "$PROJECT_DIR"
echo "Starting bot from $PROJECT_DIR..."
nohup node src/bot.js > /tmp/tg_bot.log 2>&1 &

echo "Bot started with PID $!"
echo "Logs at /tmp/tg_bot.log"
