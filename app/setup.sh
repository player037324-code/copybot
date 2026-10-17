#!/usr/bin/env bash
# One-time server setup. Run from inside the copybot folder: bash setup.sh
set -e
echo ">> Installing Node 22 + pm2 (if needed)"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2
echo ">> Installing bot packages"
npm install --omit=dev
[ -f .env ] || cp .env.example .env
chmod 600 .env
mkdir -p logs
echo ""
echo "Done. Next: nano .env  (paste HELIUS_API_KEY and JUP_API_KEY)"
