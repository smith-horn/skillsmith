/**
 * SMI-5448 / SMI-5964 — shared pure fixture factories for the backfill
 * elapsed-budget / no-progress-escalation test suites.
 *
 * Extracted from `subdirectory-search.helpers.test.ts` when that file grew
 * past the 500-line convention (SMI-5964 added Cases 9-17). Only PURE,
 * non-mock factory functions live here — `vi.mock()` calls and the
 * `beforeEach`/`afterEach` fake-timer lifecycle cannot be shared this way
 * (vitest hoists `vi.mock()` per test file), so those stay duplicated in
 * each `*.test.ts` file that needs them.
 */

import type { BackfillFacetPlan } from '../../indexer/subdirectory-search.ts'
import type { BackfillCursor } from '../../indexer/backfill-checkpoint.ts'

export const LADDER_SIZE = 9
export const PER_PAGE = 100

let repoCounter = 0

/** Call from `beforeEach` alongside the mock `.mockReset()` calls. */
export function resetRepoCounter(): void {
  repoCounter = 0
}

export function makeCodeSearchRepo(overrides: Record<string, unknown> = {}) {
  repoCounter += 1
  const owner = `elapsed-owner${repoCounter}`
  return {
    owner,
    name: 'skills-repo',
    fullName: `${owner}/skills-repo`,
    description: 'test',
    url: `https://github.com/${owner}/skills-repo/tree/main/skills/x`,
    stars: 5,
    forks: 0,
    topics: ['claude-code-skill'],
    updatedAt: new Date().toISOString(),
    defaultBranch: 'main',
    installable: false,
    repoName: 'skills-repo',
    skillPath: 'skills/x',
    discoveryPath: 'subdirectory_search:broad',
    ...overrides,
  }
}

/** A FULL page (repos.length === perPage): total <= cap so no saturation/bisect,
 *  but the page is NOT short, so the range does NOT exhaust and keeps paginating. */
export function fullPage() {
  const repos = Array.from({ length: PER_PAGE }, () => makeCodeSearchRepo())
  return { repos, total: 500, retries: 0, incomplete_results: false }
}

/** A single-repo short page: total under the cap, repos.length < perPage, so the
 *  range exhausts in one page (clean advance). */
export function shortPage() {
  return { repos: [makeCodeSearchRepo()], total: 5, retries: 0, incomplete_results: false }
}

/** SMI-5964: a SATURATED page-1 result (`total > 1000`) carrying `count` repos --
 *  the `acceptTruncation` leaf's `saturatedPageRepos`. */
export function saturatedPage(count: number) {
  return {
    repos: Array.from({ length: count }, () => makeCodeSearchRepo()),
    total: 1001,
    retries: 0,
    incomplete_results: false,
  }
}

export function makePlan(overrides: Partial<BackfillFacetPlan> = {}): BackfillFacetPlan {
  return {
    startCursor: null,
    pathPrefix: undefined,
    perPage: PER_PAGE,
    maxPagesPerRange: 20,
    maxRangesPerDispatch: 100,
    ...overrides,
  }
}

/** SMI-5964: strip `startCursor` for the Case 10/15/16 plan-equality self-check --
 *  the ONLY field allowed to differ across dispatches sharing "one plan literal". */
export function omitStartCursor(plan: BackfillFacetPlan): Omit<BackfillFacetPlan, 'startCursor'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { startCursor: _startCursor, ...rest } = plan
  return rest
}

/** SMI-5964: an unsplittable leaf cursor (`lo === hi`, `bisectFacet` returns null),
 *  the realistic shape of a saturated-and-unbisectable `acceptTruncation` position
 *  (reached in production via repeated bisection of a dense top-level facet). */
export function leafCursor(noProgressStalls?: number): BackfillCursor {
  return {
    path: '',
    facet: '5-5',
    last_page: 0,
    facet_index: 0,
    pending_subranges: [[5, 5]],
    ...(noProgressStalls != null ? { no_progress_stalls: noProgressStalls } : {}),
  }
}

/** SMI-5964: a resume cursor mid-facet-0 at the given `last_page` (a NORMAL,
 *  non-saturated range -- the §1b page-loop twin of {@link leafCursor}). */
export function pageCursor(lastPage: number, noProgressStalls?: number): BackfillCursor {
  return {
    path: '',
    facet: '0-127',
    last_page: lastPage,
    facet_index: 0,
    pending_subranges: [],
    ...(noProgressStalls != null ? { no_progress_stalls: noProgressStalls } : {}),
  }
}
