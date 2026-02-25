#!/bin/bash
# ✦ PhotoDrop — Share photos without uploading
# Double-click this file to run. No terminal knowledge needed.

clear
echo ""
echo "  ✦  P H O T O D R O P"
echo "  ─────────────────────────────────────"
echo "  Share photos from your machine."
echo "  No upload. No cloud. Your files stay here."
echo ""

# ── Check & install dependencies ──

install_homebrew() {
    echo "  [1/3] Installing Homebrew (macOS package manager)..."
    echo "        You may be asked for your password."
    echo ""
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    
    # Add Homebrew to PATH for Apple Silicon
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
}

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

MISSING=0

if ! command -v brew &>/dev/null; then
    install_homebrew
fi

if ! command -v node &>/dev/null; then
    MISSING=1
    echo "  Installing Node.js..."
    brew install node 2>/dev/null
    echo ""
fi

if ! command -v cloudflared &>/dev/null; then
    MISSING=1
    echo "  Installing cloudflared (secure tunnel)..."
    brew install cloudflared 2>/dev/null
    echo ""
fi

if [ $MISSING -eq 1 ]; then
    echo "  ✓ Dependencies installed. You won't see this again."
    echo ""
fi

# ── Pick photo folder ──

FOLDER=$(osascript -e '
    try
        set f to choose folder with prompt "Select your photo folder or SD card"
        return POSIX path of f
    on error
        return ""
    end try
' 2>/dev/null)

if [ -z "$FOLDER" ]; then
    echo "  No folder selected. Closing."
    echo ""
    exit 0
fi

echo "  Folder: $FOLDER"
echo ""

# ── Optional date filter ──

DATE_FILTER=$(osascript -e '
    try
        set d to display dialog "Filter by date? (leave empty for all photos)" & return & return & "Format: YYYY-MM-DD (e.g. 2026-02-15)" default answer "" buttons {"All Photos", "Filter"} default button "All Photos"
        if button returned of d is "Filter" then
            return text returned of d
        else
            return ""
        end if
    on error
        return ""
    end try
' 2>/dev/null)

ARGS="$FOLDER"
if [ -n "$DATE_FILTER" ]; then
    ARGS="$FOLDER $DATE_FILTER"
    echo "  Date filter: $DATE_FILTER"
fi

echo "  Starting PhotoDrop..."
echo "  ─────────────────────────────────────"
echo ""

# ── Run PhotoDrop ──

npx --yes photodrop-share@latest $ARGS
