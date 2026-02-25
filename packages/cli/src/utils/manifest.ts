/**
 * @fileoverview Thin manifest reader for the Skillsmith CLI
 * @module @skillsmith/cli/utils/manifest
 * @see SMI-skill-version-tracking Wave 2
 *
 * Reads (and optionally writes) the ~/.skillsmith/manifest.json file.
 * This mirrors the SkillManifest types defined in
 * @skillsmith/mcp-server/tools/install.types without creating a cross-package
 * dependency on mcp-server.
 *
 * The CLI owns its own read path; write operations (pin/unpin) use
 * updateManifestEntry below which does an atomic temp-file rename.
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'

// ============================================================================
// Types (mirrors install.types.ts from mcp-server — kept in sync manually)
// ============================================================================

export interface SkillManifestEntry {
  id: string
  name: string
  version: string
  source: string
  installPath: string
  installedAt: string
  lastUpdated: string
  originalContentHash?: string
  contentHash?: string
  /** Wave 2: pinned content hash (8-char truncation of full SHA-256) */
  pinnedVersion?: string
  updatePolicy?: 'auto' | 'manual' | 'never'
}

export interface SkillManifest {
  version: string
  installedSkills: Record<string, SkillManifestEntry>
}

// ============================================================================
// Paths
// ============================================================================

const SKILLSMITH_DIR = join(homedir(), '.skillsmith')
export const MANIFEST_PATH = join(SKILLSMITH_DIR, 'manifest.json')

// ============================================================================
// Read / Write
// ============================================================================

/**
 * Load the manifest from disk.
 * Returns an empty manifest if the file does not exist.
 */
export async function loadManifest(): Promise<SkillManifest> {
  try {
    const content = await readFile(MANIFEST_PATH, 'utf-8')
    return JSON.parse(content) as SkillManifest
  } catch {
    return { version: '1.0.0', installedSkills: {} }
  }
}

/**
 * Save the manifest atomically (temp file → rename).
 */
export async function saveManifest(manifest: SkillManifest): Promise<void> {
  await mkdir(dirname(MANIFEST_PATH), { recursive: true })
  const tmpPath = `${MANIFEST_PATH}.tmp.${process.pid}`
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2))
  await rename(tmpPath, MANIFEST_PATH)
}

/**
 * Load the manifest, apply an update function, and save atomically.
 */
export async function updateManifestEntry(
  updateFn: (manifest: SkillManifest) => SkillManifest
): Promise<void> {
  const manifest = await loadManifest()
  const updated = updateFn(manifest)
  await saveManifest(updated)
}
