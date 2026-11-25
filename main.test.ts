import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { decide } from './decide.mjs'
import * as worker from './main.mjs'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

// Synthetic `orca account list --json` result: the system login and one managed account.
function listResult({ active = 'system', activeUsed = 50, activeWeekly = 10, otherUsed = 20, otherStatus = 'ok', sessionResetsAt = NOW + HOUR, provenance } = {}) {
  const otherId = active === 'system' ? 'acct-b' : 'claude-system-default'
  return {
    claude: {
      accounts: [{ id: 'acct-b', organizationName: 'Org B', email: 'someone@example.com' }],
      activeAccountId: active === 'system' ? null : active,
      activeAccountIdsByRuntime: { host: active === 'system' ? null : active, wsl: {} },
    },
    rateLimits: {
      claude: {
        status: 'ok',
        session: { usedPercent: activeUsed, resetsAt: sessionResetsAt },
        weekly: { usedPercent: activeWeekly, resetsAt: NOW + 48 * HOUR },
        usageMetadata: { authProvenance: provenance ?? (active === 'system' ? 'system' : `profile:${active}`) },
      },
      inactiveClaudeAccounts: [
        {
          accountId: otherId,
          rateLimits: {
            status: otherStatus,
            session: { usedPercent: otherUsed, resetsAt: NOW + 2 * HOUR },
            weekly: { usedPercent: 5, resetsAt: NOW + 72 * HOUR },
          },
        },
      ],
    },
  }
}

const opts = { threshold: 90, now: NOW }

test('stays while the active account is under the threshold', () => {
  assert.equal(decide(listResult({ activeUsed: 89 }), opts).action, 'stay')
})

test('switches to the other account when the 5-hour window crosses the threshold', () => {
  const d = decide(listResult({ activeUsed: 91 }), opts)
  assert.equal(d.action, 'switch')
  assert.deepEqual(d.to, { id: 'acct-b', label: 'Org B', used: 20 })
})

test('the weekly window counts too', () => {
  assert.equal(decide(listResult({ activeUsed: 10, activeWeekly: 95 }), opts).action, 'switch')
})

test('the parked system login is selected as `system`', () => {
  const d = decide(listResult({ active: 'acct-b', activeUsed: 95 }), opts)
  assert.equal(d.active.label, 'Org B')
  assert.equal(d.to.id, 'system')
})

test('a window past its reset counts as empty', () => {
  assert.equal(decide(listResult({ activeUsed: 99, sessionResetsAt: NOW - 1 }), opts).action, 'stay')
})

test('waits when the reading belongs to another account (just after a switch)', () => {
  assert.equal(decide(listResult({ activeUsed: 99, provenance: 'profile:acct-b' }), opts).action, 'wait')
})

test('never switches to an account without a reading, nor to one over the threshold', () => {
  assert.equal(decide(listResult({ activeUsed: 95, otherStatus: 'error' }), opts).action, 'exhausted')
  assert.equal(decide(listResult({ activeUsed: 95, otherUsed: 92 }), opts).action, 'exhausted')
})

async function mount(list) {
  const selected = []
  worker.io.listAccounts = async () => list
  worker.io.selectAccount = async (id) => {
    selected.push(id)
  }
  worker.io.now = () => NOW
  const host = mockHost({ capabilities: ['notifications:show', 'settings:own'], settings: { threshold: 90 } })
  const w = await mountWorker(worker, { host, commands: ['check'] })
  return { w, host, selected }
}

test('the worker switches once, notifies, and does not bounce while the reading catches up', async () => {
  const { w, host, selected } = await mount(listResult({ activeUsed: 95 }))
  await w.command('check')
  await w.command('check')
  assert.deepEqual(selected, ['acct-b'])
  assert.equal(host.callsOf('notifications.show').length, 1)
  assert.ok(host.callsOf('statusBar.update').some((fields) => fields.text === 'Org B 20%'))
  assert.deepEqual(w.refusals, [])
  await w.deactivate()
})

test('the worker leaves the account alone under the threshold', async () => {
  const { w, host, selected } = await mount(listResult({ activeUsed: 40 }))
  const reply = await w.command('check')
  assert.deepEqual(selected, [])
  assert.equal(host.callsOf('notifications.show').length, 0)
  assert.match(String(reply), /40% \(switches at 90%\)/)
  await w.deactivate()
})

test('the worker warns once when every account is near its limit', async () => {
  const { w, host, selected } = await mount(listResult({ activeUsed: 95, otherUsed: 96 }))
  await w.command('check')
  await w.command('check')
  assert.deepEqual(selected, [])
  assert.equal(host.callsOf('notifications.show').length, 1)
  await w.deactivate()
})
