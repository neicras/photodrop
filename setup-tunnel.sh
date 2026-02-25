#!/bin/bash
# One-time setup: create tunnel + DNS for photodrop.ericsan.io
# Requires: cloudflared, Cloudflare account with ericsan.io

set -e
cd "$(dirname "$0")"

echo "✦ Setting up photodrop.ericsan.io tunnel..."
echo ""

# Create tunnel (idempotent - will use existing if present)
if ! cloudflared tunnel list 2>/dev/null | grep -q photodrop; then
  cloudflared tunnel create photodrop
fi

# Route DNS
cloudflared tunnel route dns photodrop photodrop.ericsan.io

# Get tunnel UUID and write config
TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep photodrop | awk '{print $1}')
CREDS="$HOME/.cloudflared/${TUNNEL_ID}.json"

cat > cloudflared.yml << EOF
# PhotoDrop tunnel — https://photodrop.ericsan.io
tunnel: $TUNNEL_ID
credentials-file: $CREDS

ingress:
  - hostname: photodrop.ericsan.io
    service: http://localhost:3000
  - service: http_status:404
EOF

echo ""
echo "✦ Done. To run the tunnel:"
echo "  cloudflared tunnel --config $(pwd)/cloudflared.yml run"
echo ""
echo "  Gallery: https://photodrop.ericsan.io"
