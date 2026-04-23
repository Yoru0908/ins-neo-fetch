#!/bin/bash
DISPLAY_NUM=99
CDP_PORT=9222
CHROME_PROFILE="/vol1/ins-neo-fetcher/chrome-profile"
export PATH="/vol1/@appcenter/nodejs_v22/bin:$PATH"

# Start Xvfb
Xvfb :${DISPLAY_NUM} -screen 0 1920x1080x24 &
XVFB_PID=$!
sleep 2
export DISPLAY=:${DISPLAY_NUM}

# Start Chrome (foreground for systemd)
chromium \
    --remote-debugging-port=${CDP_PORT} \
    --user-data-dir="${CHROME_PROFILE}" \
    --no-first-run \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --no-sandbox \
    --disable-dev-shm-usage \
    "https://www.instagram.com/"

# Cleanup on exit
kill $XVFB_PID 2>/dev/null
