// SMI-6676 C5: the hybrid dispatcher (§4.5). Uses VR-V2 (native, through
// C1) when a cached child-process probe confirms the platform's prebuild
// loads and self-tests clean on this process; otherwise falls back to C4
// (quarantine) -- never to the C0 path-based walk, per the owner's decision
// (§10, "Hybrid C5b is withdrawn").
//
// The probe MUST run in a child process, never in-process: checkpoint 3
// measured a genuinely tampered signed macOS binary SIGKILL the process
// that `require()`'d it, with zero catchable output. An in-process
// `require()`-then-catch here would take the caller down with it. The
// probe's own cost was measured at ~22.5ms median (child spawn included) --
// well inside the plan's own ≤100ms bar (§10 criterion 4) -- and is cached
// per process, per §4.5's "run once per process per filesystem" (this spike
// caches once per process; per-filesystem caching is a real caller's job,
// since a spike removeTree() call doesn't span multiple target filesystems
// in one process the way a long-lived service might).

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { removeVR } from './walk.mjs'
import { quarantineTree } from './quarantine.mjs'

const PROBE_CHILD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'native-c',
  'probe-child.mjs'
)

let cachedProbe = null

function runProbe() {
  if (cachedProbe) return cachedProbe
  const r = spawnSync(process.execPath, [PROBE_CHILD_PATH], { encoding: 'utf8', timeout: 10000 })
  if (r.signal) {
    cachedProbe = { ok: false, trigger: 'native-probe-killed', detail: `signal ${r.signal}` }
  } else if (r.status !== 0) {
    cachedProbe = {
      ok: false,
      trigger: 'native-probe-crashed',
      detail: (r.stderr || '').slice(0, 300),
    }
  } else {
    try {
      const lastLine = r.stdout.trim().split('\n').pop()
      cachedProbe = JSON.parse(lastLine)
    } catch {
      cachedProbe = {
        ok: false,
        trigger: 'native-probe-unparseable',
        detail: (r.stdout || '').slice(0, 300),
      }
    }
  }
  return cachedProbe
}

/** Test-only: forces the next removeTree() call to re-probe. */
export function resetProbeCache() {
  cachedProbe = null
}

function quarantineFallback(targetRoot, options, trigger) {
  const parent = path.dirname(targetRoot)
  const name = path.basename(targetRoot)
  // One stderr line per process, naming the trigger and the prune command
  // (§4.5's "Message" requirement) -- no telemetry, this is a spike.
  process.stderr.write(
    `[skillsmith] native tree removal unavailable (${trigger}); quarantining instead. ` +
      `Run \`skillsmith doctor backups --prune --apply\` to reclaim space.\n`
  )
  const result = quarantineTree(parent, name, options)
  return { ...result, fallbackTrigger: trigger }
}

/**
 * @param {string} targetRoot
 * @param {object} [options] - passed through to removeVR or quarantineTree
 * @returns {object} - removeVR's result shape (native) or quarantineTree's
 *   result shape plus `fallbackTrigger` (fallback)
 */
export function removeTree(targetRoot, options = {}) {
  if (process.env.SKILLSMITH_REMOVAL_NATIVE_DISABLE === '1') {
    return quarantineFallback(targetRoot, options, 'env-disable')
  }
  const probe = runProbe()
  if (!probe.ok) {
    return quarantineFallback(targetRoot, options, probe.trigger)
  }
  return removeVR(targetRoot, { variant: 'V2', ...options })
}
