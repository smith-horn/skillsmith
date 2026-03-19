/**
 * @fileoverview Manifest manager for skill installation tracking
 * @module @skillsmith/core/services/skill-manifest
 * @see SMI-3483: Extracted from skill-installation.service.ts to meet 500-line standard
 */

import * as fs from 'fs/promises'
import * as path from 'path'

import type { SkillManifest } from './skill-installation.types.js'

const MANIFEST_LOCK_TIMEOUT_MS = 30000
const MANIFEST_LOCK_RETRY_MS = 100

/**
 * Manages the skill manifest file (~/.skillsmith/manifest.json) with
 * file-level locking for concurrent access safety (CLI + MCP server).
 */
export class ManifestManager {
  constructor(private readonly manifestPath: string) {}

  async load(): Promise<SkillManifest> {
    try {
      const content = await fs.readFile(this.manifestPath, 'utf-8')
      return JSON.parse(content)
    } catch {
      return { version: '1.0.0', installedSkills: {} }
    }
  }

  async save(manifest: SkillManifest): Promise<void> {
    await fs.mkdir(path.dirname(this.manifestPath), { recursive: true })
    const tempPath = this.manifestPath + '.tmp.' + process.pid
    await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2))
    await fs.rename(tempPath, this.manifestPath)
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
