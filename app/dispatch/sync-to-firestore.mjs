// Pushes structured dispatch requests (already extracted from WhatsApp messages)
// into the PropanePLUS Dispatch App's Firestore.
//
// Authenticates as a Google service account (no firebase-admin dependency): it
// signs a short-lived JWT with node:crypto, swaps it for an OAuth access token,
// and writes through the plain Firestore REST API. Service-account access is
// governed by IAM (the account needs the "Cloud Datastore User" role), not by
// firebase/firestore.rules.
//
// Usage:
//   node sync-to-firestore.mjs <path-to-items.json>
//   node sync-to-firestore.mjs --pending-app-confirmations
//   node sync-to-firestore.mjs --mark-confirmed <docId> [docId...]
// Credentials come from environment variables (Railway Variables) or, if
// present, a .env file next to this script:
//   FIREBASE_SERVICE_ACCOUNT  the service-account key JSON, pasted as-is or base64-encoded
//   FIREBASE_PROJECT_ID       optional; defaults to the key's project_id
//
// Input file: a JSON array of items shaped like:
// {
//   "customerName": "Mr Edgecombe",
//   "customerContact": "802-8927",
//   "fuelType": "LPG",
//   "fuelQuantity": "20lb",
//   "chargePayment": "Not specified",
//   "dateRequested": "ASAP",
//   "deliveryLocation": "WSC on Thompson Blvd",
//   "directions": "Not specified",
//   "sourceMessage": {
//     "messageId": "<whatsapp message id, for dedupe>",
//     "text": "20lb new tank with gas...",
//     "sender": "Philip Corey Taylor",
//     "chat": "PPB DISPATCH SALES",
//     "timestamp": "2026-09-10T07:24:07-04:00",
//     "hasAttachment": false
//   }
// }

import { readFileSync, existsSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function loadEnv() {
  const env = {}
  const path = join(SCRIPT_DIR, '.env')
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
  }
  for (const k of ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_PROJECT_ID']) {
    if (process.env[k]) env[k] = process.env[k].trim()
  }
  return env
}

// Accepts the key file's JSON as-is, or base64 of it (handy if a host mangles newlines).
export function parseServiceAccount(raw) {
  if (!raw) return null
  let text = raw.trim()
  if (!text.startsWith('{')) text = Buffer.from(text, 'base64').toString('utf8')
  const sa = JSON.parse(text)
  if (!sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT is missing client_email or private_key')
  sa.private_key = sa.private_key.replace(/\\n/g, '\n')
  return sa
}

const env = loadEnv()
let SERVICE_ACCOUNT
try {
  SERVICE_ACCOUNT = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT)
} catch (err) {
  console.error('FIREBASE_SERVICE_ACCOUNT is not valid service-account JSON:', err.message)
  process.exit(1)
}
const FIREBASE_PROJECT_ID = env.FIREBASE_PROJECT_ID || SERVICE_ACCOUNT?.project_id
if (!SERVICE_ACCOUNT || !FIREBASE_PROJECT_ID) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT (and FIREBASE_PROJECT_ID could not be determined)')
  process.exit(1)
}

const mode = process.argv[2]
if (!mode) {
  console.error('Usage: node sync-to-firestore.mjs <path-to-items.json> | --pending-app-confirmations | --mark-confirmed <docId...>')
  process.exit(1)
}

function generateRefNumber(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const suffix = Math.random().toString(16).slice(2, 8).toUpperCase()
  return `DRF-${y}${m}${d}-${suffix}`
}

// Converts a plain JS value into Firestore REST API's typed field format.
function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (typeof value === 'number') return { doubleValue: value }
  if (typeof value === 'string') return { stringValue: value }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } }
  if (typeof value === 'object') {
    const fields = {}
    for (const [k, v] of Object.entries(value)) fields[k] = toFirestoreValue(v)
    return { mapValue: { fields } }
  }
  throw new Error(`Cannot convert value to Firestore field: ${value}`)
}

function toFirestoreFields(obj) {
  const fields = {}
  for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v)
  return fields
}

// Reverses toFirestoreValue — turns a Firestore REST API typed field back into a plain JS value.
function fromFirestoreValue(v) {
  if ('nullValue' in v) return null
  if ('booleanValue' in v) return v.booleanValue
  if ('doubleValue' in v) return v.doubleValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('stringValue' in v) return v.stringValue
  if ('timestampValue' in v) return v.timestampValue
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(fromFirestoreValue)
  if ('mapValue' in v) return fromFirestoreFields(v.mapValue.fields ?? {})
  return null
}

function fromFirestoreFields(fields) {
  const obj = {}
  for (const [k, v] of Object.entries(fields)) obj[k] = fromFirestoreValue(v)
  return obj
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

// Exchanges a self-signed JWT for a one-hour OAuth access token scoped to Firestore.
async function signIn() {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: SERVICE_ACCOUNT.private_key_id }))
  const claims = b64url(JSON.stringify({
    iss: SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  const assertion = `${header}.${claims}.${b64url(signer.sign(SERVICE_ACCOUNT.private_key))}`

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!resp.ok) throw new Error(`Service-account token request failed: ${resp.status} ${await resp.text()}`)
  const data = await resp.json()
  return data.access_token
}

async function docExists(idToken, docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/dispatchRequests/${docId}`
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } })
  return resp.status === 200
}

async function createDoc(idToken, docId, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/dispatchRequests/${docId}`
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields }),
  })
  if (!resp.ok) throw new Error(`Write failed: ${resp.status} ${await resp.text()}`)
  return resp.json()
}

async function getFullDoc(idToken, docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/dispatchRequests/${docId}`
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } })
  if (!resp.ok) throw new Error(`Get failed: ${resp.status} ${await resp.text()}`)
  return resp.json()
}

// App-created requests (sourceMessage explicitly null) that haven't had their
// WhatsApp confirmation posted yet.
async function queryPendingAppConfirmations(idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'dispatchRequests' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'sourceMessage' }, op: 'EQUAL', value: { nullValue: null } } },
            { fieldFilter: { field: { fieldPath: 'waConfirmationSent' }, op: 'EQUAL', value: { booleanValue: false } } },
          ],
        },
      },
    },
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`Query failed: ${resp.status} ${await resp.text()}`)
  const rows = await resp.json()
  return rows
    .filter((r) => r.document)
    .map((r) => {
      const fields = fromFirestoreFields(r.document.fields ?? {})
      return {
        id: r.document.name.split('/').pop(),
        refNumber: fields.refNumber,
        customerName: fields.customerName,
        fuelType: fields.fuelType,
        fuelQuantity: fields.fuelQuantity,
        deliveryLocation: fields.deliveryLocation,
        createdAt: fields.createdAt,
      }
    })
}

// Re-sends the FULL document with waConfirmationSent flipped to true, rather than a
// partial updateMask PATCH — a prior updateMask PATCH on this project silently
// dropped fields that weren't listed in the mask, so full-document rewrite is the
// proven-safe way to change one field here.
async function markConfirmed(idToken, docId) {
  const existing = await getFullDoc(idToken, docId)
  const fields = fromFirestoreFields(existing.fields ?? {})
  fields.waConfirmationSent = true
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/dispatchRequests/${docId}`
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields: toFirestoreFields(fields) }),
  })
  if (!resp.ok) throw new Error(`Mark-confirmed failed: ${resp.status} ${await resp.text()}`)
}

async function run() {
  const idToken = await signIn()

  if (mode === '--pending-app-confirmations') {
    const items = await queryPendingAppConfirmations(idToken)
    console.log(JSON.stringify(items))
    return
  }

  if (mode === '--mark-confirmed') {
    const ids = process.argv.slice(3)
    if (ids.length === 0) {
      console.error('Usage: node sync-to-firestore.mjs --mark-confirmed <docId> [docId...]')
      process.exit(1)
    }
    for (const id of ids) await markConfirmed(idToken, id)
    console.log(JSON.stringify({ confirmed: ids.length }))
    return
  }

  const inputPath = mode
  const items = JSON.parse(readFileSync(inputPath, 'utf8'))

  let created = 0
  let skipped = 0
  const createdItems = []

  for (const item of items) {
    const messageId = item.sourceMessage?.messageId
    if (!messageId) {
      console.error('Skipping item with no sourceMessage.messageId (required for dedupe):', item.customerName)
      skipped++
      continue
    }
    const docId = `wa-${messageId}`

    if (await docExists(idToken, docId)) {
      skipped++
      continue
    }

    const refNumber = generateRefNumber()
    const now = new Date().toISOString()
    const doc = {
      refNumber,
      status: 'new',
      customerName: item.customerName ?? '',
      customerContact: item.customerContact ?? '',
      fuelType: item.fuelType ?? '',
      fuelQuantity: item.fuelQuantity ?? '',
      chargePayment: item.chargePayment ?? 'Not specified',
      dateRequested: item.dateRequested ?? 'Not specified',
      deliveryLocation: item.deliveryLocation ?? '',
      directions: item.directions ?? 'Not specified',
      sourceMessage: item.sourceMessage ?? null,
      reviewChecklist: { productAvailability: false, routePlanned: false, priceConfirmed: false },
      driverAssigned: '',
      dispatchSignOff: { name: '', timestamp: null },
      driverSignOff: { name: '', timestamp: null },
      createdBy: 'whatsapp-sync',
      createdAt: now,
      updatedAt: now,
    }

    await createDoc(idToken, docId, toFirestoreFields(doc))
    created++
    createdItems.push({
      refNumber,
      chat: item.sourceMessage?.chat ?? null,
      customerName: doc.customerName,
      fuelType: doc.fuelType,
      fuelQuantity: doc.fuelQuantity,
      deliveryLocation: doc.deliveryLocation,
    })
  }

  console.log(JSON.stringify({ created, skipped, createdItems }))
}

run().catch((err) => {
  console.error('Sync failed:', err)
  process.exit(1)
})
