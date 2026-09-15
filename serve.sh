#!/bin/bash
# Sirve la Web UI como estático para desarrollo del frontend (sin backend).
# La API se toma de http://localhost:8000 automáticamente (AETHER_API_BASE).
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-5173}"
API="${AETHER_API_BASE:-http://localhost:8000}"

# Inyecta la base de la API en el index que se sirve (copia temporal).
STAGE="$(mktemp -d)"
cp -r "$DIR/web/." "$STAGE/"
sed -i "s|<script src=\"app.js\"></script>|<script>window.AETHER_API_BASE=\"$API\";</script>\n    <script src=\"app.js\"></script>|" "$STAGE/index.html"

echo "🎨 Aether Web UI (dev): http://localhost:$PORT"
echo "🔌 API apuntando a:      $API"
cd "$STAGE" && exec python3 -m http.server "$PORT" --bind 127.0.0.1