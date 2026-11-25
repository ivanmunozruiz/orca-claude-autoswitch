import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { decide } from './decide.mjs'

const POLL_MS = 60_000
// After a switch Orca needs a moment to read the new account; never switch twice in a row.
const COOLDOWN_MS = 10 * 60_000
const STATUS_ID = 'usage'

// The Orca CLI that ships with the running app (macOS), then the usual install spots, then PATH.
function orcaBin() {
  const candidates = [
    join(dirname(process.execPath), '..', 'Resources', 'bin', 'orca'),
    '/usr/local/bin/orca',
    join(homedir(), '.local', 'bin', 'orca'),
  ]
  return candidates.find((path) => existsSync(path)) ?? 'orca'
}

function runOrca(args) {
  return new Promise((resolve, reject) => {
    execFile(orcaBin(), [...args, '--json'], { timeout: 20_000 }, (error, stdout) => {
      let reply = null
      try {
        reply = JSON.parse(stdout)
      } catch {
        // fall through: report the process error, or the unreadable output
      }
      if (reply?.ok) return resolve(reply.result)
      reject(new Error(reply?.error?.message ?? error?.message ?? 'unreadable reply from the orca CLI'))
    })
  })
}

// The only two things the plugin does to Orca. Tests replace them so they never reach the real CLI.
export const io = {
  listAccounts: () => runOrca(['account', 'list']),
  selectAccount: (id) => runOrca(['account', 'select', '--agent', 'claude', '--account', id]),
  now: () => Date.now(),
}

let timer = null

export default function activate(orca) {
  let inflight = null
  let lastSwitchAt = -Infinity
  let warnedExhausted = false

  const notify = (title, body) => orca.host.call('notifications.show', { title, body })
  const status = (fields) => orca.host.call('statusBar.update', { id: STATUS_ID, ...fields })

  async function run() {
    const threshold = Number(await orca.settings.get('threshold')) || 90
    const now = io.now()
    let d
    try {
      d = decide(await io.listAccounts(), { threshold, now })
    } catch (error) {
      orca.log(`could not read Orca accounts: ${error.message}`)
      await status({ text: 'Claude ?', tone: 'danger', tooltip: `Claude Auto-switch could not read Orca's accounts: ${error.message}` })
      return `Could not read Orca's accounts: ${error.message}`
    }

    if (d.action === 'switch' && now - lastSwitchAt >= COOLDOWN_MS) {
      try {
        await io.selectAccount(d.to.id)
      } catch (error) {
        orca.log(`could not switch to ${d.to.label}: ${error.message}`)
        await notify('Claude Auto-switch could not switch', `${d.to.label}: ${error.message}`)
        return `Could not switch to ${d.to.label}: ${error.message}`
      }
      lastSwitchAt = now
      warnedExhausted = false
      const message = `${d.active.label} reached ${d.active.used}% (threshold ${threshold}%). ${d.to.label} is at ${d.to.used}%.`
      await notify(`Claude switched to ${d.to.label}`, message)
      await status({ text: `${d.to.label} ${d.to.used}%`, tone: 'neutral', tooltip: tooltip(d, d.to.id) })
      return `Switched to ${d.to.label}. ${message}`
    }

    if (d.action === 'exhausted' && !warnedExhausted) {
      warnedExhausted = true
      await notify('Every Claude account is near its limit', `${d.active.label} is at ${d.active.used}% and no other account in Orca is under ${threshold}%.`)
    }
    if (d.action === 'stay') warnedExhausted = false

    await status(statusFields(d))
    return summary(d)
  }

  // A press on the status bar while the poll runs shares that run instead of starting another.
  function check() {
    inflight ??= run().finally(() => {
      inflight = null
    })
    return inflight
  }

  orca.commands.register('check', () => check())
  clearInterval(timer)
  timer = setInterval(() => void check(), POLL_MS)
  void check()
}

export function deactivate() {
  clearInterval(timer)
  timer = null
}

function percent(used) {
  return used === null ? 'no reading' : `${used}%`
}

function tooltip(d, activeId = d.active.id) {
  const rows = [d.active, ...d.others].map((a) => `${a.label}: ${percent(a.used)}${a.id === activeId ? ' (active)' : ''}`)
  return [`Switches at ${d.threshold}% of the 5-hour or weekly window.`, ...rows].join('\n')
}

function statusFields(d) {
  if (d.action === 'wait') return { text: `${d.active.label} …`, tone: 'neutral', tooltip: `Waiting for Orca to read ${d.active.label}.\n${tooltip(d)}` }
  const tone = d.active.used >= d.threshold ? 'danger' : d.active.used >= d.threshold - 15 ? 'warning' : 'neutral'
  return { text: `${d.active.label} ${d.active.used}%`, tone, tooltip: tooltip(d) }
}

function summary(d) {
  if (d.action === 'wait') return `Waiting for Orca to read ${d.active.label}.`
  if (d.action === 'exhausted') return `${d.active.label} is at ${d.active.used}% and no other account is under ${d.threshold}%.`
  if (d.action === 'switch') return `${d.active.label} is at ${d.active.used}%; a switch was made less than 10 minutes ago, so it waits.`
  return `${d.active.label} is at ${d.active.used}% (switches at ${d.threshold}%).`
}
