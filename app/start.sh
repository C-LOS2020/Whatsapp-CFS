#!/usr/bin/env bash
# Runs the WhatsApp bridge, the MCP server and the public gateway in one
# container. If any of them exits, the container exits and Railway restarts it.
set -uo pipefail

DATA_DIR="${DATA_DIR:-/data}"
export STORE_DIR="$DATA_DIR/store"
mkdir -p "$STORE_DIR" "$DATA_DIR/outbox" "$DATA_DIR/dispatch"
export DISPATCH_STATE_DIR="$DATA_DIR/dispatch"
chmod 700 "$STORE_DIR"

export WHATSAPP_DB_PATH="$STORE_DIR/messages.db"
export WHATSMEOW_DB_PATH="$STORE_DIR/whatsapp.db"
export WHATSAPP_API_URL="http://localhost:8080/api"
export WHATSAPP_MEDIA_ROOTS="${WHATSAPP_MEDIA_ROOTS:-$DATA_DIR/outbox:$STORE_DIR}"
export WHATSAPP_DEVICE_NAME="${WHATSAPP_DEVICE_NAME:-Claude Cloud (Railway)}"
export WEBHOOK_URL="${WEBHOOK_URL:-}"

echo "[start] launching WhatsApp bridge"
( cd "$DATA_DIR" && exec /app/whatsapp-bridge ) &
BRIDGE_PID=$!

# The bridge writes its REST token on first start; the MCP server reads it.
for _ in $(seq 1 60); do
  [ -s "$STORE_DIR/.bridge-token" ] || [ -n "${WHATSAPP_BRIDGE_TOKEN:-}" ] && break
  sleep 1
done

echo "[start] launching MCP server"
( cd /app/whatsapp-mcp-server && WHATSAPP_MCP_TRANSPORT=http WHATSAPP_MCP_HOST=127.0.0.1 WHATSAPP_MCP_PORT=8000 \
    exec /app/venv/bin/python main.py ) &
MCP_PID=$!

echo "[start] launching gateway on port ${PORT:-8088}"
( exec /app/venv/bin/python /app/gateway.py ) &
GW_PID=$!

echo "[start] launching PPB dispatch sync loop"
( cd /app/dispatch && exec node loop.mjs ) &
DISPATCH_PID=$!

trap 'kill $BRIDGE_PID $MCP_PID $GW_PID $DISPATCH_PID 2>/dev/null' TERM INT
wait -n
echo "[start] a process exited; stopping container so Railway restarts it"
kill $BRIDGE_PID $MCP_PID $GW_PID $DISPATCH_PID 2>/dev/null
exit 1
