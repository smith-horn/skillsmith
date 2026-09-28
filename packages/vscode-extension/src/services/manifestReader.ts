/**
 * Manifest reader for the VS Code extension (SMI-5412).
 *
 * Reads ~/.skillsmith/manifest.json to find the upstream source URL for a
 * locally-installed skill, enabling "View Changes" to diff bare-id skills
 * against their GitHub source (recovered by SMI-5407).
 *
 * Mirror-don't-import: the extension bundles via esbuild with no-dependencies
 * and intentionally does NOT depend on @skillsmith/core or the CLI (importing
 * either would pull native modules into the VSIX bundle). Types here mirror
 * CLI's utils/manifest.ts; kept in sync manually.
 *
 * @module services/manifestReader
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirrors @skillsmith/cli/utils/manifest.ts — minimal subset)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal manifest entry shape. Matches CLI's SkillManifestEntry. */
export interface ManifestEntry {
  id: string
  name: string
  source?: string
  installPath?: string
}

interface ManifestFile {
  installedSkills?: Record<string, ManifestEntry>
}

// ─────────────────────────────────────────────────────────────────────────────
// Update-target reason/result mirror (SMI-6532 A2)
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors @skillsmith/core's packages/core/src/services/update-target-reason.ts
// UpdateTargetReason and UpdateResultCode member lists verbatim (see that
// file's own doc comment for the full §4.3/§4.4 derivation and the member
// count discrepancy noted there). Kept in sync manually, per this file's own
// "Mirror-don't-import" header comment above — the same constraint that keeps
// this file's other types independent of @skillsmith/core.
//
// packages/core/src/services/update-target-reason.test.ts reads this file's
// source text at test time and diffs these two arrays against core's own
// UPDATE_TARGET_REASONS / UPDATE_RESULT_CODES member lists, so a drift here
// fails core's test suite rather than silently shipping two extensions that
// disagree on what a reason or result code means.

/** Mirrors `UPDATE_TARGET_REASONS` in @skillsmith/core/services/update-target-reason.ts. */
export const UPDATE_TARGET_REASONS = [
  'manifest-unreadable',
  'recovery-record-unreadable',
  'backup-dir',
  'recovery-pending',
  'untracked',
  'manifest-key-conflict',
  'git-managed',
  'local',
  'illegal-provenance',
  'unverified',
  'pinned',
  'policy-never',
  'policy-manual',
  'identity-mismatch',
  'fetch-failed',
  'scan-rejected',
  'unsupported-entry',
  'no-baseline',
  'local-edits',
  'up-to-date',
  'eligible',
  'probe-failed',
  'unreadable',
] as const

export type UpdateTargetReason = (typeof UPDATE_TARGET_REASONS)[number]

/** Mirrors `UPDATE_RESULT_CODES` in @skillsmith/core/services/update-target-reason.ts. */
export const UPDATE_RESULT_CODES = [
  'updated',
  'changed-since-plan',
  'busy',
  'target-changed',
  'root-changed',
  'staging-unsafe',
  'staging-collision',
  'backup-unsafe',
  'recovery-pending',
  'recovery-record-unreadable',
  'recovery-conflict',
  'recovery-identity-changed',
  'recovery-ambiguous',
  'recovery-moved',
  'write-failed',
] as const

export type UpdateResultCode = (typeof UPDATE_RESULT_CODES)[number]

/**
 * Mirrors the `kind` field of `@skillsmith/core`'s `UpdateRemediation`
 * union (`update-target-reason.ts`) — the ten remediation kinds
 * `remediationFor()` can return. Kept in sync manually, same constraint as
 * the two arrays above.
 */
export type UpdateRemediationKind =
  | 'git-pull'
  | 'reconcile'
  | 'unpin'
  | 'set-policy'
  | 'fix-permissions'
  | 'audit-sources'
  | 'move-aside'
  | 'doctor'
  | 'retry'
  | 'none'

/**
 * One short, human sentence per closed-set member (SMI-6532 A2 §4.4). This
 * extension's own copy — the MCP surface (`@skillsmith/mcp-server`'s
 * `update-target-render.ts`) keeps a separate copy of the same shape; §4.4's
 * parity test checks both are non-empty per member, not that the wording
 * matches. `UpdateTargetReason` and `UpdateResultCode` share two literal
 * strings (`recovery-pending`, `recovery-record-unreadable`), so this
 * `Record` has 36 keys, not 38 — see `update-target-render.ts`'s doc comment
 * for why one shared entry per string is correct.
 */
/**
 * PREPARATORY (SMI-6532 step 6, 2026-09-27). NOTHING IN THIS EXTENSION READS EITHER
 * TABLE BELOW YET.
 *
 * They are kept exhaustive and in step with `@skillsmith/core`'s closed sets so that
 * the consumer arriving with SMI-6531 finds them correct. Until then no user sees any
 * of this text, and no code path here depends on it. Stated in this file because its
 * two sibling tables — the MCP one and the parity test in core — say so in their own
 * headers, and a reader opening only this file would otherwise reasonably read the
 * care taken over these entries as evidence that something consumes them.
 */
export const UPDATE_TARGET_TEXT: Record<UpdateTargetReason | UpdateResultCode, string> = {
  'manifest-unreadable': 'The manifest file could not be read',
  'recovery-record-unreadable': 'A recovery record for this skills root could not be read',
  'backup-dir': 'This is a backup directory, not an update target',
  'recovery-pending': 'An unresolved recovery record exists for this skill',
  untracked: 'No manifest entry references this installed skill',
  'manifest-key-conflict': 'Another manifest key already claims this real path',
  'git-managed': 'This skill is a git clone and is pulled, not overwritten',
  local: 'This skill was authored locally, not installed from the registry',
  'illegal-provenance': 'This skill has a provenance combination that is not allowed',
  unverified: 'This skill has a registry reference but no verified provenance',
  pinned: 'This skill is pinned and excluded from updates',
  'policy-never': 'The update policy for this skill is set to never update',
  'policy-manual': 'The update policy for this skill requires a manual update',
  'identity-mismatch': 'The recorded identity for this skill contradicts what is on disk',
  'fetch-failed': 'Fetching the candidate new content failed',
  'scan-rejected': 'The candidate new content failed a security scan',
  'unsupported-entry': 'The write set contains something other than a plain file',
  'no-baseline': 'A modified file has no recorded baseline to compare against',
  'local-edits': 'A file has local edits that differ from its recorded baseline',
  'up-to-date': 'This skill is already up to date',
  eligible: 'This skill is eligible to update',
  'probe-failed': 'Reading this target metadata failed',
  unreadable: 'Reading or hashing a file in this target write set failed',
  updated: 'The update was applied successfully',
  'changed-since-plan': 'The plan went stale before it could be applied',
  busy: 'A lock held by another process blocked this update',
  'target-changed': 'The target changed underneath this update',
  'root-changed': 'The skills root changed underneath this update',
  'staging-unsafe': 'The staging directory is unsafe to write through',
  'staging-collision': 'The staging directory collides with an existing path',
  'backup-unsafe': 'The backup directory is unsafe to write through',
  'recovery-conflict': 'The recovery record conflicts with the current state',
  'recovery-identity-changed': 'The recovered target identity has changed',
  'recovery-ambiguous': 'The recovery record is ambiguous and needs review',
  'recovery-moved': 'The recovered target has moved and needs relinking',
  'write-failed': 'Writing the update to disk failed',
}

/**
 * Mirrors `remediationFor()`'s reason/result -> kind mapping in
 * `@skillsmith/core`'s `update-target-reason.ts` (`REASON_REMEDIATION` /
 * `RESULT_REMEDIATION`). This is the real second source the SMI-6532 §4.4
 * parity test compares against core's actual `remediationFor()` output — MCP
 * derives its kind by calling `remediationFor()` directly, so an MCP-to-core
 * comparison would be trivially equal and test nothing; this mirror can
 * genuinely drift, which is the point of comparing it. Values measured
 * directly against `remediationFor()`'s live output (SMI-6532 step 6), not
 * inferred from the plan text.
 */
export const UPDATE_REMEDIATION_KIND: Record<
  UpdateTargetReason | UpdateResultCode,
  UpdateRemediationKind
> = {
  'manifest-unreadable': 'fix-permissions',
  'recovery-record-unreadable': 'fix-permissions',
  'backup-dir': 'none',
  'recovery-pending': 'doctor',
  untracked: 'none',
  'manifest-key-conflict': 'reconcile',
  'git-managed': 'git-pull',
  local: 'none',
  'illegal-provenance': 'audit-sources',
  unverified: 'audit-sources',
  pinned: 'unpin',
  'policy-never': 'set-policy',
  'policy-manual': 'set-policy',
  'identity-mismatch': 'reconcile',
  'fetch-failed': 'retry',
  'scan-rejected': 'audit-sources',
  'unsupported-entry': 'move-aside',
  'no-baseline': 'audit-sources',
  'local-edits': 'none',
  'up-to-date': 'none',
  eligible: 'none',
  'probe-failed': 'fix-permissions',
  unreadable: 'fix-permissions',
  updated: 'none',
  'changed-since-plan': 'retry',
  busy: 'retry',
  'target-changed': 'retry',
  'root-changed': 'retry',
  'staging-unsafe': 'move-aside',
  'staging-collision': 'move-aside',
  'backup-unsafe': 'move-aside',
  'recovery-conflict': 'doctor',
  'recovery-identity-changed': 'reconcile',
  'recovery-ambiguous': 'doctor',
  'recovery-moved': 'reconcile',
  'write-failed': 'fix-permissions',
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest entry lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the manifest entry for the given skill.
 *
 * Match priority: installPath (most robust) > name > id.
 * Returns null when the manifest is absent, unreadable, or has no match.
 */
export async function readManifestEntry(skill: {
  name: string
  id: string
  path: string
}): Promise<ManifestEntry | null> {
  const manifestPath = path.join(os.homedir(), '.skillsmith', 'manifest.json')
  try {
    const content = await fs.readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(content) as ManifestFile
    const entries = Object.values(manifest.installedSkills ?? {})
    return (
      entries.find((e) => e.installPath === skill.path) ??
      entries.find((e) => e.name === skill.name) ??
      entries.find((e) => e.id === skill.id) ??
      null
    )
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub raw URL helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a GitHub repo URL to a raw.githubusercontent.com SKILL.md URL.
 *
 * Mirrors packages/cli/src/commands/diff.ts `buildRawUrl` with an added
 * `branch` parameter to support the main-then-master fallback used by
 * fetchRawSkillMd.
 *
 * Returns null for non-GitHub URLs or unrecognised shapes.
 *
 * @param source - GitHub URL, e.g. `https://github.com/owner/repo` or
 *   `https://github.com/owner/repo/tree/my-branch`
 * @param branch - Branch to use when the URL has no explicit `/tree/<ref>`
 */
export function buildRawGitHubUrl(source: string, branch = 'main'): string | null {
  if (source.startsWith('https://raw.githubusercontent.com/')) return source

  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/.exec(source)
  if (!m) return null

  const [, owner, repo, explicitRef] = m
  const ref = explicitRef ?? branch
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/SKILL.md`
}

/**
 * Fetch the raw SKILL.md from a GitHub repository source URL.
 *
 * Tries the `main` branch first; on a 404 retries with `master`. Returns null
 * when the URL is non-GitHub, both branches return 404, or a network / timeout
 * error occurs. Callers must treat null as "source unavailable".
 */
export async function fetchRawSkillMd(source: string): Promise<string | null> {
  const TIMEOUT_MS = 10_000
  for (const branch of ['main', 'master'] as const) {
    const rawUrl = buildRawGitHubUrl(source, branch)
    if (!rawUrl) return null
    try {
      const res = await fetch(rawUrl, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.ok) {
        return await res.text()
      }
      if (res.status !== 404) {
        // Non-404 (5xx, auth, etc.) — retrying with master won't help
        return null
      }
      // 404 on main — fall through to master retry
    } catch {
      return null
    }
  }
  return null
}
