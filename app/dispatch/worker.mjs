// Real-time PPB dispatch sync, running inside the Railway WhatsApp service.
//
// Each run (loop.mjs runs this every minute):
//   1. reads new messages from the two PPB dispatch chats straight out of the
//      WhatsApp bridge's SQLite store,
//   2. asks Claude to turn the dispatch requests into structured items,
//   3. hands them to sync-to-firestore.mjs (dedupes by WhatsApp message id),
//   4. posts a "✅ Logged as ..." confirmation back to the chat via the bridge,
//   5. confirms requests entered directly in the app to the chat on duty that
//      day (Mon–Fri PPB Dispatch Sales, Sat–Sun PPB Weekend Team).
//
// State lives in $DISPATCH_STATE_DIR/sync_state.json (on the Railway volume).
// It only advances after the Firestore write succeeds, so a failed run is
// simply retried next time.
//
// Usage: node worker.mjs            normal run
//        node worker.mjs --list     print the new messages it would read; no Claude call, no writes
//        node worker.mjs --dry-run  also run the Claude extraction and print it; no writes, no posts

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const LIST_ONLY = process.argv.includes('--list')
const DRY_RUN = process.argv.includes('--dry-run')

const SALES_JID = '120363024590153005@g.us'
const WEEKEND_JID = '120363424833919931@g.us'
const CHATS = {
  [SALES_JID]: 'PPB DISPATCH SALES',
  [WEEKEND_JID]: 'PPB WEEKEND TEAM',
}
// Messages younger than this are left for the next run, so a request typed as
// several quick messages (name, then address, then phone) is read as a whole.
const SETTLE_MS = Number(process.env.DISPATCH_SETTLE_SECONDS || 90) * 1000
const CONTEXT_MESSAGES = 5
const FIRST_RUN_LOOKBACK_MS = Number(process.env.DISPATCH_FIRST_RUN_LOOKBACK_HOURS || 6) * 3600000
const CONFIRMATION_PREFIX = /^✅ Logged as /

const env = process.env
const STORE_DIR = env.STORE_DIR || '/data/store'
const STATE_DIR = env.DISPATCH_STATE_DIR || '/data/dispatch'
const BRIDGE_URL = env.BRIDGE_URL || 'http://127.0.0.1:8080'
const MODEL = (env.CLAUDE_MODEL || 'claude-opus-5-5').trim()
const FALLBACK_MODEL = (env.CLAUDE_FALLBACK_MODEL || 'claude-sonnet-5-5').trim()

// go-sqlite3 stores times like "2026-09-27 12:39:48.123456789-04:00".
function parseTs(raw) {
  const s = String(raw).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')
  return new Date(s)
}

function statePath() {
  mkdirSync(STATE_DIR, { recursive: true })
  return join(STATE_DIR, 'sync_state.json')
}

function readState() {
  const path = statePath()
  if (!existsSync(path)) return { last_scan_iso: null }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeState(state) {
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n')
}

function loadMessages(since) {
  const msgs = new DatabaseSync(join(STORE_DIR, 'messages.db'), { readOnly: true })
  const wa = new DatabaseSync(join(STORE_DIR, 'whatsapp.db'), { readOnly: true })
  const nameStmt = wa.prepare(
    'SELECT full_name, push_name, first_name, business_name FROM whatsmeow_contacts WHERE their_jid = ? LIMIT 1',
  )
  const senderName = (sender) => {
    const jid = sender.includes('@') ? sender : `${sender}@s.whatsapp.net`
    let row
    try { row = nameStmt.get(jid) } catch { row = null }
    const name = row && (row.full_name || row.push_name || row.first_name || row.business_name)
    const phone = sender.split('@')[0]
    return name ? `${name} (${phone})` : phone
  }

  // String prefilter on the date part (one day of slack for timezone offsets),
  // exact comparison in JS after parsing.
  const dayBefore = new Date(since.getTime() - 86400000).toISOString().slice(0, 10)
  const stmt = msgs.prepare(`
    SELECT id, chat_jid, sender, content, timestamp, is_from_me, media_type
    FROM messages
    WHERE chat_jid = ? AND timestamp >= ? AND deleted_at IS NULL
    ORDER BY timestamp ASC`)

  const cutoff = Date.now() - SETTLE_MS
  const fresh = []
  const context = []
  for (const [jid, chatName] of Object.entries(CHATS)) {
    const rows = stmt.all(jid, dayBefore)
      // Our own confirmations name the customer; never feed them back in.
      .filter((r) => !(r.is_from_me && CONFIRMATION_PREFIX.test(r.content || '')))
      .map((r) => ({
        messageId: r.id,
        chat: chatName,
        sender: r.is_from_me ? 'Me' : senderName(r.sender || ''),
        timestamp: parseTs(r.timestamp),
        text: r.content || '',
        mediaType: r.media_type || '',
      }))
    const older = rows.filter((r) => r.timestamp <= since)
    context.push(...older.slice(-CONTEXT_MESSAGES))
    fresh.push(...rows.filter((r) => r.timestamp > since && r.timestamp.getTime() <= cutoff))
  }
  msgs.close()
  wa.close()
  return { fresh, context }
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requests', 'notes', 'fraudMessageIds'],
  properties: {
    requests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'messageIds', 'customerName', 'customerContact', 'fuelType', 'fuelQuantity',
          'chargePayment', 'dateRequested', 'deliveryLocation', 'directions',
        ],
        properties: {
          messageIds: { type: 'array', items: { type: 'string' } },
          customerName: { type: 'string' },
          customerContact: { type: 'string' },
          fuelType: { type: 'string' },
          fuelQuantity: { type: 'string' },
          chargePayment: { type: 'string' },
          dateRequested: { type: 'string' },
          deliveryLocation: { type: 'string' },
          directions: { type: 'string' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    fraudMessageIds: { type: 'array', items: { type: 'string' } },
  },
}

const SYSTEM_PROMPT = `You read WhatsApp messages from the dispatch group chats of PropanePLUS (a propane/fuel delivery company in Nassau, Bahamas) and turn delivery requests into records for the dispatch app.

Rules:
- The minimum to log a request is a customer name. The dispatcher fills in anything missing in the app, so log every message that names a customer (e.g. "Tanya Lewis 448-4589", "Trevor EZ trucking at 4 pm", a name with an email and phone), even with no quantity, address or fuel type. Never drop a request just because it is incomplete.
- Fields: customerName; customerContact (phone); fuelType (e.g. "LPG", "Diesel"; cylinder sizes like 20lb/100lb are LPG); fuelQuantity (e.g. "20lb", "100 gal"); chargePayment; dateRequested (a specific date or time if given, "ASAP" if asked for urgently); deliveryLocation; directions (landmarks/directions, plus any extra detail such as an email or a time). Use "Not specified" for anything not given. Keep the customer's wording; don't invent details.
- A request often arrives as several consecutive messages from the same sender (name, then address, then phone). Merge them into one request and list all their ids in messageIds, first message first.
- A message that repeats an earlier request word for word (a repost) is not a new request; skip it and mention it in notes.
- Skip messages with no customer name: chatter, greetings, staff availability, status updates, photos without a request, price lists. Mention anything a dispatcher should look at in notes (e.g. a bare "Canceled." whose order is unclear), one short sentence each.
- Messages marked context_only were already processed; use them only to understand the new ones, never log them.
- Put the id of any message with financial-fraud red flags (advance-fee scams, requests for codes/CVV, "loader"/"quantum loading", MTN/SBLC/MT760 leasing) in fraudMessageIds and do not log it.

Reply with a single JSON object only: {"requests":[{"messageIds":[...],"customerName":"","customerContact":"","fuelType":"","fuelQuantity":"","chargePayment":"","dateRequested":"","deliveryLocation":"","directions":""}],"notes":[],"fraudMessageIds":[]}`

function parseJsonReply(text) {
  try { return JSON.parse(text) } catch {}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1))
  throw new Error('Claude reply was not JSON')
}

async function callClaude(client, model, payloadText, structured) {
  const params = {
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: payloadText }],
  }
  if (structured) params.output_config = { format: { type: 'json_schema', schema: RESULT_SCHEMA } }
  const response = await client.messages.create(params)
  if (response.stop_reason === 'refusal') throw new Error('Claude declined the batch')
  if (response.stop_reason === 'max_tokens') throw new Error('Claude response was cut off (max_tokens)')
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  if (!text) throw new Error('Claude returned no text block')
  return parseJsonReply(text)
}

async function extract(fresh, context) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')

  const payload = [
    ...context.map((m) => ({ ...m, context_only: true })),
    ...fresh.map((m) => ({ ...m, context_only: false })),
  ].map((m) => ({
    messageId: m.messageId,
    chat: m.chat,
    sender: m.sender,
    timestamp: m.timestamp.toISOString(),
    text: m.text,
    attachment: m.mediaType || undefined,
    context_only: m.context_only,
  }))
  const payloadText = JSON.stringify(payload, null, 1)

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY.trim() })
  // Try structured output on the main model; if the API rejects the request
  // shape or the model, fall back to plain JSON and/or the fallback model.
  const attempts = [[MODEL, true], [MODEL, false], [FALLBACK_MODEL, false]]
  let lastErr
  for (const [model, structured] of attempts) {
    try {
      const result = await callClaude(client, model, payloadText, structured)
      result.requests ??= []
      result.notes ??= []
      result.fraudMessageIds ??= []
      return result
    } catch (err) {
      lastErr = err
      const status = err?.status
      // Only fall through on request-shape / model errors; auth, rate limit and
      // server errors are retried on the next run instead.
      if (status && status !== 400 && status !== 404) throw err
      console.error(`[dispatch] ${model} structured=${structured} failed: ${err.message}`)
    }
  }
  throw lastErr
}

function toBatchItems(result, fresh) {
  const byId = new Map(fresh.map((m) => [m.messageId, m]))
  const fraud = new Set(result.fraudMessageIds)
  const items = []
  for (const req of result.requests) {
    const parts = (req.messageIds || []).map((id) => byId.get(id)).filter(Boolean)
    if (!parts.length || parts.some((m) => fraud.has(m.messageId))) continue
    const first = parts[0]
    const { messageIds, ...fields } = req
    items.push({
      ...fields,
      sourceMessage: {
        messageId: first.messageId,
        text: parts.map((m) => m.text).filter(Boolean).join('\n\n'),
        sender: first.sender,
        chat: first.chat,
        timestamp: first.timestamp.toISOString(),
        hasAttachment: parts.some((m) => ['image', 'document', 'video'].includes(m.mediaType)),
      },
    })
  }
  return items
}

function confirmationText(item) {
  const parts = [item.customerName]
  const qty = [item.fuelQuantity, item.fuelType].filter((v) => v && v !== 'Not specified').join(' ')
  if (qty) parts.push(qty)
  if (item.deliveryLocation && item.deliveryLocation !== 'Not specified') parts.push(item.deliveryLocation)
  return `✅ Logged as ${item.refNumber} — ${parts.join(', ')}`
}

// Mon–Fri → PPB Dispatch Sales, Sat–Sun → PPB Weekend Team, by Nassau calendar day.
function onDutyChat(createdAt) {
  const weekday = new Date(createdAt).toLocaleString('en-US', { timeZone: 'America/Nassau', weekday: 'long' })
  return weekday === 'Saturday' || weekday === 'Sunday' ? WEEKEND_JID : SALES_JID
}

function runSyncScript(...args) {
  const out = execFileSync(process.execPath, [join(DIR, 'sync-to-firestore.mjs'), ...args], {
    cwd: STATE_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return JSON.parse(out.trim().split('\n').pop())
}

export async function sendWhatsApp(chatJid, message) {
  const token = (env.WHATSAPP_BRIDGE_TOKEN || readFileSync(join(STORE_DIR, '.bridge-token'), 'utf8')).trim()
  const resp = await fetch(`${BRIDGE_URL}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ recipient: chatJid, message }),
  })
  if (!resp.ok) throw new Error(`Bridge send failed: ${resp.status} ${await resp.text()}`)
}

async function syncWhatsAppRequests(state, sendFailures) {
  if (!state.last_scan_iso) {
    // First run in the cloud: only look back a few hours (the PC sync covered
    // everything older, and Firestore dedupes by message id anyway).
    state = { ...state, last_scan_iso: new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString() }
    if (!LIST_ONLY && !DRY_RUN) writeState(state)
  }
  const since = new Date(state.last_scan_iso)
  const { fresh, context } = loadMessages(since)

  if (LIST_ONLY) {
    console.log(JSON.stringify({ since: since.toISOString(), fresh, contextCount: context.length }, null, 2))
    return null
  }
  if (!fresh.length) return { scanned: 0 }

  const result = await extract(fresh, context)
  const items = toBatchItems(result, fresh)

  if (DRY_RUN) {
    console.log(JSON.stringify({ items, notes: result.notes, fraudMessageIds: result.fraudMessageIds }, null, 2))
    return null
  }

  let summary = { created: 0, skipped: 0, createdItems: [] }
  if (items.length) {
    writeFileSync(join(STATE_DIR, '.tmp-sync-batch.json'), JSON.stringify(items, null, 2))
    summary = runSyncScript(join(STATE_DIR, '.tmp-sync-batch.json'))
  }

  // Firestore write succeeded: advance state now, so a failed confirmation
  // below can't cause the same messages to be re-extracted.
  const newest = fresh.reduce((a, m) => (m.timestamp > a ? m.timestamp : a), since)
  writeState({ ...state, last_scan_iso: newest.toISOString() })

  const jidByChat = Object.fromEntries(Object.entries(CHATS).map(([jid, name]) => [name, jid]))
  for (const created of summary.createdItems) {
    try {
      await sendWhatsApp(jidByChat[created.chat], confirmationText(created))
    } catch (err) {
      sendFailures.push(`${created.refNumber}: ${err.message}`)
    }
  }

  return {
    scanned: fresh.length,
    created: summary.created,
    duplicates: summary.skipped,
    withAttachments: items.filter((i) => i.sourceMessage.hasAttachment).length,
    fraudSkipped: result.fraudMessageIds,
    notes: result.notes,
  }
}

async function confirmAppRequests(sendFailures) {
  const pending = runSyncScript('--pending-app-confirmations')
  if (LIST_ONLY || DRY_RUN) {
    console.log(JSON.stringify({ pendingAppConfirmations: pending.map((p) => ({ ...p, chat: CHATS[onDutyChat(p.createdAt)] })) }, null, 2))
    return 0
  }
  const confirmed = []
  for (const item of pending) {
    try {
      await sendWhatsApp(onDutyChat(item.createdAt), confirmationText(item))
      confirmed.push(item.id)
    } catch (err) {
      sendFailures.push(`${item.refNumber}: ${err.message}`)
    }
  }
  if (confirmed.length) runSyncScript('--mark-confirmed', ...confirmed)
  return confirmed.length
}

async function main() {
  const sendFailures = []
  const whatsapp = await syncWhatsAppRequests(readState(), sendFailures)
  const appConfirmed = await confirmAppRequests(sendFailures)
  if (LIST_ONLY || DRY_RUN) return
  const quiet = whatsapp?.scanned === 0 && appConfirmed === 0 && sendFailures.length === 0
  if (!quiet) console.log('[dispatch] ' + JSON.stringify({ ...whatsapp, appConfirmed, sendFailures }))
  if (sendFailures.length) process.exitCode = 2
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[dispatch] ' + (err.stack || String(err)))
    process.exit(1)
  })
}
