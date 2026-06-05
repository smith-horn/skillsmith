/**
 * @fileoverview Atomic ~/.claude/settings.json merger for telemetry hook entries.
 * @module @skillsmith/cli/commands/telemetry.helpers
 * @see SMI-5021 Wave 3 Step 2 — install-hook / uninstall-hook shared-state matrix (plan line 717)
 *
 * Public surface:
 *   loadClaudeSettings  — reads user or project settings.json (returns {} on missing)
 *   addSkillHookEntries — idempotent add; THROWS on foreign Skill matcher
 *   removeSkillHookEntries — removes only Skillsmith entries; never foreign hooks
 *   writeClaudeSettings — atomic temp-file rename (mirrors manifest.ts pattern)
 *
 * Hook schema (Claude Code settings.json):
 *   hooks.PreToolUse  = Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string }> }>
 *   hooks.PostToolUse = same shape
 *
 * Deduplication is by command path, not by matcher value.  A foreign Skill
 * matcher is one whose command path does NOT start with the Skillsmith hookPath.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HookEntry {
  type: 'command'
  command: string
}

export interface HookMatcher {
  matcher: string
  hooks: HookEntry[]
}

export interface ClaudeHooks {
  PreToolUse?: HookMatcher[]
  PostToolUse?: HookMatcher[]
  [key: string]: unknown
}

export interface ClaudeSettings {
  hooks?: ClaudeHooks
  [key: string]: unknown
}

export class TelemetryHookError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'TelemetryHookError'
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function resolveSettingsPath(scope: 'user' | 'project'): string {
  if (scope === 'user') {
    return join(homedir(), '.claude', 'settings.json')
  }
  // project scope: relative to cwd
  return join(process.cwd(), '.claude', 'settings.json')
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function loadClaudeSettings(scope: 'user' | 'project'): ClaudeSettings {
  const path = resolveSettingsPath(scope)
  if (!fs.existsSync(path)) return {}
  try {
    const raw = fs.readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as ClaudeSettings
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when a HookMatcher block uses the Skill matcher AND its first
 * hook command starts with hookPath (our Skillsmith hook).
 */
function isSkillsmithSkillMatcher(entry: HookMatcher, hookPath: string): boolean {
  return (
    entry.matcher === 'Skill' &&
    Array.isArray(entry.hooks) &&
    entry.hooks.length > 0 &&
    entry.hooks[0]!.command.startsWith(hookPath)
  )
}

/**
 * Returns true when a HookMatcher block uses the Skill matcher AND its first
 * hook command does NOT start with hookPath — i.e. a foreign Skill matcher.
 */
function isForeignSkillMatcher(entry: HookMatcher, hookPath: string): boolean {
  return (
    entry.matcher === 'Skill' &&
    Array.isArray(entry.hooks) &&
    entry.hooks.length > 0 &&
    !entry.hooks[0]!.command.startsWith(hookPath)
  )
}

/**
 * Idempotent add of Skillsmith Skill matcher entries to a hook array.
 * Dedupes by command path. Throws if a foreign Skill matcher exists.
 */
function mergeHookArray(
  existing: HookMatcher[] | undefined,
  hookPath: string,
  command: string
): HookMatcher[] {
  const arr: HookMatcher[] = Array.isArray(existing) ? [...existing] : []

  // Check for foreign Skill matcher — security gate (plan line 717)
  const foreign = arr.find((e) => isForeignSkillMatcher(e, hookPath))
  if (foreign) {
    const foreignCmd = foreign.hooks[0]?.command ?? '(unknown)'
    throw new TelemetryHookError(
      'hook.foreign_skill_matcher',
      `A foreign Skill hook already exists in settings.json:\n` +
        `  command: ${foreignCmd}\n\n` +
        `Remove it manually before installing the Skillsmith telemetry hook:\n` +
        `  1. Open ~/.claude/settings.json (or .claude/settings.json for project scope)\n` +
        `  2. Delete the PreToolUse and PostToolUse entries with matcher "Skill"\n` +
        `  3. Re-run: skillsmith telemetry install-hook`
    )
  }

  // Check if our entry already exists (idempotent)
  const alreadyPresent = arr.some((e) => isSkillsmithSkillMatcher(e, hookPath))
  if (alreadyPresent) return arr

  // Add new entry
  arr.push({ matcher: 'Skill', hooks: [{ type: 'command', command }] })
  return arr
}

/**
 * Adds PreToolUse + PostToolUse Skill matcher entries pointing at hookPath.
 * Idempotent (dedupes by command path).
 * THROWS TelemetryHookError if a foreign Skill matcher is detected.
 */
export function addSkillHookEntries(settings: ClaudeSettings, hookPath: string): ClaudeSettings {
  const preCommand = `${hookPath} pre`
  const postCommand = `${hookPath} post`

  const hooks: ClaudeHooks = { ...(settings.hooks ?? {}) }
  hooks.PreToolUse = mergeHookArray(hooks.PreToolUse, hookPath, preCommand)
  hooks.PostToolUse = mergeHookArray(hooks.PostToolUse, hookPath, postCommand)

  return { ...settings, hooks }
}

/**
 * Removes Skillsmith Skill hook entries from settings.
 * Never touches foreign hooks — only removes entries whose command starts with hookPath.
 */
export function removeSkillHookEntries(settings: ClaudeSettings, hookPath: string): ClaudeSettings {
  if (!settings.hooks) return settings

  const filterOut = (arr: HookMatcher[] | undefined): HookMatcher[] | undefined => {
    if (!Array.isArray(arr)) return arr
    const filtered = arr.filter((e) => !isSkillsmithSkillMatcher(e, hookPath))
    return filtered.length === 0 && arr.length > 0 ? [] : filtered
  }

  const hooks: ClaudeHooks = { ...settings.hooks }
  const filteredPre = filterOut(hooks.PreToolUse)
  if (filteredPre === undefined) {
    delete hooks.PreToolUse
  } else {
    hooks.PreToolUse = filteredPre
  }
  const filteredPost = filterOut(hooks.PostToolUse)
  if (filteredPost === undefined) {
    delete hooks.PostToolUse
  } else {
    hooks.PostToolUse = filteredPost
  }

  return { ...settings, hooks }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Atomic write of Claude settings.json: temp file → rename.
 * Mirrors the manifest.ts atomic write pattern (plan line 120).
 */
export function writeClaudeSettings(scope: 'user' | 'project', settings: ClaudeSettings): void {
  const path = resolveSettingsPath(scope)
  const dir = dirname(path)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const tmpSuffix = crypto.randomBytes(6).toString('hex')
  const tmpPath = `${path}.${tmpSuffix}.tmp`

  const json = JSON.stringify(settings, null, 2)
  fs.writeFileSync(tmpPath, json, { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmpPath, path)

  try {
    fs.chmodSync(path, 0o600)
  } catch {
    // Best-effort; ignore on Windows / read-only FS.
  }
}
