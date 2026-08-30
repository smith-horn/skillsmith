/**
 * Manifest-path validation for `uninstallAgentPack` (SMI-5456 governance
 * follow-up, code review 2026-07-01).
 *
 * `uninstallAgentPack` reads `~/.skillsmith/agent-install/manifest.json` and,
 * for every entry, either `unlinkSync`s `entry.path` or `writeFileSync`s
 * content read from `entry.backupPath` INTO `entry.path` — with no
 * validation that either path is one this installer could actually have
 * produced. The manifest is an ordinary 0600 JSON file under the user's own
 * HOME, not a signed or otherwise tamper-evident record; if it is ever
 * corrupted, hand-edited, or overwritten by an unrelated bug elsewhere in
 * the process (prototype pollution, a bad merge, a copy-paste from another
 * user's manifest), `uninstallAgentPack` would happily `unlinkSync` or
 * overwrite ANY path on disk the current user can write to — an
 * arbitrary-file-delete/overwrite primitive completely disconnected from
 * "what a real `sklx agent install` run actually wrote".
 *
 * This module closes that gap by checking every entry against the FIXED,
 * finite set of relative-to-HOME suffixes the installer is capable of ever
 * writing (every {@link CLIENT_NATIVE_PATHS} skill-pack path, every
 * {@link AGENT_SHIM_TARGETS} shim, every {@link AGENT_HOOK_TARGETS} hook
 * script + hook config file, every {@link AGENT_MCP_TARGETS} MCP config
 * file) before any destructive fs call touches it. `backupPath` is checked
 * separately: it must resolve under the current run's manifest/backups
 * directory. An entry failing either check is never touched — the caller
 * treats it as `rejected`, not `removed`/`restored`.
 *
 * Suffix (not full-path-prefix) matching is deliberate: `installAgentPack`
 * supports a `homeDir` test-seam that relocates every target under an
 * arbitrary temp directory (`agent-home-relocate.ts`), and
 * `uninstallAgentPack` has no matching `homeDir` wiring (paths recorded in
 * the manifest are already fully resolved at install time) — validating by
 * suffix works identically in both the real-HOME production path and the
 * relocated-HOME test path without needing to thread a redundant `homeDir`
 * through uninstall. This still shrinks the achievable blast radius from
 * "any file the process can write" down to "a file whose path happens to end
 * with one of a dozen known per-harness relative locations" — a tampered
 * manifest can no longer name `/etc/passwd` or `~/.ssh/id_rsa`.
 *
 * SMI-6275 Wave 5 addendum — a SECOND, WORKSPACE-relative allowlist. Every
 * suffix above is relative to `os.homedir()`, which is correct for every
 * OTHER installer target but not for AntiGravity's two workspace-scoped
 * artifacts (the `.agents/skills/skillsmith-agent/SKILL.md` pack copy, ADR-139
 * / SMI-6274 Wave 4, and `.agents/mcp_config.json`, this wave) — both are
 * relative to a WORKSPACE root, which is any directory a user ran
 * `agent install --scope workspace` from, not a statically enumerable set
 * the way `CLIENT_NATIVE_PATHS` is. There is deliberately no attempt to
 * validate "is this THE workspace root this manifest entry was actually
 * written under" (that would require persisting and trusting the workspace
 * root itself, which is exactly the kind of manifest-supplied data this
 * guard exists to NOT trust) — instead the check narrows to the fixed
 * RELATIVE suffix each artifact is known to end with, the same "shrink the
 * blast radius to a known relative location" philosophy as the home-relative
 * check above, applied to a workspace base instead of a home base. This
 * still cannot match `/etc/passwd` or `~/.ssh/id_rsa`; it CAN match any file
 * on disk literally named `.agents/mcp_config.json` (or the SKILL.md pack
 * path) regardless of which workspace — a real but bounded reduction from
 * "any file the process can write," consistent with this module's existing
 * standard.
 *
 * @module @skillsmith/core/install/agent-manifest-path-guard
 */

import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import { AGENT_PACK_SKILL_NAME } from '../services/agent-pack/index.js'
import {
  AGENT_HOOK_TARGETS,
  AGENT_MCP_TARGETS,
  AGENT_SHIM_TARGETS,
} from './agent-harness-targets.js'
import { getAgentInstallBackupsDir } from './agent-manifest.js'
import { ANTIGRAVITY_MCP_CONFIG_RELATIVE_SEGMENTS } from './agent-pack-installer.antigravity-mcp.js'
import { CLIENT_NATIVE_PATHS } from './paths.js'
import { CLIENT_WORKSPACE_SEGMENTS } from './workspace-scope.js'

/** Relative-to-`os.homedir()` suffix for every path the installer can ever write. */
function computeAllowedPathSuffixes(): ReadonlySet<string> {
  const suffixes = new Set<string>()
  const home = homedir()

  const addSuffix = (absPath: string): void => {
    const rel = relative(home, absPath)
    // Skip anything that isn't actually under the real home dir (defensive —
    // every constant table below is homedir()-rooted by construction, so
    // this should never trigger; guards against a future table that isn't).
    if (rel.startsWith('..') || rel === '') return
    suffixes.add(rel)
  }

  for (const nativePath of Object.values(CLIENT_NATIVE_PATHS)) {
    addSuffix(join(nativePath, AGENT_PACK_SKILL_NAME, 'SKILL.md'))
  }
  for (const target of Object.values(AGENT_SHIM_TARGETS)) {
    if (target) addSuffix(target.path)
  }
  for (const target of Object.values(AGENT_HOOK_TARGETS)) {
    addSuffix(join(target.scriptDir, 'session-start.sh'))
    addSuffix(join(target.scriptDir, 'session-end.sh'))
    addSuffix(target.configPath)
  }
  for (const target of Object.values(AGENT_MCP_TARGETS)) {
    addSuffix(target.path)
  }

  return suffixes
}

let cachedSuffixes: ReadonlySet<string> | null = null

/** Lazily computed + cached — the target tables are static, module-load-time constants. */
function allowedPathSuffixes(): ReadonlySet<string> {
  if (!cachedSuffixes) cachedSuffixes = computeAllowedPathSuffixes()
  return cachedSuffixes
}

/**
 * Relative-to-WORKSPACE-ROOT suffix for AntiGravity's two workspace-scoped
 * artifacts (SMI-6275 Wave 5 addendum — see module header). Both segments
 * are sourced from the same constants the writers themselves use
 * (`CLIENT_WORKSPACE_SEGMENTS.antigravity`, `AGENT_PACK_SKILL_NAME`,
 * `ANTIGRAVITY_MCP_CONFIG_RELATIVE_SEGMENTS`) rather than hand-duplicated
 * literals, so this allowlist can never silently drift from what
 * `installAgentPack` actually writes.
 */
function computeAllowedWorkspaceRelativeSuffixes(): ReadonlySet<string> {
  const suffixes = new Set<string>()
  const antigravitySkillsSegments = CLIENT_WORKSPACE_SEGMENTS.antigravity
  if (antigravitySkillsSegments) {
    suffixes.add(join(...antigravitySkillsSegments, AGENT_PACK_SKILL_NAME, 'SKILL.md'))
  }
  suffixes.add(join(...ANTIGRAVITY_MCP_CONFIG_RELATIVE_SEGMENTS))
  return suffixes
}

let cachedWorkspaceRelativeSuffixes: ReadonlySet<string> | null = null

function allowedWorkspaceRelativeSuffixes(): ReadonlySet<string> {
  if (!cachedWorkspaceRelativeSuffixes) {
    cachedWorkspaceRelativeSuffixes = computeAllowedWorkspaceRelativeSuffixes()
  }
  return cachedWorkspaceRelativeSuffixes
}

/**
 * True when `path` structurally matches one of the installer's known
 * relative target locations (see module header) — either HOME-relative
 * (every non-AntiGravity target, plus AntiGravity's own global skills dir
 * entry in `CLIENT_NATIVE_PATHS`) or, per the SMI-6275 Wave 5 addendum,
 * WORKSPACE-relative (AntiGravity's `.agents/`-scoped skill pack and MCP
 * config). Normalizes via `path.resolve` first so a `..`-laden path can't
 * dodge either suffix check by embedding traversal segments before the
 * matched tail.
 */
export function isAllowedManifestEntryPath(path: string): boolean {
  const normalized = resolve(path)
  for (const suffix of allowedPathSuffixes()) {
    if (normalized.endsWith(sep + suffix) || normalized === suffix) return true
  }
  for (const suffix of allowedWorkspaceRelativeSuffixes()) {
    if (normalized.endsWith(sep + suffix)) return true
  }
  return false
}

/**
 * True when `backupPath` resolves under this run's manifest backups
 * directory ({@link getAgentInstallBackupsDir}). A `null` backupPath is not
 * validated here — callers only invoke this when `backupPath` is non-null.
 */
export function isAllowedManifestBackupPath(backupPath: string): boolean {
  const backupsDir = resolve(getAgentInstallBackupsDir())
  const normalized = resolve(backupPath)
  return normalized === backupsDir || normalized.startsWith(backupsDir + sep)
}
