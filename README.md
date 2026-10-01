# WhatsApp CFS — cloud bridge

Runs Carlos's WhatsApp connection 24/7 on Railway so Claude scheduled tasks
work without the office PC being on.

One container runs three processes:

| Process | Listens on | Purpose |
|---|---|---|
| WhatsApp bridge (Go, whatsmeow) | 127.0.0.1:8080 (private) | Linked-device session; stores messages in SQLite |
| WhatsApp MCP server (Python) | 127.0.0.1:8000 (private) | The tools Claude uses (list_chats, list_messages, send_message, …) |
| Gateway | `$PORT` (public) | Secret-key front door + QR linking page |

Based on [verygoodplugins/whatsapp-mcp](https://github.com/verygoodplugins/whatsapp-mcp) v0.7.0 (MIT),
with one small patch so the pairing QR can be shown in a browser.

## Railway settings

- **Volume** mounted at `/data` (holds the WhatsApp session + message database; without it you'd re-link on every deploy)
- **Variable** `ACCESS_KEY` = long random string (keep secret)
- **Networking** → generate a public domain

## URLs (replace KEY with ACCESS_KEY)

- Link WhatsApp: `https://<domain>/KEY/link/`
- Claude connector: `https://<domain>/KEY/mcp`

Anyone with the KEY can read and send messages on this WhatsApp account, so
treat the connector URL like a password. To rotate it, change `ACCESS_KEY` in
Railway and update the connector URL in Claude.
