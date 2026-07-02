/**
 * Filesystem primitives shared by `installAgentPack` (SMI-5456 Wave 1 Step 5).
 *
 * `writeOwnedArtifactFile` is the idempotency backbone for the P-5
 * "double-install produces identical filesystem state, no duplicate
 * backups" test: byte-identical content at an already-correct path is a
 * true no-op (no write, no backup, no manifest churn beyond re-recording the
 * same entry).
 *
 * @module @skillsmith/core/install/agent-pack-installer.fs-helpers
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface WriteOwnedFileOptions {
  path: string
  content: string
  executable: boolean
  backupDir: string
}

export interface WriteOwnedFileResult {
  /** True when a write actually happened (content or executable-bit changed, or the file was new). */
  changed: boolean
  /** Backup of PRE-EXISTING different content, or null (nothing existed, or content already matched). */
  backupPath: string | null
}

/**
 * Write a file the installer fully owns by path convention (SKILL.md copies,
 * shim files, hook scripts). Idempotent: re-writing identical content with
 * the correct executable bit is a no-op. A pre-existing file with DIFFERENT
 * content is backed up before being overwritten (defensive — these paths are
 * namespaced (`skillsmith-agent`) so a genuine foreign collision is unlikely,
 * but never silently destroying user data is the house floor).
 */
export function writeOwnedArtifactFile(opts: WriteOwnedFileOptions): WriteOwnedFileResult {
  const { path, content, executable, backupDir } = opts

  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf-8')
    const currentlyExecutable = isExecutable(path)
    if (existing === content && currentlyExecutable === executable) {
      return { changed: false, backupPath: null }
    }
    const backupPath = writeBackup(path, backupDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf-8')
    if (executable) chmodSync(path, 0o755)
    return { changed: true, backupPath }
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  if (executable) chmodSync(path, 0o755)
  return { changed: true, backupPath: null }
}

function isExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0
  } catch {
    return false
  }
}

function writeBackup(sourcePath: string, backupDir: string): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = sourcePath.split('/').pop() ?? 'file'
  const backupPath = join(backupDir, `${stamp}-${baseName}.bak`)
  writeFileSync(backupPath, readFileSync(sourcePath, 'utf-8'), { mode: 0o600 })
  return backupPath
}
