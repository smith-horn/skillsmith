/**
 * Home-dir relocation test seam for `sklx agent install` (SMI-5456 Wave 1
 * Step 5).
 *
 * `paths.ts`'s `CLIENT_NATIVE_PATHS` and `agent-harness-targets.ts`'s target
 * tables are computed ONCE at module load via `os.homedir()` — the
 * established pattern in this codebase (paths.ts has no `homeDir` override;
 * `enumerateHarnessPresence()` takes none either). Rather than widen that
 * shared contract (used across many consumers) or fight macOS's
 * `os.homedir()` ignoring `process.env.HOME` mutations (the exact problem
 * `journal/path.ts` and `telemetry/agent-marker.ts` solve with their own
 * per-module env overrides), the installer re-roots any already-computed
 * absolute path onto an alternate directory for tests: strip the real
 * `os.homedir()` prefix and re-join under the test's temp `homeDir`. This
 * keeps every existing static table intact and untouched while giving
 * `installAgentPack({ homeDir })` a real, disk-backed temp-HOME test seam
 * (P-5 "install to a temp HOME" requirement) without adding a second
 * parallel path-computation system to maintain in sync with `paths.ts`.
 *
 * @module @skillsmith/core/install/agent-home-relocate
 */

import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

/**
 * Re-root `absolutePath` (assumed computed under the REAL `os.homedir()`)
 * onto `homeDir`. Returns `absolutePath` unchanged when `homeDir` is
 * undefined, or when `absolutePath` is not actually under the real home
 * directory (defensive — never silently misroute an unrelated path).
 */
export function relocateUnderHome(absolutePath: string, homeDir?: string): string {
  if (!homeDir) return absolutePath
  const rel = relative(homedir(), absolutePath)
  if (rel.startsWith('..') || isAbsolute(rel)) return absolutePath
  return join(homeDir, rel)
}
