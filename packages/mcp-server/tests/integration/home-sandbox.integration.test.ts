/**
 * @fileoverview SMI-6343 Wave 1 — proof that the $HOME sandbox reaches THIS
 * config, and that a defaulted manifest path can no longer touch the real one.
 *
 * Why it lives here and not next to the other unit tests: the original fix
 * attempt put `setupFiles` only in the root `vitest.config.ts`, which does not
 * govern `packages/mcp-server/tests/integration/**`. That config is the ONLY
 * one that runs the two files whose unmocked manifest path wrote
 * `test-skill` / `shutdown-persistence-fixture` rows into a real user's
 * ~/.skillsmith/manifest.json, and it declared no `setupFiles` at all — so a
 * sandbox declared anywhere else would have left the actual leak site open.
 *
 * This file is therefore a config-topology regression test as much as a
 * behavioural one: if someone removes `...sharedTestConfig` from
 * vitest.config.integration.ts, or redeclares `setupFiles` locally (which
 * overrides rather than merges), these assertions fail immediately.
 *
 * Nothing here writes to the real home. The real manifest is only ever
 * stat()ed — existence, size and mtime — never read, never created.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { ManifestManager } from '@skillsmith/core'

/** `os.userInfo()` reads the password-file entry and ignores $HOME, so it is
 *  the one way to recover the real home AFTER the sandbox is installed. */
function preSandboxHome(): string {
  return process.env.SKILLSMITH_TEST_REAL_HOME ?? os.userInfo().homedir
}

/**
 * Is the `@skillsmith/core` this file imported actually built from THIS tree?
 *
 * A HOST (non-Docker) run inside a git worktree resolves `@skillsmith/core`
 * through the shared `node_modules` symlink into the MAIN checkout's built
 * `dist/` — so `ManifestManager` there is main's code, not this branch's. That
 * is the same "silently tested main's state, not the branch's" shape
 * SMI-5570/SMI-5074 documents for pre-push, and it is why Docker-first is the
 * repo default. The $HOME sandbox assertions below are unaffected (they are a
 * process.env-level redirect, independent of which core build is loaded), but
 * an assertion ABOUT core's own code can only be made when core came from here.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const CORE_IS_FROM_THIS_TREE = (() => {
  try {
    const resolved = createRequire(import.meta.url).resolve('@skillsmith/core')
    return resolved.startsWith(path.resolve(REPO_ROOT) + path.sep)
  } catch {
    return false
  }
})()

type Snapshot = { exists: boolean; size: number; mtimeMs: number }

function snapshot(p: string): Snapshot {
  if (!existsSync(p)) return { exists: false, size: -1, mtimeMs: -1 }
  const s = statSync(p)
  return { exists: true, size: s.size, mtimeMs: s.mtimeMs }
}

describe('SMI-6343: $HOME sandbox is inherited by vitest.config.integration.ts', () => {
  let realHome: string
  let realManifestPath: string
  let realManifestLockPath: string

  beforeAll(() => {
    realHome = preSandboxHome()
    realManifestPath = path.join(realHome, '.skillsmith', 'manifest.json')
    realManifestLockPath = realManifestPath + '.lock'
  })

  it('vitest.setup.ts actually ran under this config (the C4 regression)', () => {
    // If this fails, `setupFiles` is not reaching this config — either the
    // `...sharedTestConfig` spread was dropped from
    // packages/mcp-server/vitest.config.integration.ts, or a local
    // `setupFiles` key silently overrode the inherited one.
    expect(process.env.SKILLSMITH_TEST_REAL_HOME).toBeTruthy()
    expect(process.env.HOME ?? process.env.USERPROFILE).toBeTruthy()
  })

  it('os.homedir() is redirected to a temp sandbox, not the real home', () => {
    const sandboxHome = os.homedir()
    expect(sandboxHome).not.toBe(realHome)
    expect(sandboxHome.startsWith(path.resolve(os.tmpdir()))).toBe(true)
  })

  it('a manifest write that DEFAULTS to os.homedir() lands in the sandbox, never the real home', async () => {
    // This is the exact code shape that leaked: nothing overrides the manifest
    // path, so it resolves from os.homedir() — the same expression
    // SkillInstallationService's module-level DEFAULT_MANIFEST_PATH uses.
    const manifestPath = path.join(os.homedir(), '.skillsmith', 'manifest.json')
    const before = snapshot(realManifestPath)
    const lockBefore = snapshot(realManifestLockPath)

    const manager = new ManifestManager(manifestPath)
    await manager.updateSafely((manifest) => ({
      ...manifest,
      installedSkills: {
        ...manifest.installedSkills,
        'smi-6343-sandbox-probe': {
          id: '00000000-6343-4000-8000-000000000003',
          name: 'smi-6343-sandbox-probe',
          version: '1.0.0',
          source: 'unknown',
          installPath: path.join(os.homedir(), '.claude', 'skills', 'smi-6343-sandbox-probe'),
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        },
      },
    }))

    // It really wrote — otherwise the "real home untouched" assertions below
    // would be trivially true (anti-false-green).
    expect(existsSync(manifestPath)).toBe(true)
    const written = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    expect(written.installedSkills['smi-6343-sandbox-probe']).toBeDefined()

    // …and it wrote somewhere that is NOT the developer's real home.
    expect(manifestPath).not.toBe(realManifestPath)
    expect(path.resolve(manifestPath).startsWith(path.resolve(realHome) + path.sep)).toBe(false)

    // The real manifest is byte-for-byte where it was: not created, not
    // modified, and no stray lockfile left behind next to it.
    expect(snapshot(realManifestPath)).toEqual(before)
    expect(snapshot(realManifestLockPath)).toEqual(lockBefore)
    expect(existsSync(realManifestLockPath)).toBe(false)
  })

  // skipIf, not a silent pass: on a host run from a worktree the imported
  // ManifestManager is the MAIN checkout's build, so this assertion would be
  // reporting on code that is not in this diff. It still runs unconditionally
  // in this worktree's own container and in CI (both resolve core from this
  // tree), which is where the result is authoritative. It is NOT keyed on
  // Docker — a host run in the main checkout resolves core from that tree and
  // runs this normally.
  it.skipIf(!CORE_IS_FROM_THIS_TREE)(
    'ManifestManager refuses a manifest path under the captured real home (runtime guard)',
    async () => {
      // Defense in depth for the case the sandbox misses: a hardcoded path, or a
      // constant captured before setup ran.
      //
      // This deliberately does NOT aim at the developer's actual home. Two
      // reasons, the second learned the hard way while writing this test:
      //   1. If the guard is absent or broken, an assertion that "this throws"
      //      fails only AFTER `updateSafely()` has already done a real
      //      read-modify-write of the real manifest. A test for a data-integrity
      //      guard must not need the guard to work in order to be safe.
      //   2. A HOST (non-Docker) run from a git worktree resolves
      //      `@skillsmith/core` through the shared `node_modules` symlink into
      //      the MAIN checkout's built `dist/` — i.e. NOT this branch's core. So
      //      on a host run this assertion reports whatever guard main has, which
      //      is exactly the "silently tested main's state, not the branch's"
      //      shape SMI-5570/SMI-5074 documents for pre-push. Run it in this
      //      worktree's own container (or CI) for an authoritative result.
      //
      // Redirecting the guard's ground truth to a throwaway directory keeps the
      // assertion identical and the blast radius zero.
      const fakeRealHome = await fs.mkdtemp(path.join(os.tmpdir(), 'smi6343-fake-real-home-'))
      const previousRealHome = process.env.SKILLSMITH_TEST_REAL_HOME
      process.env.SKILLSMITH_TEST_REAL_HOME = fakeRealHome
      try {
        const manifestPath = path.join(fakeRealHome, '.skillsmith', 'manifest.json')
        const manager = new ManifestManager(manifestPath)

        await expect(manager.updateSafely((m) => m)).rejects.toThrow(/SMI-6343/)
        await expect(manager.save({ version: '1.0.0', installedSkills: {} })).rejects.toThrow(
          /SMI-6343/
        )

        // acquireLock() is guarded too, so updateSafely() failed BEFORE creating
        // a lockfile — the whole point of guarding both entry points rather than
        // save() alone. Neither the manifest nor its lock was ever created.
        expect(existsSync(manifestPath)).toBe(false)
        expect(existsSync(manifestPath + '.lock')).toBe(false)
      } finally {
        if (previousRealHome === undefined) delete process.env.SKILLSMITH_TEST_REAL_HOME
        else process.env.SKILLSMITH_TEST_REAL_HOME = previousRealHome
        await fs.rm(fakeRealHome, { recursive: true, force: true })
      }

      // The developer's actual manifest lock was never a target here — assert
      // it anyway, since this is the file that would show a stray lock if the
      // guard's path comparison ever regressed.
      expect(existsSync(realManifestLockPath)).toBe(false)
    }
  )
})
