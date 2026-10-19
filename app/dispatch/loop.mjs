// Runs worker.mjs every 15 minutes (DISPATCH_INTERVAL_SECONDS) inside the Railway container.
// Stays idle (never exits) until DISPATCH_ENABLED=true and the credentials are
// set, so the rest of the container keeps running either way.
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const INTERVAL_MS = Number(process.env.DISPATCH_INTERVAL_SECONDS || 900) * 1000
const ALERT_AFTER_FAILURES = 5
const ALERT_EVERY_MS = 3 * 3600 * 1000
const ALERT_TO = (process.env.DISPATCH_ALERT_WHATSAPP || '12424279333').trim()
const MAX_BACKOFF_MS = 30 * 60 * 1000
// Errors that retrying every minute can't fix (billing, bad keys, missing
// database): wait the maximum between attempts.
const PERSISTENT_ERROR = /credit balance|invalid x-api-key|authentication_error|permission_error|PERMISSION_DENIED|does not exist|NOT_FOUND|invalid_grant/i
const REQUIRED = ['ANTHROPIC_API_KEY']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function config() {
  const enabled = String(process.env.DISPATCH_ENABLED || '').trim().toLowerCase() === 'true'
  const has = (k) => !!String(process.env[k] || '').trim()
  const missing = REQUIRED.filter((k) => !has(k))
  // Firebase: a service-account key, or the sync-bot login (all four values).
  const BOT = ['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'SYNC_BOT_EMAIL', 'SYNC_BOT_PASSWORD']
  if (!has('FIREBASE_SERVICE_ACCOUNT') && !BOT.every(has)) missing.push(...BOT.filter((k) => !has(k)))
  return { enabled, missing }
}

function runWorker() {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(DIR, 'worker.mjs')], { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stdout.trim()) process.stdout.write(stdout)
        if (stderr.trim()) process.stderr.write(stderr)
        resolve({ ok: !err, error: err ? (stderr.trim().split('\n').slice(-3).join(' ') || err.message) : '' })
      })
  })
}

async function alert(text) {
  try {
    const { sendWhatsApp } = await import('./worker.mjs')
    await sendWhatsApp(ALERT_TO, text)
  } catch (e) {
    console.error('[dispatch] could not send alert: ' + e.message)
  }
}

async function main() {
  let announced = ''
  let failures = 0
  let lastAlert = 0
  // Give the bridge time to connect after a container start.
  await sleep(30000)
  for (;;) {
    let nextDelay = INTERVAL_MS
    const { enabled, missing } = config()
    const status = !enabled ? 'disabled (set DISPATCH_ENABLED=true to start)' : missing.length ? `waiting for variables: ${missing.join(', ')}` : 'running'
    if (status !== announced) {
      console.log(`[dispatch] ${status}`)
      announced = status
    }
    if (enabled && !missing.length) {
      const res = await runWorker()
      if (res.ok) {
        if (failures >= ALERT_AFTER_FAILURES) await alert('✅ PPB dispatch sync (cloud) is working again.')
        failures = 0
      } else {
        failures++
        // Back off 1, 2, 4, 8... minutes (max 30) so a stuck sync doesn't hammer paid APIs.
        nextDelay = PERSISTENT_ERROR.test(res.error) ? MAX_BACKOFF_MS : Math.min(INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
        console.log(`[dispatch] failed ${failures}x in a row; next attempt in ${Math.round(nextDelay / 60000)} min`)
        if (failures >= ALERT_AFTER_FAILURES && Date.now() - lastAlert > ALERT_EVERY_MS) {
          lastAlert = Date.now()
          await alert(`⚠️ PPB dispatch sync (cloud) has failed ${failures} times in a row. Latest error: ${res.error.slice(0, 400)}\nCheck Railway → spectacular-contentment → Whatsapp-CFS → Deploy Logs.`)
        }
      }
    }
    await sleep(nextDelay)
  }
}

main()
