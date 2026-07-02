/**
 * Install manifest for `sklx agent install` / `uninstall` (SMI-5456 Wave 1
 * Step 5).
 *
 * `sklx agent uninstall` must reverse EXACTLY what install wrote — per-
 * changeset file identity, not a re-derivation from the current pack
 * generator (which could have changed between install and uninstall, e.g.
 * across a version bump). The manifest is the durable record of every path
 * the installer created or modified, plus a backup reference for anything it
 * modified (so a foreign file's pre-existing content is restorable) or `null`
 * for anything it created outright (so uninstall deletes rather than
 * restores).
 *
 * Location: `~/.skillsmith/agent-install/manifest.json` — a sibling
 * directory to `~/.skillsmith/journal` (Step 3) and `~/.skillsmith/agent-markers`
 * (Step 1), following the same `getConfigDir()`-rooted, env-override-for-
 * tests convention as both.
 *
 * @module @skillsmith/core/install/agent-manifest
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getConfigDir } from '../config/index.js'

/** Env var overriding the manifest directory (test isolation — mirrors SKILLSMITH_JOURNAL_DIR). */
export const AGENT_INSTALL_DIR_ENV_VAR = 'SKILLSMITH_AGENT_INSTALL_DIR'

export const AGENT_MANIFEST_SCHEMA_VERSION = 1

export type AgentManifestEntryKind = 'skill' | 'shim' | 'hook-script' | 'mcp-config' | 'hook-config'

/**
 * One path the installer touched. `backupPath` is set only when a
 * PRE-EXISTING file was modified (config-file merges); it is `null` for
 * anything the installer created fresh (skill pack copies, shim files, hook
 * scripts) since there is nothing meaningful to restore — uninstall deletes.
 */
export interface AgentManifestEntry {
  path: string
  kind: AgentManifestEntryKind
  /** Harness this entry belongs to, or null for the harness-neutral SKILL.md pack. */
  harness: string | null
  backupPath: string | null
  /** True when the installer set the executable bit (hook scripts). */
  executable: boolean
}

export interface AgentInstallManifest {
  schemaVersion: number
  installedAt: string
  /** `AGENT_PACK_SCHEMA_VERSION` at install time — informational, not enforced. */
  packSchemaVersion: number
  entries: AgentManifestEntry[]
}

function getAgentInstallDir(): string {
  const override = process.env[AGENT_INSTALL_DIR_ENV_VAR]
  return override && override.length > 0 ? override : join(getConfigDir(), 'agent-install')
}

export function getAgentManifestPath(): string {
  return join(getAgentInstallDir(), 'manifest.json')
}

export function getAgentInstallBackupsDir(): string {
  return join(getAgentInstallDir(), 'backups')
}

/** Load the manifest, or an empty (never-installed) manifest if none exists or it is corrupt. */
export function loadAgentManifest(): AgentInstallManifest {
  const path = getAgentManifestPath()
  if (!existsSync(path)) return emptyManifest()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AgentInstallManifest>
    if (!parsed || !Array.isArray(parsed.entries)) return emptyManifest()
    return {
      schemaVersion: parsed.schemaVersion ?? AGENT_MANIFEST_SCHEMA_VERSION,
      installedAt: parsed.installedAt ?? new Date(0).toISOString(),
      packSchemaVersion: parsed.packSchemaVersion ?? 0,
      entries: parsed.entries,
    }
  } catch {
    return emptyManifest()
  }
}

function emptyManifest(): AgentInstallManifest {
  return {
    schemaVersion: AGENT_MANIFEST_SCHEMA_VERSION,
    installedAt: new Date(0).toISOString(),
    packSchemaVersion: 0,
    entries: [],
  }
}

/**
 * Persist a manifest, replacing any prior one. Re-running install writes a
 * fresh manifest reflecting the CURRENT full set of entries (deduped by
 * `path` — later entries in `entries` win) so a double-install never
 * accumulates duplicate entries (P-5 idempotency test).
 */
export function saveAgentManifest(manifest: AgentInstallManifest): void {
  const dir = getAgentInstallDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const deduped = dedupeEntriesByPath(manifest.entries)
  const toWrite: AgentInstallManifest = { ...manifest, entries: deduped }
  writeFileSync(getAgentManifestPath(), JSON.stringify(toWrite, null, 2) + '\n', { mode: 0o600 })
}

/**
 * Dedupe by `path`, keeping the LAST entry's `kind`/`harness`/`executable`
 * (the most recent write's classification) but preserving a non-null
 * `backupPath` from ANY entry for that path.
 *
 * A single install run can merge into the same shared config file more than
 * once (claude-code's SessionStart/SessionEnd hooks AND its MCP
 * registration all touch `~/.claude/settings.json`) — only the FIRST merge
 * into that file takes a real backup of the genuine pre-install content
 * (`agent-config-merge.types.ts`'s `alreadyBackedUpPaths`); every
 * subsequent merge into the same path this run correctly reports
 * `backupPath: null` (nothing new to back up). A naive "last entry wins"
 * dedupe would silently drop that first, load-bearing backup reference —
 * `uninstallAgentPack` would then treat a modified pre-existing file as
 * "created fresh" and delete it instead of restoring it.
 */
function dedupeEntriesByPath(entries: readonly AgentManifestEntry[]): AgentManifestEntry[] {
  const byPath = new Map<string, AgentManifestEntry>()
  for (const entry of entries) {
    const prior = byPath.get(entry.path)
    const backupPath = entry.backupPath ?? prior?.backupPath ?? null
    byPath.set(entry.path, { ...entry, backupPath })
  }
  return [...byPath.values()]
}
