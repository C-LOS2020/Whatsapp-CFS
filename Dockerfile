# ---- build the Go WhatsApp bridge ----
FROM golang:1.26-bookworm AS bridge
WORKDIR /src
COPY app/whatsapp-bridge/go.mod app/whatsapp-bridge/go.sum ./
RUN go mod download
COPY app/whatsapp-bridge/ ./
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/whatsapp-bridge .

# ---- dispatch sync dependencies (Node) ----
FROM node:24-bookworm-slim AS dispatch
WORKDIR /dispatch
COPY app/dispatch/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
ENV TZ=America/Nassau PYTHONUNBUFFERED=1
WORKDIR /app
COPY app/whatsapp-mcp-server/ /app/whatsapp-mcp-server/
RUN python -m venv /app/venv && /app/venv/bin/pip install --no-cache-dir /app/whatsapp-mcp-server \
    && /app/venv/bin/pip install --no-cache-dir "uvicorn>=0.30" "starlette>=0.40" "httpx>=0.28"
COPY --from=bridge /out/whatsapp-bridge /app/whatsapp-bridge
COPY --from=dispatch /usr/local/bin/node /usr/local/bin/node
COPY --from=dispatch /dispatch/node_modules /app/dispatch/node_modules
COPY app/dispatch/*.mjs app/dispatch/package.json /app/dispatch/
COPY app/gateway.py app/start.sh /app/
CMD ["/app/start.sh"]
