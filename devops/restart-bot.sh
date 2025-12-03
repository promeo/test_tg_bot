#!/bin/bash

# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use Node 24
nvm use 24

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Function to count bot processes using ps/grep (not pgrep)
count_bot_processes() {
    ps aux | grep "node.*bot.js" | grep -v grep | grep -v "restart-bot.sh" | wc -l
}

# Function to kill bot processes using ps/grep (not pkill)
kill_bot_processes() {
    ps aux | grep "node.*bot.js" | grep -v grep | grep -v "restart-bot.sh" | awk '{print $2}' | xargs -r kill -9 2>/dev/null
}

# Kill all existing bot processes with retry loop
echo "Killing all bot processes..."
MAX_ATTEMPTS=10
ATTEMPT=0

while true; do
    # Count running bot processes
    COUNT=$(count_bot_processes)

    if [ "$COUNT" -eq 0 ]; then
        echo "All bot processes killed"
        break
    fi

    ATTEMPT=$((ATTEMPT + 1))
    if [ "$ATTEMPT" -gt "$MAX_ATTEMPTS" ]; then
        echo "WARNING: Could not kill all processes after $MAX_ATTEMPTS attempts"
        break
    fi

    echo "Found $COUNT bot process(es), killing... (attempt $ATTEMPT)"
    kill_bot_processes
    sleep 1
done

# Clear log file
rm -f /tmp/tg_bot.log

# Build TypeScript
cd "$PROJECT_DIR"
echo "Building TypeScript..."
npm run build

if [ $? -ne 0 ]; then
    echo "Build failed!"
    exit 1
fi

# Start the bot with unbuffered output
echo "Starting bot from $PROJECT_DIR..."
nohup stdbuf -oL -eL node dist/bot.js > /tmp/tg_bot.log 2>&1 &
BOT_PID=$!

# Wait a moment and verify it started
sleep 2
COUNT=$(count_bot_processes)
if [ "$COUNT" -gt 0 ]; then
    echo "Bot started with PID $BOT_PID"
    echo "Logs at /tmp/tg_bot.log"
    echo ""
    echo "Initial log output:"
    cat /tmp/tg_bot.log
else
    echo "ERROR: Bot failed to start!"
    cat /tmp/tg_bot.log
    exit 1
fi
