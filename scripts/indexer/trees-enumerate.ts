/**
 * Per-repo SKILL.md enumeration with validity/denylist/cap/truncation policy
 * @module scripts/indexer/trees-enumerate
 *
 * SMI-5286 Wave 1a (§#1, §#4, §#6 support): thin wrapper over
 * `fetchSkillPathsFromTree` (`trees-search.ts`) that turns ONE recursive Trees
 * API call into the set of valid SKILL.md parent directories for a repo, after
 * applying the template/example denylist (Edit D, ancestor-only), the per-repo
 * cap (`BACKFILL_MAX_SKILLS_PER_REPO`), and the Trees-truncation policy.
 *
 * Extracted into its own sibling (not folded into `trees-search.ts`) to keep that
 * file under the 500-line hard gate. Depends only on the exported
 * `fetchSkillPathsFromTree` + `TreeSkillEntry` so there is no import cycle.
 */

import { fetchSkillPathsFromTree, type TreeSkillEntry } from './trees-search.ts'
import type { RateLimitTelemetry } from './_shared/rate-limit.ts'

/** SMI-5286 Wave 1a: max number of skipped-path samples retained per run. */
const DENYLIST_SAMPLE_LIMIT = 20

/** SMI-5286 Wave 1a: default per-repo skill cap (`BACKFILL_MAX_SKILLS_PER_REPO`). */
const DEFAULT_MAX_SKILLS_PER_REPO = 50

/**
 * SMI-5286 Wave 1a (§#1, Edit D): template/example denylist segments. A SKILL.md
 * is skipped only when one of these appears as a STRICT ANCESTOR directory of the
 * skill's parent dir — never the skill's own leaf segment. Ancestor-only matching
 * keeps legitimate skills like `.agents/skills/test-runner/SKILL.md` or
 * `.claude/skills/examples-helper/SKILL.md` while dropping `examples/foo/SKILL.md`
 * and `a/templates/b/SKILL.md`. `test`/`tests` are the highest-collision terms,
 * which is exactly why a segment-anywhere match would silently kill real skills.
 */
export const TEMPLATE_DENYLIST_SEGMENTS = new Set([
  'templates',
  'examples',
  'test',
  'tests',
  'fixtures',
])

/**
 * SMI-5286 Wave 1a: mutable counters collected by `enumerateRepoSkillPaths` across
 * many repos in a run. Caller owns the object and reads the accumulated totals
 * (denylist skips + sample, cap saturation, API truncation) for the run summary.
 */
export interface EnumerateTelemetry {
  /** Count of SKILL.md entries dropped by the ancestor-only template/example denylist. */
  denylistSkipped?: number
  /** Small sample of `${owner}/${repo}:${path}` strings that were denylist-skipped. */
  denylistSkippedSample?: string[]
  /** Count of repos whose tree exceeded the per-repo cap. */
  cappedRepoCount?: number
  /** Count of repos whose Trees API response was truncated (set emitted empty). */
  truncatedRepoCount?: number
}

/**
 * SMI-5286 Wave 1a: result of `enumerateRepoSkillPaths`.
 */
export interface EnumerateRepoSkillPathsResult {
  /** Valid SKILL.md parent dirs (+ blob SHAs) after denylist + cap + truncation policy. */
  entries: TreeSkillEntry[]
  /** True if the per-repo cap clipped the set (first `cap` by path-sort were kept). */
  truncatedByCap: boolean
  /** True if the Trees API truncated; per policy (b) `entries` is empty in this case. */
  truncatedByApi: boolean
}

/**
 * SMI-5286 Wave 1a (§#1): true if a denylist segment is a STRICT ANCESTOR of the
 * skill's parent directory. `skillPath` is the SKILL.md parent dir (e.g.
 * `examples/foo` or `.agents/skills/test-runner`). The LAST segment is the skill's
 * own leaf dir and is intentionally NOT checked, so `.../test-runner` is kept while
 * `examples/...` / `.../templates/...` are dropped.
 */
function hasDenylistAncestor(skillPath: string): boolean {
  const segments = skillPath.split('/').filter((s) => s.length > 0)
  // Inspect every segment EXCEPT the last (the skill's own leaf dir).
  for (let i = 0; i < segments.length - 1; i++) {
    if (TEMPLATE_DENYLIST_SEGMENTS.has(segments[i].toLowerCase())) {
      return true
    }
  }
  return false
}

/**
 * SMI-5286 Wave 1a (§#1, §#4, §#6 support): enumerate every valid SKILL.md parent
 * directory in a repo via ONE recursive Trees API call, applying the validity
 * suffix gate (inherited from `fetchSkillPathsFromTree` — §#4 gate 1, strict
 * `/SKILL.md`), the ancestor-only template/example denylist (Edit D), the
 * per-repo cap (`BACKFILL_MAX_SKILLS_PER_REPO`), and the Trees-truncation policy
 * (default option (b): on `truncated === true` emit ZERO entries and flag
 * `truncatedByApi` for manual handling — per-subtree fallback is a 1c follow-up).
 *
 * The strict `/SKILL.md` suffix filter is NOT relaxed here: `fetchSkillPathsFromTree`
 * already matches only `entry.path.endsWith('/SKILL.md')` (or a root `SKILL.md`),
 * which excludes tokenized `use-skill.md` noise (SMI-5285).
 *
 * @param owner - GitHub repository owner
 * @param repo - Repository name
 * @param branch - Branch name or commit SHA to pass to fetchSkillPathsFromTree
 * @param telemetry - Shared rate-limit telemetry collector (threaded to fetch)
 * @param enumerateTelemetry - Run-scoped denylist/cap/truncation accumulator
 * @param cap - Max skills per repo (default `BACKFILL_MAX_SKILLS_PER_REPO` = 50)
 * @returns Enumerated entries plus truncation flags. On API truncation the entry
 *   list is empty and `truncatedByApi` is true (deterministic, no silent drop).
 */
export async function enumerateRepoSkillPaths(
  owner: string,
  repo: string,
  branch: string,
  telemetry: RateLimitTelemetry,
  enumerateTelemetry: EnumerateTelemetry,
  cap: number = DEFAULT_MAX_SKILLS_PER_REPO
): Promise<EnumerateRepoSkillPathsResult> {
  const { entries: rawEntries, truncated } = await fetchSkillPathsFromTree(
    owner,
    repo,
    branch,
    telemetry
  )

  // Truncation policy (default option (b)): the Trees API returned a non-deterministic
  // partial set. Do NOT emit the partial — record for manual handling and return zero.
  if (truncated) {
    enumerateTelemetry.truncatedRepoCount = (enumerateTelemetry.truncatedRepoCount ?? 0) + 1
    return { entries: [], truncatedByCap: false, truncatedByApi: true }
  }

  // Validity suffix gate is already applied upstream; apply the ancestor-only
  // template/example denylist here, collecting a small sample for observability.
  const allowed: TreeSkillEntry[] = []
  for (const entry of rawEntries) {
    if (hasDenylistAncestor(entry.path)) {
      enumerateTelemetry.denylistSkipped = (enumerateTelemetry.denylistSkipped ?? 0) + 1
      if (!enumerateTelemetry.denylistSkippedSample) {
        enumerateTelemetry.denylistSkippedSample = []
      }
      if (enumerateTelemetry.denylistSkippedSample.length < DENYLIST_SAMPLE_LIMIT) {
        enumerateTelemetry.denylistSkippedSample.push(`${owner}/${repo}:${entry.path}`)
      }
      continue
    }
    allowed.push(entry)
  }

  // Per-repo cap: deterministic path-sort, take the first `cap`.
  if (allowed.length > cap) {
    allowed.sort((a, b) => a.path.localeCompare(b.path))
    enumerateTelemetry.cappedRepoCount = (enumerateTelemetry.cappedRepoCount ?? 0) + 1
    return { entries: allowed.slice(0, cap), truncatedByCap: true, truncatedByApi: false }
  }

  return { entries: allowed, truncatedByCap: false, truncatedByApi: false }
}
