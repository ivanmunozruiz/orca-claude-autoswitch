// Pure decision logic over `orca account list --json`: no I/O, so tests feed it synthetic results.

// Orca lists the parked system login under this id, but `orca account select` takes `system`.
const SYSTEM_INACTIVE_ID = 'claude-system-default'
const WINDOWS = ['session', 'weekly']

// Highest share used across the 5-hour and weekly windows, or null without a usable reading.
// A window past its reset counts as empty: a parked account's reading can be hours old.
export function peakPercent(limits, now) {
  if (!limits || limits.status !== 'ok') return null
  let peak = null
  for (const name of WINDOWS) {
    const window = limits[name]
    if (!window || typeof window.usedPercent !== 'number') continue
    const used = typeof window.resetsAt === 'number' && window.resetsAt <= now ? 0 : window.usedPercent
    peak = Math.max(peak ?? 0, used)
  }
  return peak
}

export function activeAccountId(claude) {
  return claude?.activeAccountIdsByRuntime?.host ?? claude?.activeAccountId ?? 'system'
}

function labelOf(claude, id) {
  if (id === 'system') return 'System default'
  const account = claude?.accounts?.find((a) => a.id === id)
  return account?.displayName || account?.organizationName || account?.email || id
}

function isWsl(claude, id) {
  return claude?.accounts?.find((a) => a.id === id)?.managedAuthRuntime === 'wsl'
}

// action: 'stay' (under the threshold), 'switch' (to `to`), 'exhausted' (no other account has
// room) or 'wait' (Orca has no reading of the active account yet).
export function decide(result, { threshold, now }) {
  const claude = result?.claude
  const limits = result?.rateLimits
  const activeId = activeAccountId(claude)
  const reading = limits?.claude
  // Right after a switch Orca can still hold the previous account's reading: only trust one it
  // took with the active account's credentials, or the plugin would bounce straight back.
  const expected = activeId === 'system' ? 'system' : `profile:${activeId}`
  const activeUsed = reading?.usageMetadata?.authProvenance === expected ? peakPercent(reading, now) : null

  const others = (limits?.inactiveClaudeAccounts ?? [])
    .map((entry) => (entry.accountId === SYSTEM_INACTIVE_ID ? { ...entry, accountId: 'system' } : entry))
    .filter((entry) => entry.accountId !== activeId && !isWsl(claude, entry.accountId))
    .map((entry) => ({
      id: entry.accountId,
      label: labelOf(claude, entry.accountId),
      used: peakPercent(entry.rateLimits, now),
    }))

  const base = { threshold, active: { id: activeId, label: labelOf(claude, activeId), used: activeUsed }, others }
  if (activeUsed === null) return { ...base, action: 'wait' }
  if (activeUsed < threshold) return { ...base, action: 'stay' }
  const to = others
    .filter((o) => o.used !== null && o.used < threshold)
    .sort((a, b) => a.used - b.used)[0]
  return to ? { ...base, action: 'switch', to } : { ...base, action: 'exhausted' }
}
