/**
 * SMI-5582: Tier-1 registry-skill auto-install + self-heal
 *
 * Background: first-run Tier-1 auto-install used to fail FAST at a broken
 * registry-ID lookup, so it never reached the real GitHub fetch chain. Two
 * consequences followed once the IDs were corrected:
 *
 *  1. `installSkill()` now performs real, potentially slow network I/O. It must
 *     NEVER run on the blocking startup path before `server.connect()` — hence
 *     the caller (`index.ts`) invokes {@link maybeInstallMissingTier1Skills}
 *     fire-and-forget, mirroring `checkForUpdates()`. The fetch itself is
 *     timeout-guarded in `@skillsmith/core`'s `fetchFromGitHub` (10s/request).
 *
 *  2. `markFirstRunComplete()` had already run unconditionally for the ~30
 *     users affected by the original broken IDs, so `isFirstRun()` is
 *     permanently false for them and a first-run-only retry would never fire.
 *     This module is therefore NOT gated on `isFirstRun()`: it runs on every
 *     startup and reconciles a small persisted state file
 *     (`~/.skillsmith/.tier1-status.json`) against the current
 *     {@link TIER1_SKILLS} list, retrying only the still-missing skills (and
 *     at most once per 24h). First run is just the degenerate case where the
 *     state file doesn't exist yet (`installed: []`, no `lastAttempt`).
 *
 * The one mechanism serves both paths — there is deliberately no separate
 * "first run" install loop.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ToolContext } from '../context.js'
import { installSkill, type InstallResult } from '../tools/install.js'
import { setPendingWelcome } from '../middleware/first-run-welcome.js'
import {
  SKILLSMITH_DIR,
  TIER1_SKILLS,
  formatWelcomeMessage,
  type InstalledSkillInfo,
} from './first-run.js'

/**
 * Persisted record of which Tier-1 registry skills have ever successfully
 * installed, plus when we last attempted. Same `homedir()`-based convention as
 * `FIRST_RUN_MARKER` in first-run.ts (both live under `SKILLSMITH_DIR`).
 */
export const TIER1_STATUS_FILE = join(SKILLSMITH_DIR, '.tier1-status.json')

/** 24h throttle window between retry attempts for still-missing skills. */
const RETRY_THROTTLE_MS = 24 * 60 * 60 * 1000

/**
 * Shape of `~/.skillsmith/.tier1-status.json`.
 */
export interface Tier1Status {
  /** Skill `name`s (matching {@link TIER1_SKILLS}) that have ever installed. */
  installed: string[]
  /** ISO timestamp of the most recent install attempt (any outcome). */
  lastAttempt?: string
}

/**
 * SMI-5582: opt-out for the Tier-1 registry-install + self-heal path ONLY.
 * Matches this file's env-flag idiom (`=== '1'`, cf.
 * `SKILLSMITH_SKIP_SKILL_INSTALL` in index.ts). Bundled first-party assets
 * (`skillsmith`, `varlock`) are installed synchronously elsewhere and are NOT
 * gated by this — this flag only skips the network registry path.
 */
export function isTier1AutoInstallDisabled(): boolean {
  return process.env.SKILLSMITH_TIER1_AUTOINSTALL_DISABLE === '1'
}

/**
 * Read the persisted Tier-1 status. Returns an empty (never-attempted) status
 * when the file is absent OR unparseable — the empty status naturally folds
 * the "very first run" case into the same code path as a stale/corrupt file.
 */
export function readTier1Status(): Tier1Status {
  try {
    const parsed = JSON.parse(readFileSync(TIER1_STATUS_FILE, 'utf-8')) as Partial<Tier1Status>
    return {
      installed: Array.isArray(parsed.installed)
        ? parsed.installed.filter((s): s is string => typeof s === 'string')
        : [],
      lastAttempt: typeof parsed.lastAttempt === 'string' ? parsed.lastAttempt : undefined,
    }
  } catch {
    return { installed: [] }
  }
}

/**
 * Persist the Tier-1 status. Best-effort: a write failure is logged to stderr
 * but never thrown — failing to record status must not crash the fire-and-
 * forget caller (it just means we retry next startup, subject to the throttle
 * which keys off the timestamp we failed to write).
 */
export function writeTier1Status(status: Tier1Status): void {
  try {
    if (!existsSync(SKILLSMITH_DIR)) {
      mkdirSync(SKILLSMITH_DIR, { recursive: true })
    }
    writeFileSync(TIER1_STATUS_FILE, JSON.stringify(status, null, 2))
  } catch (error) {
    // kept for `docker logs` / local debugging visibility — status persistence
    // is best-effort; a miss just means another retry next startup.
    console.error(
      '[skillsmith] Failed to persist Tier-1 status:',
      error instanceof Error ? error.message : 'Unknown error'
    )
  }
}

/**
 * True when a retry should be suppressed: a `lastAttempt` exists and is more
 * recent than the 24h window. A never-attempted status (no/invalid
 * `lastAttempt` — true first run, or an affected existing user whose status
 * file predates this feature) is never throttled.
 */
function isThrottled(lastAttempt: string | undefined, now: number): boolean {
  if (!lastAttempt) return false
  const last = Date.parse(lastAttempt)
  if (Number.isNaN(last)) return false
  return now - last < RETRY_THROTTLE_MS
}

/** True when an install outcome should count as "installed" for state purposes. */
function countsAsInstalled(result: InstallResult): boolean {
  if (result.success) return true
  // The mcp-server `InstallResult` type erases `errorCode` (the core service
  // sets it at runtime); read it defensively. A skill already present on disk
  // is "installed" for our purposes — don't churn it on the 24h retry.
  const errorCode = (result as { errorCode?: string }).errorCode
  return errorCode === 'ALREADY_INSTALLED'
}

/**
 * Options for {@link maybeInstallMissingTier1Skills}.
 */
export interface Tier1InstallOptions {
  /**
   * First-party bundled skill names to credit (without attribution) in the
   * welcome message. On true first run the caller passes the freshly-installed
   * bundled names (`skillsmith`, `varlock`); on a self-heal pass it passes `[]`
   * (the message then lists only the registry skills, which is the relevant
   * "your previously-broken essentials are now installed" signal).
   */
  bundledSkills?: string[]
}

/**
 * Reconcile the persisted Tier-1 status against {@link TIER1_SKILLS} and
 * install any still-missing registry skills. Shared by the first-run and
 * every-startup self-heal paths (see the module doc). NEVER awaited on the
 * blocking startup path — call it fire-and-forget.
 *
 * On completion (only when at least one skill was attempted) it queues the
 * welcome/status message via `setPendingWelcome()`, so it surfaces on the next
 * successful tool call rather than on stderr (which MCP hosts hide).
 *
 * Contract: never throws — all install errors are caught per-skill and folded
 * into the `failures` list. Safe to `void` at the call site.
 */
export async function maybeInstallMissingTier1Skills(
  toolContext: ToolContext,
  options: Tier1InstallOptions = {}
): Promise<void> {
  // Opt-out: skip the entire registry-network path. Bundled assets already
  // installed synchronously by the caller are unaffected.
  if (isTier1AutoInstallDisabled()) return

  const status = readTier1Status()
  const installedSet = new Set(status.installed)
  const missing = TIER1_SKILLS.filter((skill) => !installedSet.has(skill.name))

  // Everything already recorded as installed — nothing to do, no message.
  if (missing.length === 0) return

  // Throttle: don't hammer a still-failing skill more than once per 24h.
  if (isThrottled(status.lastAttempt, Date.now())) return

  console.error(
    `[skillsmith] Installing ${missing.length} missing Tier-1 skill(s): ${missing
      .map((s) => s.name)
      .join(', ')}`
  )

  const newlyInstalled: string[] = []
  const failures: string[] = []
  for (const skill of missing) {
    try {
      const result = await installSkill(
        { skillId: skill.id, force: false, skipScan: false, skipOptimize: false, confirmed: true },
        toolContext
      )
      if (countsAsInstalled(result)) {
        newlyInstalled.push(skill.name)
        console.error(`[skillsmith] Installed Tier-1 skill: ${skill.name}`)
      } else {
        failures.push(skill.name)
        console.error(
          `[skillsmith] Failed to install ${skill.name}: ${result.error ?? 'Unknown error'}`
        )
      }
    } catch (error) {
      failures.push(skill.name)
      console.error(
        `[skillsmith] Failed to install ${skill.name}:`,
        error instanceof Error ? error.message : 'Unknown error'
      )
    }
  }
  // ^ console.error prints kept for `docker logs` / local debugging visibility —
  // the MCP tool-response annotation queued below is the primary UX channel now
  // (SMI-5573).

  // Persist outcome: merge successes into `installed`, and ALWAYS bump
  // `lastAttempt` so the 24h throttle applies even when everything failed.
  const mergedInstalled = [...new Set([...status.installed, ...newlyInstalled])]
  writeTier1Status({ installed: mergedInstalled, lastAttempt: new Date().toISOString() })

  // Compose the welcome/status message: bundled first-party skills (no
  // attribution) + every Tier-1 registry skill now installed, each with author
  // attribution (SMI-5573 third-party authorship disclosure).
  const registrySkills: InstalledSkillInfo[] = TIER1_SKILLS.filter((skill) =>
    mergedInstalled.includes(skill.name)
  ).map((skill) => ({ name: skill.name, attribution: skill.id.split('/')[0] }))
  const skillInfos: InstalledSkillInfo[] = [
    ...(options.bundledSkills ?? []).map((name) => ({ name })),
    ...registrySkills,
  ]

  const message = formatWelcomeMessage(skillInfos)
  // Fallback stderr echo (`docker logs` / local debugging); setPendingWelcome
  // is the primary channel.
  console.error(message)
  setPendingWelcome(message, failures)
}
