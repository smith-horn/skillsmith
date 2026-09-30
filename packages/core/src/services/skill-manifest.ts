/**
 * @fileoverview Manifest manager for skill installation tracking
 * @module @skillsmith/core/services/skill-manifest
 * @see SMI-3483: Extracted from skill-installation.service.ts to meet 500-line standard
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'node:crypto'

import { withFileLock } from '../config/file-lock.js'
import { loadManifestForWrite, loadManifestLenient } from './skill-manifest.read-state.js'
import type { SkillManifest, SkillManifestEntry } from './skill-installation.types.js'

/**
 * SMI-6733 Phase 1 fix: {@link ManifestManager.updateSafely}'s optional
 * second parameter. `tolerant: true` swaps the STRICT internal load
 * (`this.load()` -> `loadManifestForWrite()`, which throws
 * `ManifestUnwritableError` on a corrupt/unreadable/version-unsupported
 * manifest) for the LENIENT one (`loadManifestLenient()`, which degrades to
 * an empty document instead of throwing). Everything else about the call —
 * locking, the update callback, the save — is identical; this is a load-mode
 * switch, not a second code path.
 *
 * **It is also the one way to overwrite a manifest this process could not
 * read, so it is not a convenience.** The lenient load substitutes an EMPTY
 * document, and the save that follows writes the callback's result over the
 * original bytes — so on a `corrupt`/`unreadable`/`version_unsupported`
 * manifest, `{ tolerant: true }` is a destructive operation dressed as a
 * load-mode switch. Measured (SMI-6733): against a manifest whose readable
 * prefix recorded a real skill followed by trailing garbage, one tolerant
 * adoption write left a valid 410-byte manifest holding only the adopted
 * entry, and the recorded skill was gone — with nothing on the return path
 * signalling that anything had been discarded. The single caller that passes
 * it (`adoptUntrackedSkillEntry`) now gates it behind an explicit
 * `tolerateDegradedRead` argument that no call site may default into; see
 * that function's doc comment for the gate and its two call sites.
 */
export interface UpdateSafelyOptions {
  tolerant?: boolean
}

/**
 * The `installedSkills` map a consumer can safely dereference.
 *
 * ADR-171 § 5's container check deliberately admits a manifest whose
 * `installedSkills` is absent or `null` (SMI-6733 Phase 1) — both mean "this
 * machine has installed nothing" and neither is evidence of corruption, so
 * both classify `ok`. But {@link SkillManifest} declares the field
 * NON-optional, so a consumer writing `manifest.installedSkills[key]`
 * type-checks and then throws `Cannot read properties of null` at runtime
 * (SMI-6733 MAJOR 3, measured for both `null` and absent).
 *
 * The gap is closed HERE, on the consumer side, and not in the classifier,
 * because ADR-171 § 3 forbids the classifier transforming the parsed value:
 * the object handed onward must stay the raw `JSON.parse` result for the
 * CAS's canonical-form comparison. Normalising for a READER is not the same
 * as rewriting for a WRITER — the `{}` returned when the field is nullish is
 * a fresh object, so a caller must not mutate it expecting the change to
 * reach the manifest. Writers mutate inside {@link ManifestManager.updateSafely}'s
 * callback, which builds its own object either way.
 */
export function installedSkillsOf(manifest: SkillManifest): Record<string, SkillManifestEntry> {
  // The widening is the point: the declared type says non-optional, the
  // validated runtime shape says otherwise, and the declared type is the one
  // that is wrong. See the doc comment above.
  const value = manifest.installedSkills as Record<string, SkillManifestEntry> | null | undefined
  return value ?? {}
}

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
   *
   * ADR-171 (SMI-6733): re-implemented on top of the five-state classifier
   * in `skill-manifest.read-state.ts` — external behaviour is unchanged
   * (`ENOENT` -> empty manifest, everything else throws), but the thrown
   * message is now ADR-171 § 8's, and a manifest that PARSES but fails § 5's
   * shape check (e.g. `installedSkills: []`) now throws here too, where it
   * previously flowed through untouched. `ManifestManager.load()` is
   * literally `loadManifestForWrite()` — this class IS the canonical writer,
   * so there is no separate "read-only" behaviour to preserve.
   */
  async load(): Promise<SkillManifest> {
    return loadManifestForWrite(this.manifestPath)
  }

  /**
   * The lenient twin of {@link load}, and the ONLY thing `updateSafely`'s
   * `{ tolerant: true }` substitutes for it.
   *
   * SMI-6733: it is a METHOD rather than a direct `loadManifestLenient(this
   * .manifestPath)` call inside `updateSafely` purely for symmetry — the
   * strict branch goes through `this.load()`, so a subclass or test double
   * that overrides one load path but not the other would otherwise be
   * consulted on the strict branch and silently bypassed on the tolerant
   * one. That asymmetry is invisible at the call site and exactly the shape
   * of bypass SMI-6733 Phase 1 removed one level up (a helper that called
   * `manifest.save()` around an injected `ManifestManager`), so it is closed
   * here rather than left as a smaller instance of the same thing.
   *
   * The warning `loadManifestLenient` returns is deliberately dropped: the
   * decision to proceed on a degraded read has already been taken by the
   * caller that passed `{ tolerant: true }`, and that caller — not this
   * method — owns reporting it.
   */
  async loadTolerant(): Promise<SkillManifest> {
    return (await loadManifestLenient(this.manifestPath)).manifest
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

  /**
   * SMI-6735: locking now delegates to `withFileLock` (the owned-lock
   * primitive) instead of a hand-rolled age-based EEXIST/mtime protocol —
   * see `../config/file-lock.ts`'s module comment for why: this manifest
   * path and `@skillsmith/mcp-server`'s `install.helpers.manifest.ts` used
   * to run two independent age-based lock implementations against the
   * BYTE-IDENTICAL `<manifestPath>.lock` file in the same MCP server
   * process, which is not mutual exclusion.
   *
   * The guard fires FIRST, before `withFileLock` ever attempts to create a
   * lock file — this ordering is load-bearing, exactly as it was for the
   * former `acquireLock()`: without it, a real-home-derived path would have
   * a lock file created in the real home before the guard ever ran.
   *
   * SMI-6733 Phase 1: `options.tolerant` (default `false`) routes the
   * internal load through `loadManifestLenient()` instead of `this.load()`.
   * This is the dependency-injection fix for a bypass a previous
   * implementation introduced — untracked-skill adoption used to write
   * "around" a caller-supplied `ManifestManager` via a module-local
   * `updateManifestTolerantly()` helper that took `manifest.path` and called
   * `manifest.save()` directly, never `manifest.updateSafely()` itself. A
   * caller injecting a test double (or any other `ManifestManager`-shaped
   * object) never saw its own `updateSafely` invoked, so a double that
   * intercepts `updateSafely` — to assert on what it receives, or to throw
   * — was silently routed around. Tolerance is now a PARAMETER of this
   * method instead of a path outside it, so a double that ignores the extra
   * argument still intercepts the call.
   */
  async updateSafely(
    updateFn: (manifest: SkillManifest) => SkillManifest,
    options?: UpdateSafelyOptions
  ): Promise<void> {
    assertNotRealUserHome(this.manifestPath, 'lock')
    await fs.mkdir(path.dirname(this.manifestPath), { recursive: true })
    await withFileLock(this.manifestPath, 'manifest update', async () => {
      const manifest = options?.tolerant ? await this.loadTolerant() : await this.load()
      const updated = updateFn(manifest)
      await this.save(updated)
    })
  }
}
