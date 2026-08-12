/**
 * @fileoverview Manifest manager for skill installation tracking
 * @module @skillsmith/core/services/skill-manifest
 * @see SMI-3483: Extracted from skill-installation.service.ts to meet 500-line standard
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'node:crypto'

import type { SkillManifest } from './skill-installation.types.js'

const MANIFEST_LOCK_TIMEOUT_MS = 30000
const MANIFEST_LOCK_RETRY_MS = 100

/**
 * Manages the skill manifest file (~/.skillsmith/manifest.json) with
 * file-level locking for concurrent access safety (CLI + MCP server).
 */
export class ManifestManager {
  constructor(private readonly manifestPath: string) {}

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
