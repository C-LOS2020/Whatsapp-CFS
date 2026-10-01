// Runs worker.mjs every minute inside the Railway container.
// Stays idle (never exits) until DISPATCH_ENABLED=true and the credentials are
// set, so the rest of the container keeps running either way.
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const INTERVAL_MS = Number(process.env.DISPATCH_INTERVAL_SECONDS || 60) * 1000
const ALERT_AFTER_FAILURES = 5
const ALERT_EVERY_MS = 3 * 3600 * 1000
const ALERT_TO = (process.env.DISPATCH_ALERT_WHATSAPP || '12424279333').trim()
const REQUIRED = ['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'SYNC_BOT_EMAIL', 'SYNC_BOT_PASSWORD', 'ANTHROPIC_API_KEY']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function config() {
  const enabled = String(process.env.DISPATCH_ENABLED || '').trim().toLowerCase() === 'true'
  const missing = REQUIRED.filter((k) => !String(process.env[k] || '').trim())
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
        if (failures >= ALERT_AFTER_FAILURES && Date.now() - lastAlert > ALERT_EVERY_MS) {
          lastAlert = Date.now()
          await alert(`⚠️ PPB dispatch sync (cloud) has failed ${failures} times in a row. Latest error: ${res.error.slice(0, 400)}\nCheck Railway → spectacular-contentment → Whatsapp-CFS → Deploy Logs.`)
        }
      }
    }
    await sleep(INTERVAL_MS)
  }
}

main()
