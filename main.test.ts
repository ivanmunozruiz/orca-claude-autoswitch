import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { decide } from './decide.mjs'
import * as worker from './main.mjs'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

// Synthetic `orca account list --json` result: the system login and one managed account.
// `activeExtra`/`otherExtra` are Orca's `extraUsage`; left out, the account has none (Orca sends null).
const extra = (spent, spendLimit = 750, enabled = true) => ({ unit: 'currency', currencyCode: 'EUR', enabled, spent, spendLimit })

function listResult({ active = 'system', activeUsed = 50, activeWeekly = 10, otherUsed = 20, otherStatus = 'ok', sessionResetsAt = NOW + HOUR, provenance, activeExtra = null, otherExtra = null } = {}) {
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
        extraUsage: activeExtra,
      },
      inactiveClaudeAccounts: [
        {
          accountId: otherId,
          rateLimits: {
            status: otherStatus,
            session: { usedPercent: otherUsed, resetsAt: NOW + 2 * HOUR },
            weekly: { usedPercent: 5, resetsAt: NOW + 72 * HOUR },
            extraUsage: otherExtra,
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
  assert.deepEqual(d.to, { id: 'acct-b', label: 'Org B', used: 20, extra: null })
})

test('the weekly window counts too', () => {
  assert.equal(decide(listResult({ activeUsed: 10, activeWeekly: 95 }), opts).action, 'switch')
})

test('the parked system login is selected as `system`', () => {
  const d = decide(listResult({ active: 'acct-b', activeUsed: 95 }), opts)
  assert.equal(d.active.label, 'Org B')
  assert.equal(d.to.id, 'system')
  assert.equal(d.to.label, 'System default')
  assert.equal(decide(listResult({ active: 'acct-b', activeUsed: 95 }), { ...opts, systemLabel: 'Org A' }).to.label, 'Org A')
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

test('extra usage is read only when the account has it on', () => {
  assert.deepEqual(decide(listResult({ activeExtra: extra(228) }), opts).active.extra, { spent: 228, limit: 750, currency: 'EUR' })
  assert.equal(decide(listResult({ activeExtra: null }), opts).active.extra, null)
  assert.equal(decide(listResult({ activeExtra: extra(0, 750, false) }), opts).active.extra, null)
  assert.equal(decide(listResult({ activeExtra: extra(228, null) }), opts).active.extra.limit, null)
  assert.deepEqual(decide(listResult({ otherExtra: extra(10, 2500) }), opts).others[0].extra, { spent: 10, limit: 2500, currency: 'EUR' })
})

// `list` is a result, or a function giving the result of each successive check.
async function mount(list, { now = () => NOW } = {}) {
  const selected = []
  worker.io.listAccounts = async () => (typeof list === 'function' ? list() : list)
  worker.io.selectAccount = async (id) => {
    selected.push(id)
  }
  worker.io.now = now
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
  assert.match(host.callsOf('notifications.show')[0].body, /no extra usage, so Claude stops at the limit/)
  await w.deactivate()
})

test('with extra usage, the warning says how much is spent', async () => {
  const { w, host } = await mount(listResult({ activeUsed: 95, otherUsed: 96, activeExtra: extra(228) }))
  await w.command('check')
  assert.match(host.callsOf('notifications.show')[0].body, /spends extra usage: €228 of €750 spent so far this month/)
  await w.deactivate()
})

test('a rise in extra usage is told once per episode, on any account', async () => {
  let clock = NOW
  const spent = [100, 100, 105, 110, 110, 120]
  let i = 0
  const { w, host } = await mount(() => listResult({ otherExtra: extra(spent[i++], 2500) }), { now: () => clock })
  const told = () => host.callsOf('notifications.show').map((n) => n.title)
  await w.command('check') // baseline
  await w.command('check') // no change
  assert.deepEqual(told(), [])
  clock += 60_000
  await w.command('check') // 100 → 105
  assert.deepEqual(told(), ['Org B is spending extra usage'])
  assert.match(host.callsOf('notifications.show')[0].body, /€105 of €2,500 spent this month/)
  clock += 60_000
  await w.command('check') // still rising: same episode
  clock += 31 * 60_000
  await w.command('check') // quiet for 31 minutes
  clock += 60_000
  await w.command('check') // rising again: a new episode
  assert.equal(told().length, 2)
  await w.deactivate()
})

test('accounts without extra usage never get a spending notice', async () => {
  const { w, host } = await mount(listResult({ activeUsed: 40, otherExtra: extra(5, 750, false) }))
  await w.command('check')
  await w.command('check')
  assert.equal(host.callsOf('notifications.show').length, 0)
  await w.deactivate()
})
