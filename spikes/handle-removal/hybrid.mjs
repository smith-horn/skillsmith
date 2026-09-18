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
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { removeVR } from './walk.mjs'
import { quarantineTree } from './quarantine.mjs'
import { shapeResult } from './result-shape.mjs'
import { prebuildPath } from './native-c/load-packaged.mjs'
import { shimPath } from './native-c/load.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE_CHILD_PATH = path.join(HERE, 'native-c', 'probe-child.mjs')

// The binary the native walk will ACTUALLY load. It is not the one the probe
// checks: probe-child.mjs goes through load-packaged.mjs (`prebuilds/`), while
// walk.mjs goes through load.mjs. In a shipped package there would be one
// loader and one binary; in this spike there are two, so the cache key below
// covers BOTH -- a probe verdict about one file must not survive a change to
// the other.
//
// ASK THE LOADER, never recompute its path. This was a hardcoded
// `build/Release/shim.node`, which was correct for exactly 42 minutes: adding
// SMI6676_SHIM_PATH to load.mjs meant walk.mjs could load a different file
// while this key and gate still described the old one. Under the override --
// the sanctioned way to run this spike on Linux, and the way its own scored A13
// arm ran -- the binary actually loaded could be replaced byte-for-byte without
// moving the key, leaving open the exact invisible-success defect this cache
// key exists to close. Each commit was correct alone; the pair was not. Deriving
// the path from `shimPath()` makes that class unrepresentable rather than
// merely fixed.
const devBuildPath = () => shimPath()

/**
 * Identity of a binary, for cache keying. sha256 rather than size+mtime,
 * because a package update can restore a timestamp (this repo has already seen
 * a tar extraction land an `Oct 26 1985` mtime) and a same-size replacement is
 * exactly the case a version key has to catch. Hashing 50-70 KB costs well
 * under a millisecond against the probe's own ~22.5 ms, so the cheap-but-wrong
 * fingerprint buys nothing.
 *
 * A file that cannot be read returns a marker rather than throwing: "absent" is
 * a legitimate and important key, since it must invalidate a cached `ok` from
 * when the file was present.
 */
function binaryIdentity(p) {
  try {
    return createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  } catch (err) {
    return `unreadable:${err.code ?? 'ERR'}`
  }
}

function probeCacheKey() {
  return `${binaryIdentity(prebuildPath())}|${binaryIdentity(devBuildPath())}`
}

let cachedProbe = null
let cachedProbeKey = null

function runProbe() {
  // §10 criterion 4 asks for "a cached child probe [that] costs <= 100 ms ONCE
  // PER BINARY VERSION". The previous cache was `let cachedProbe = null`, keyed
  // on nothing at all -- a per-process memo. Harmless here, where nothing
  // replaces a prebuild mid-process, but in a long-lived process surviving a
  // package update it would reuse a verdict about a binary no longer on disk:
  // the invisible-success shape this spike keeps finding, in the code meant to
  // prevent it.
  const key = probeCacheKey()
  if (cachedProbe && cachedProbeKey === key) return cachedProbe
  cachedProbeKey = key

  // Reading the dev build to key on it also proves it exists and is readable,
  // so the native path cannot be entered for a binary that is simply missing.
  // It does NOT prove a readable-but-corrupt binary will load: that still
  // throws inside require(), and the probe cannot check it in-process without
  // risking the SIGKILL this whole design exists to avoid.
  // Only the DEV-build half is checked here. An unreadable PREBUILD is a
  // different, already-covered case: it is one of criterion 4's six real
  // triggers, and the child probe reports it properly, so it must reach the
  // probe rather than being short-circuited here. The key's two halves are
  // separated by `|` and a sha256 is hex, so `|unreadable:` can only ever match
  // the second half.
  if (cachedProbeKey.includes('|unreadable:')) {
    cachedProbe = {
      ok: false,
      trigger: 'native-dev-build-unreadable',
      // The path is named because under SMI6676_SHIM_PATH there may be no "dev
      // build" involved at all -- the unreadable file is whatever the override
      // points at. The trigger string is kept stable for the existing
      // assertions; the detail is what tells you which file actually failed.
      detail: `cannot read ${devBuildPath()} (the binary walk.mjs would load)`,
    }
    return cachedProbe
  }

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
  cachedProbeKey = null
}

/** Test-only: the current cache key, so a test can assert it CHANGED. */
export function probeCacheKeyForTest() {
  return probeCacheKey()
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
  return shapeResult({ ...result, fallbackTrigger: trigger })
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
  // R5-10: `removeTree`'s two outcomes carry the SAME key set, with
  // `fallbackTrigger` null on the native branch rather than absent -- absent is
  // what a caller cannot distinguish from "this path forgot to set it".
  //
  // M-4: THE ACTUAL FIX WAS ADDING `fallbackTrigger` TO `RESULT_FIELDS`, not
  // these `shapeResult` wrappers. Measured: `removeVR` and `quarantineTree`
  // already shape their own returns, so wrapping them again is byte-identical
  // in key order and content, and removing either wrapper leaves every suite
  // green. The commit message credited the wrappers with the fix; they are
  // defence-in-depth against a future return path that forgets to shape itself,
  // which is worth keeping and is not what closed the divergence.
  return shapeResult(removeVR(targetRoot, { variant: 'V2', ...options }))
}
