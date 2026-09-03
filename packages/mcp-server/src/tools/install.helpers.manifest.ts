/**
 * @fileoverview Install Tool Manifest Helpers (locking, load/save)
 * @module @skillsmith/mcp-server/tools/install.helpers.manifest
 *
 * Split out of install.helpers.ts per governance code review (500-line file
 * cap, CLAUDE.md CI Health Requirements) — same pattern already used by
 * install.conflict-helpers.ts.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { assertNotRealUserHome } from '@skillsmith/core'
import { MANIFEST_PATH, SKILLSMITH_DIR, type SkillManifest } from './install.types.js'

// ============================================================================
// Manifest Locking
// ============================================================================

/**
 * SMI-1533: Lock file path for manifest operations
 */
const MANIFEST_LOCK_PATH = MANIFEST_PATH + '.lock'
const LOCK_TIMEOUT_MS = 30000 // 30 seconds max wait for lock
const LOCK_RETRY_INTERVAL_MS = 100

/**
 * Acquire a file lock for manifest operations
 * SMI-1533: Prevents race conditions during concurrent installs
 */
export async function acquireManifestLock(): Promise<void> {
  // SMI-6343 follow-up (adversarial review): this is a second, complete
  // manifest write stack parallel to `@skillsmith/core`'s `ManifestManager`
  // — MANIFEST_PATH is homedir-derived (install.types.ts) with no override
  // parameter, so nothing here could ever be redirected even by a test that
  // wanted to. Only the $HOME sandbox (vitest.setup.ts) protected this path;
  // this guard restores the second, independent layer the rest of Wave 1 has.
  assertNotRealUserHome(MANIFEST_PATH, 'lock')
  const startTime = Date.now()

  // Ensure the skillsmith directory exists before attempting to create lock file
  // This fixes ENOENT errors in CI environments where ~/.skillsmith doesn't exist
  await fs.mkdir(SKILLSMITH_DIR, { recursive: true })

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      // Try to create lock file exclusively
      await fs.writeFile(MANIFEST_LOCK_PATH, String(process.pid), { flag: 'wx' })
      return // Lock acquired
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lock exists, check if it's stale (older than timeout)
        try {
          const stats = await fs.stat(MANIFEST_LOCK_PATH)
          const lockAge = Date.now() - stats.mtimeMs
          if (lockAge > LOCK_TIMEOUT_MS) {
            // Stale lock, remove it and retry
            await fs.unlink(MANIFEST_LOCK_PATH).catch(() => {})
            continue
          }
        } catch {
          // Lock file disappeared, retry
          continue
        }
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS))
      } else {
        throw error
      }
    }
  }

  throw new Error('Failed to acquire manifest lock after ' + LOCK_TIMEOUT_MS + 'ms')
}

/**
 * Release the manifest lock
 */
export async function releaseManifestLock(): Promise<void> {
  try {
    await fs.unlink(MANIFEST_LOCK_PATH)
  } catch {
    // Ignore errors - lock may already be released
  }
}

// ============================================================================
// Manifest Operations
// ============================================================================

/**
 * Load or create manifest.
 *
 * ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review: `manifestPath` is now an
 * optional parameter (defaulting to the GLOBAL `MANIFEST_PATH`, byte-identical
 * to every existing call site's behavior) so `install.ts`'s conflict
 * pre-flight can read the CORRECT (scope-resolved) manifest for a
 * workspace-scoped reinstall instead of either always reading global (wrong
 * manifest) or being skipped entirely for workspace scope (silently
 * dropping `conflictAction`'s only effect — `SkillInstallationService.install()`
 * itself never consumes that option). Every other caller
 * (`outdated.ts`, `skill-updates.ts`, this file's own `updateManifestSafely`)
 * keeps calling this with zero args, unaffected.
 */
export async function loadManifest(manifestPath: string = MANIFEST_PATH): Promise<SkillManifest> {
  try {
    const content = await fs.readFile(manifestPath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return {
      version: '1.0.0',
      installedSkills: {},
    }
  }
}

/**
 * Save manifest
 * SMI-1533: Uses atomic write pattern with lock
 */
export async function saveManifest(manifest: SkillManifest): Promise<void> {
  assertNotRealUserHome(MANIFEST_PATH, 'write')
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true })
  // Write to temp file first, then rename for atomic operation
  const tempPath = MANIFEST_PATH + '.tmp.' + process.pid
  await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2))
  await fs.rename(tempPath, MANIFEST_PATH)
}

/**
 * SMI-1533: Safely update manifest with locking
 * Prevents race conditions during concurrent install operations
 */
export async function updateManifestSafely(
  updateFn: (manifest: SkillManifest) => SkillManifest
): Promise<void> {
  await acquireManifestLock()
  try {
    const manifest = await loadManifest()
    const updatedManifest = updateFn(manifest)
    await saveManifest(updatedManifest)
  } finally {
    await releaseManifestLock()
  }
}
