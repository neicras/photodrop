# PhotoDrop

Share photos from your SD card or folder — no upload, no cloud. One command, one link.

PhotoDrop serves a gallery from your local files over a secure Cloudflare Tunnel. Recipients browse thumbnails, preview full-size, and download originals. Your photos never leave your machine.

## Features

- **RAW support** — CR2, ARW, NEF, DNG, and more. Extracts embedded JPEG previews automatically.
- **Secure tunnel** — Cloudflare Tunnel creates a public HTTPS link. No port forwarding, no account needed.
- **Date filtering** — Share only photos from a specific date (e.g. an event day).
- **Batch download** — Recipients select photos and download as ZIP.
- **Zero upload** — Files are served directly from your machine. Nothing is copied anywhere.

## Quick Start

```bash
brew install node cloudflared    # one-time setup (macOS)
npx photodrop-share /Volumes/SD  # run each time
```

A public URL prints in terminal. Send it to anyone.

## Usage

```bash
# Serve all photos in a folder
npx photodrop-share /path/to/photos

# Serve only photos from a specific date
npx photodrop-share /path/to/photos 2026-02-15

# Serve from SD card (macOS)
npx photodrop-share /Volumes/Untitled
```

## How It Works

1. Scans your folder (including subdirectories) for image files
2. Generates thumbnails and previews into a `.photodrop` cache folder
3. Starts a local Express server on port 3000
4. Opens a Cloudflare Tunnel for public access (if `cloudflared` is installed)
5. Prints the shareable URL

## Requirements

- **Node.js** 18+ (`brew install node`)
- **cloudflared** for public sharing (`brew install cloudflared`) — optional, works on localhost without it

## License

MIT — Eric San (https://ericsan.io)
