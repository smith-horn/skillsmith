// Loads the platform's compiled C1 shim. ESM can't `require()` directly, so
// this wraps createRequire -- the one indirection every VR module needs.
//
// `build/Release/shim.node` is a SHARED path holding whichever platform's
// binary was last built on this machine -- in practice the host's, darwin-arm64.
// That made every Linux run of this harness impossible without overwriting it,
// which would silently corrupt any concurrent host run using the same file.
// Ten modules import loadShim(), so one override here unblocks all of them:
// point SMI6676_SHIM_PATH at `prebuilds/linux-arm64/shim.node` inside a
// container and nothing on the host is touched.
//
// Deliberately an absolute path rather than a platform-arch lookup: the caller
// states exactly which binary it means, so a wrong-arch load fails loudly at
// require() instead of silently resolving to something else.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

let cached = null
let cachedFrom = null

/**
 * The file loadShim() will require. Exported so a run can RECORD what it loaded,
 * and so `hybrid.mjs` can key its probe cache on the binary actually loaded.
 *
 * ALWAYS ABSOLUTE, resolved against this directory -- the same base `require()`
 * uses, since the require here is `createRequire(import.meta.url)`. Returning the
 * raw env value was wrong in a way a comment could not fix: two consumers applied
 * two different resolution rules to one string. `binaryIdentity()`'s
 * `fs.readFileSync` resolves a relative path against `process.cwd()`, while
 * `require()` resolves it against this file's directory. Measured with two
 * different real binaries planted at the same relative path under each base: the
 * cache key hashed one, `require()` loaded the other, and replacing the loaded
 * one did not move the key. An earlier version of this file said "deliberately an
 * absolute path" -- a convention with no enforcement, which `hybrid.mjs` then
 * depended on for correctness. Resolving here makes the two agree by
 * construction instead of by everyone remembering.
 */
export function shimPath() {
  const override = process.env.SMI6676_SHIM_PATH
  if (override) return path.resolve(here, override)
  return path.join(here, 'build', 'Release', 'shim.node')
}

export function loadShim() {
  const p = shimPath()
  // Keyed on the path, not a bare boolean: a process that changed the override
  // mid-run would otherwise keep returning the first binary it loaded, which is
  // the same keyed-on-nothing cache defect this spike already found in
  // hybrid.mjs's probe cache.
  if (!cached || cachedFrom !== p) {
    cached = require(p)
    cachedFrom = p
  }
  return cached
}
