# ins-neo-fetch

A lightweight Instagram content fetcher powered by [Neo CLI](https://github.com/4ier/neo). Downloads stories and posts from target accounts using Instagram's private API through a real Chrome browser session via Chrome DevTools Protocol (CDP).

## Features

- **Stories & Posts** — Fetches both active stories and recent posts (with carousel/multi-image support)
- **Deduplication** — JSON-based dedup database prevents re-downloading content
- **Date-organized storage** — Files stored as `username/stories|posts/YYYYMMDD/filename`
- **Minimal resource usage** — Uses a persistent Chrome instance via CDP instead of launching headless browsers per request
- **Cron-friendly** — Designed to run periodically; auto-detects and reconnects Chrome/Neo if needed

## How It Works

This project uses [**Neo**](https://github.com/4ier/neo) (`@4ier/neo`) to turn an authenticated Instagram browser session into an API. Neo connects to a running Chrome instance via CDP and executes `fetch()` calls directly in the page context, inheriting the browser's cookies and authentication state. This avoids the need for API tokens, cookie extraction, or session management.

```
Chrome (with Instagram login) 
  ↕ CDP (port 9222)
Neo CLI
  ↕ neo eval / neo exec
ins-neo-fetch (this project)
```

## Prerequisites

- **Node.js** >= 18
- **Neo CLI** — `npm install -g @4ier/neo`
- **Chrome/Chromium** — A running instance with `--remote-debugging-port=9222`
- For headless servers: **Xvfb** (virtual framebuffer)

## Setup

```bash
# Clone
git clone https://github.com/Yoru0908/ins-neo-fetch.git
cd ins-neo-fetch

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your download directory and target accounts

# Build
npm run build
```

## Configuration

Edit `.env`:

```env
DOWNLOAD_DIR=./downloads
TARGET_ACCOUNTS=account1,account2,account3
```

## Usage

### 1. Start Chrome with CDP

```bash
# On a desktop
google-chrome --remote-debugging-port=9222 --user-data-dir=./chrome-profile https://www.instagram.com/

# On a headless server
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
chromium --remote-debugging-port=9222 --user-data-dir=./chrome-profile --no-sandbox --no-first-run https://www.instagram.com/
```

### 2. Login to Instagram (first time only)

If running on a remote server, use SSH port forwarding to access the Chrome instance:

```bash
# On your local machine
ssh -L 9222:localhost:9222 user@server

# Then open Chrome on your local machine and go to:
# chrome://inspect/#devices
# Click "inspect" on the Instagram tab and login
```

The login session persists in the `chrome-profile` directory.

### 3. Connect Neo

```bash
neo connect 9222
```

### 4. Run the fetcher

```bash
node dist/index.js
```

### 5. Automate with cron

```bash
# Run every 4 hours
0 */4 * * * /path/to/scripts/ins-neo-fetcher.sh >> /path/to/logs/cron.log 2>&1

# Auto-start Chrome on reboot
@reboot sleep 30 && /path/to/scripts/ins-neo-start-chrome.sh >> /path/to/logs/chrome-boot.log 2>&1
```

## Directory Structure

Downloaded files are organized as:

```
downloads/
├── username1/
│   ├── stories/
│   │   └── 20260311/
│   │       ├── story_1234567890.jpg
│   │       └── story_1234567891.mp4
│   └── posts/
│       └── 20260310/
│           ├── posts_ABC123_9876543210_0.jpg
│           └── posts_ABC123_9876543210_1.jpg
├── username2/
│   └── ...
└── dedup_database.json
```

## Acknowledgments

- [**Neo**](https://github.com/4ier/neo) by [@4ier](https://github.com/4ier) — Turn any website into an AI-callable API. This project relies on Neo's CDP-based `eval` and `connect` commands to interact with Instagram's private API through an authenticated browser session.

## License

MIT
