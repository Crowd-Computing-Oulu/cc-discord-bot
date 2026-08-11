#!/bin/bash

# Start ngrok if auth token is provided
if [ -n "$NGROK_AUTHTOKEN" ]; then
  echo "Starting ngrok tunnel..."
  ngrok config add-authtoken "$NGROK_AUTHTOKEN"
  ngrok http 3099 > /tmp/ngrok.log 2>&1 &
  NGROK_PID=$!

  # Wait for ngrok to initialize
  sleep 4

  # Get the public URL from ngrok API
  NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$NGROK_URL" ]; then
    echo "✓ ngrok tunnel active: $NGROK_URL/email/inbound"
  else
    echo "✗ Failed to get ngrok URL"
    cat /tmp/ngrok.log
  fi
fi

# Start the bot
npm start
