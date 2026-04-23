#!/bin/bash
# Run ins-neo-fetcher once (called by cron)
# Usage: ins-neo-fetcher.sh [group]
#   group: sakurazaka | nogizaka | hinatazaka | all (default: all)

CDP_PORT=9222
DISPLAY_NUM=99
CHROME_PROFILE="/vol1/ins-neo-fetcher/chrome-profile"
LOG_DIR="/vol1/ins-neo-fetcher/logs"
FETCHER_DIR="/vol1/ins-neo-fetcher"
GROUP_DIR="/vol1/ins-neo-fetcher/groups"
GROUP="${1:-all}"
shift 2>/dev/null
EXTRA_ARGS="${EXTRA_ARGS:-} $@"

export DISPLAY=:${DISPLAY_NUM}
export PATH="/vol1/@appcenter/nodejs_v22/bin:$PATH"

# If a group is specified, load accounts from group file
if [ "$GROUP" != "all" ] && [ -f "${GROUP_DIR}/${GROUP}.txt" ]; then
    export TARGET_ACCOUNTS=$(cat "${GROUP_DIR}/${GROUP}.txt" | tr -d "\n")
    echo "[$(date)] Group: ${GROUP} ($(echo $TARGET_ACCOUNTS | tr "," "\n" | wc -l) accounts)"
else
    echo "[$(date)] Group: all (using .env TARGET_ACCOUNTS)"
fi

# Ensure Xvfb is running
if ! pgrep -f "Xvfb :${DISPLAY_NUM}" > /dev/null; then
    echo "[$(date)] Starting Xvfb..."
    Xvfb :${DISPLAY_NUM} -screen 0 1920x1080x24 &
    sleep 2
fi

# Ensure Chrome with CDP is running AND reachable
CDP_OK=false
if pgrep -f "remote-debugging-port=${CDP_PORT}" > /dev/null; then
    if curl -s --max-time 3 http://localhost:${CDP_PORT}/json/version | grep -q Browser; then
        CDP_OK=true
    else
        echo "[$(date)] Chrome running but CDP not responding, killing..."
        kill $(pgrep -f "remote-debugging-port=${CDP_PORT}") 2>/dev/null
        sleep 3
    fi
fi

if [ "$CDP_OK" = false ]; then
    echo "[$(date)] Starting Chrome with CDP..."
    chromium \
        --remote-debugging-port=${CDP_PORT} \
        --user-data-dir="${CHROME_PROFILE}" \
        --no-first-run \
        --disable-background-timer-throttling \
        --disable-backgrounding-occluded-windows \
        --disable-renderer-backgrounding \
        --no-sandbox \
        --disable-dev-shm-usage \
        "https://www.instagram.com/" \
        > "${LOG_DIR}/chrome.log" 2>&1 &
    sleep 8
fi

# Always ensure Neo is connected
neo connect ${CDP_PORT} 2>/dev/null

# Run the fetcher
echo "[$(date)] Starting fetch cycle (${GROUP})..."
cd "${FETCHER_DIR}"
node dist/index.js $EXTRA_ARGS 2>&1 | tee -a "${LOG_DIR}/fetcher-${GROUP}.log"
echo "[$(date)] Fetch cycle done (${GROUP})."
