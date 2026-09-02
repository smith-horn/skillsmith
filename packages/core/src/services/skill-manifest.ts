/**
 * @fileoverview Manifest manager for skill installation tracking
 * @module @skillsmith/core/services/skill-manifest
 * @see SMI-3483: Extracted from skill-installation.service.ts to meet 500-line standard
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'node:crypto'

import type { SkillManifest } from './skill-installation.types.js'

const MANIFEST_LOCK_TIMEOUT_MS = 30000
const MANIFEST_LOCK_RETRY_MS = 100

/**
 * SMI-6343 Wave 1 — runtime backstop for the test-fixture manifest leak.
 *
 * `vitest.setup.ts` redirects `$HOME`/`%USERPROFILE%` to a per-run temp
 * directory so that homedir-derived manifest paths land in a sandbox. This
 * guard is the defense-in-depth half: if a test ever resolves a manifest path
 * under the developer's REAL home anyway — a hardcoded `/Users/<me>/...`, a
 * captured-before-setup constant, a config that somehow skipped the preset —
 * it fails loudly at the write boundary instead of silently corrupting
 * `~/.skillsmith/manifest.json`.
 *
 * Ground truth for "the real home" is `SKILLSMITH_TEST_REAL_HOME`, captured by
 * `vitest.setup.ts` BEFORE it installs the sandbox. `os.homedir()` is useless
 * here (it returns the sandbox once the override is in place); `os.userInfo()`
 * reads the password-file entry and ignores `$HOME`, so it is the fallback for
 * the case where the env var is missing — which itself means the sandbox never
 * ran, exactly when the guard matters most.
 *
 * Only active under `process.env.VITEST`. Production code paths are untouched.
 *
 * Exported (adversarial-review finding, SMI-6343 follow-up) because
 * `ManifestManager` is not the only homedir-defaulting manifest writer in the
 * repo — `packages/mcp-server/src/tools/install.helpers.manifest.ts`,
 * `packages/cli/src/utils/manifest.ts`, and
 * `packages/core/src/install/fan-out.ts` each have their own raw-`fs`
 * save/lock functions with the identical `os.homedir()`-derived path and no
 * override parameter, so they need the same guard. Reusing this one function
 * (rather than three independent copies) is the CLAUDE.md-documented
 * duplicate-security-gate fix: one gate implementation is far harder to
 * regress than four.
 */
export function realHomeUnderTest(): string | undefined {
  const captured = process.env.SKILLSMITH_TEST_REAL_HOME
  if (captured) return captured
  try {
    return os.userInfo().homedir
  } catch {
    // Some containers have no passwd entry for the effective uid. Without a
    // ground truth there is nothing to compare against — degrade to no guard
    // rather than throwing from a guard.
    return undefined
  }
}

export function assertNotRealUserHome(manifestPath: string, operation: string): void {
  if (!process.env.VITEST) return
  const realHome = realHomeUnderTest()
  if (!realHome) return

  const resolvedHome = path.resolve(realHome)
  const resolvedPath = path.resolve(manifestPath)
  const isUnderRealHome =
    resolvedPath === resolvedHome || resolvedPath.startsWith(resolvedHome + path.sep)
  if (!isUnderRealHome) return

  throw new Error(
    'SMI-6343: refusing to ' +
      operation +
      ' a manifest inside the real user home during a test run.\n' +
      '  Offending path: ' +
      resolvedPath +
      '\n  Real home:      ' +
      resolvedHome +
      '\n' +
      'Tests must never touch ~/.skillsmith/manifest.json. Pass an explicit ' +
      'manifestPath (e.g. from createIsolatedManifestPath() in ' +
      'packages/mcp-server/tests/integration/setup.ts, or any os.tmpdir()-based ' +
      'path) instead of letting it default to os.homedir().'
  )
}

/**
 * Manages the skill manifest file (~/.skillsmith/manifest.json) with
 * file-level locking for concurrent access safety (CLI + MCP server).
 */
export class ManifestManager {
  constructor(private readonly manifestPath: string) {}

  /**
   * ADR-139 (SMI-6274 Wave 4): the manifest path this instance was
   * constructed with — read-only accessor for callers that need to name it
   * in a diagnostic message (e.g. `performUninstall`'s adoption-failure
   * error, which must name the skill, the path, AND the manifest it tried
   * to write, per ADR-139 point 1).
   */
  get path(): string {
    return this.manifestPath
  }

  /**
   * SMI-6007: distinguishes "no manifest yet" (ENOENT — legitimate first-run
   * case, safe to synthesize an empty manifest) from "a manifest file exists
   * but couldn't be read/parsed" (corrupt JSON, permission error, I/O
   * failure). The latter used to be silently swallowed into the same empty
   * manifest, which is a real data-loss risk: a caller that then `save()`s
   * that empty snapshot back out would erase every previously-recorded
   * install. Now it throws loudly instead, so a corrupt manifest surfaces as
   * an error rather than silently wiping state on the next write.
   */
  async load(): Promise<SkillManifest> {
    let content: string
    try {
      content = await fs.readFile(this.manifestPath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: '1.0.0', installedSkills: {} }
      }
      throw error
    }

    try {
      return JSON.parse(content)
    } catch (error) {
      throw new Error(
        'Manifest file at ' +
          this.manifestPath +
          ' exists but is corrupt/unparseable: ' +
          (error instanceof Error ? error.message : String(error))
      )
    }
  }

  /**
   * SMI-6007: the temp filename now includes a `randomUUID()` suffix (not
   * just `process.pid`) — two concurrent `save()` calls in the same process
   * previously collided on an identical `.tmp.<pid>` path, letting one
   * call's temp file win the write while the other's `rename()` either
   * clobbered it mid-flight or failed outright. Each call now owns a
   * uniquely-named temp file for its own lifetime. The write+rename is
   * wrapped in try/catch so a failure best-effort removes only *this
   * invocation's* temp file before rethrowing the original error (mirrors
   * `sqljsDriver.ts`'s `persist()`, SMI-5997) — the error is never swallowed.
   */
  async save(manifest: SkillManifest): Promise<void> {
    assertNotRealUserHome(this.manifestPath, 'write')
    await fs.mkdir(path.dirname(this.manifestPath), { recursive: true })
    const tempPath = this.manifestPath + '.tmp.' + process.pid + '.' + randomUUID()
    try {
      await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2))
      await fs.rename(tempPath, this.manifestPath)
    } catch (error) {
      try {
        await fs.unlink(tempPath)
      } catch {
        // best-effort cleanup — surface the original error either way
      }
      throw error
    }
  }

  async acquireLock(): Promise<void> {
    // Guarded here as well as in save(): updateSafely() acquires the lock
    // BEFORE it loads, so without this the guard would fire only after a
    // `manifest.json.lock` file had already been created in the real home.
    assertNotRealUserHome(this.manifestPath, 'lock')
    const lockPath = this.manifestPath + '.lock'
    const startTime = Date.now()

    await fs.mkdir(path.dirname(this.manifestPath), { recursive: true })

    while (Date.now() - startTime < MANIFEST_LOCK_TIMEOUT_MS) {
      try {
        await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' })
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          try {
            const stats = await fs.stat(lockPath)
            if (Date.now() - stats.mtimeMs > MANIFEST_LOCK_TIMEOUT_MS) {
              await fs.unlink(lockPath).catch(() => {})
              continue
            }
          } catch {
            continue
          }
          await new Promise((resolve) => setTimeout(resolve, MANIFEST_LOCK_RETRY_MS))
        } else {
          throw error
        }
      }
    }

    throw new Error('Failed to acquire manifest lock after ' + MANIFEST_LOCK_TIMEOUT_MS + 'ms')
  }

  async releaseLock(): Promise<void> {
    // Guarded (adversarial-review finding, SMI-6343 follow-up): a caller that
    // invokes releaseLock() directly against a real-home-derived path (a
    // cleanup helper, an afterEach) would otherwise delete a lock a live
    // skillsmith process is holding on the real manifest, silently breaking
    // that process's mutual exclusion. save()/acquireLock() reach this only
    // through updateSafely()'s already-guarded acquireLock(), so this is
    // belt-and-suspenders for a caller that skips that path.
    assertNotRealUserHome(this.manifestPath, 'unlock')
    try {
      await fs.unlink(this.manifestPath + '.lock')
    } catch {
      // Ignore — lock may have been cleaned up by timeout
    }
  }

  async updateSafely(updateFn: (manifest: SkillManifest) => SkillManifest): Promise<void> {
    await this.acquireLock()
    try {
      const manifest = await this.load()
      const updated = updateFn(manifest)
      await this.save(updated)
    } finally {
      await this.releaseLock()
    }
  }
}
