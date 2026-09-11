/**
 * SMI-6514: parity test for the two divergent copies of
 * `plan-review-skill/agent-prompt.md`, the project copy
 * (`.claude/skills/plan-review-skill/agent-prompt.md`, the strategy
 * submodule) and the global copy (`~/.claude/skills/plan-review-skill/
 * agent-prompt.md`, outside the repo, outside version control, outside the
 * container). The global copy is the one Claude Code actually dispatches for
 * a plan review, so a rubric check landed only in the project copy is
 * installed correctly and never runs. That is the exact defect this issue
 * is about, found inside its own remedy (see the plan's D-10).
 *
 * This is a host-side developer check, not a merge gate: `~/.claude/` is
 * outside the repo and outside the Docker container `audit:standards` runs
 * in, so no CI check can see the global copy. Both `it()`s below skip
 * cleanly when either copy is absent (external contributors; CI runners with
 * no `~/.claude`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Extract the P-N rubric-check IDs a copy of agent-prompt.md actually
 * declares as VP Engineering rubric checks. Not every textual mention of
 * "P-N" counts. A real check is a 4-space-indented bullet
 * (`    - <name> (<...P-N...>): <description>`), the same indentation the
 * VP Engineering Task's own checklist uses. A prose reference such as
 * "a fuller P-1-P-5 rubric this global copy doesn't yet have" (the global
 * copy's own v1.6.0 changelog note) is NOT a declared check and must not
 * count as one. That sentence is literally the drift this test exists to
 * catch, so treating it as evidence of P-5 being present would defeat the
 * test.
 */
export function extractRubricIds(content: string): string[] {
  const ids = new Set<string>()
  for (const line of content.split('\n')) {
    if (!/^ {4}- /.test(line)) continue
    const parenMatch = line.match(/\(([^)]*)\)/)
    if (!parenMatch) continue
    for (const m of parenMatch[1].matchAll(/P-(\d+)/g)) {
      ids.add(`P-${m[1]}`)
    }
  }
  return [...ids].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
}

const RUBRIC_BULLET = (id: string, extra = ''): string =>
  `    - Some check name (${id}${extra}): does the plan do the thing.\n`

describe('extractRubricIds', () => {
  it('extracts a single P-N id from a declared rubric bullet', () => {
    expect(extractRubricIds(RUBRIC_BULLET('P-6'))).toEqual(['P-6'])
  })

  it('extracts multiple ids from one parenthetical (SMI-4454 P-1, P-2 shape)', () => {
    expect(extractRubricIds('    - Surface grounding (SMI-4454 P-1, P-2): text\n')).toEqual([
      'P-1',
      'P-2',
    ])
  })

  it('does NOT count a prose mention of a P-N range outside a 4-space bullet', () => {
    // This is the exact sentence from the real global copy's own changelog.
    // It must not be read as "P-5 is present".
    const prose =
      "  at v1.6.0 with a fuller P-1-P-5 rubric this global copy doesn't yet have). Five\n"
    expect(extractRubricIds(prose)).toEqual([])
  })

  it('sorts numerically, not lexicographically (P-10 after P-9, not before P-2)', () => {
    const content = RUBRIC_BULLET('P-10') + RUBRIC_BULLET('P-2') + RUBRIC_BULLET('P-9')
    expect(extractRubricIds(content)).toEqual(['P-2', 'P-9', 'P-10'])
  })

  it('deduplicates an id declared on more than one bullet', () => {
    const content = RUBRIC_BULLET('P-5') + RUBRIC_BULLET('P-5')
    expect(extractRubricIds(content)).toEqual(['P-5'])
  })
})

// __dirname here is <repo-root>/scripts/tests, so two levels up is repo root
// regardless of vitest's own invocation cwd (matches the convention in
// audit-standards.test.ts and audit-workflow-sha-pin.test.ts). Confirmed live
// (SMI-6514 coordinator finding): a throwing diagnostic test placed at this
// exact path printed __dirname == <repo-root>/scripts/tests, so this half was
// never the bug.
const REPO_ROOT = join(__dirname, '..', '..')
const PROJECT_PATH = join(REPO_ROOT, '.claude/skills/plan-review-skill/agent-prompt.md')

// homedir() is NOT the real $HOME under this repo's vitest run. vitest.setup.ts
// (SMI-6343 Wave 1) redirects $HOME to a fresh per-file mkdtemp sandbox before
// any test module's top-level code runs, so os.homedir() here resolves to a
// sandbox path that was never seeded with a plan-review-skill copy -- making
// GLOBAL_PATH point at a file that can never exist, existsSync() false, and
// the old `it.skipIf(!bothPresent)` skip every run on every machine
// regardless of whether the real global copy exists. Confirmed live: a
// diagnostic test printed homedir() == /var/folders/.../skillsmith-vitest-home-*
// with existsSync(that path's agent-prompt.md) == false, while the SAME test
// printed process.env.SKILLSMITH_TEST_REAL_HOME == /Users/<dev> with
// existsSync() == true against the real global copy. vitest.setup.ts exports
// that env var as "ground truth ... captured BEFORE $HOME is rewritten"
// specifically for callers in this situation -- use it, not homedir(), for
// any path this repo's tests need to resolve against the developer's real
// home. Falls back to homedir() so this file still behaves sanely if it is
// ever run outside this repo's vitest.setup.ts (a bare `node --test`, a
// different harness).
const REAL_HOME = process.env.SKILLSMITH_TEST_REAL_HOME ?? homedir()
const GLOBAL_PATH = join(REAL_HOME, '.claude/skills/plan-review-skill/agent-prompt.md')

const PROJECT_EXISTS = existsSync(PROJECT_PATH)
const GLOBAL_EXISTS = existsSync(GLOBAL_PATH)
const COMPARED_COUNT = [PROJECT_EXISTS, GLOBAL_EXISTS].filter(Boolean).length

// The denominator is baked into the describe/it names (computed once, at
// collection time, before any skip decision) so "compared 2/2" and
// "compared 0/2" read differently even to someone only skimming test names
// in a verbose reporter, an IDE test explorer, or a CI annotation view --
// not just to someone reading a skip note. A silent `it.skipIf` here is what
// let the homedir() bug above hide for this long: a false skip and a true
// skip both rendered as an identical "1 skipped" with no denominator in the
// default (non-verbose) reporter, which prints no per-test detail at all for
// anything that isn't a failure (confirmed live: neither a passing
// `expect()` message, nor a passing test's own console.error, nor a passing
// test's own name, appears under a bare `npx vitest run <file>` -- the exact
// invocation the coordinator used to catch this).
describe(`plan-review rubric parity (project vs global copy, SMI-6514), compared ${COMPARED_COUNT}/2 copies`, () => {
  it(
    `the global copy declares every P-N rubric check the project copy declares ` +
      `(project ${PROJECT_EXISTS ? 'found' : 'MISSING'}, global ${GLOBAL_EXISTS ? 'found' : 'MISSING'})`,
    (ctx) => {
      if (COMPARED_COUNT < 2) {
        const missing = [
          !PROJECT_EXISTS && `project copy missing: ${PROJECT_PATH}`,
          !GLOBAL_EXISTS && `global copy missing: ${GLOBAL_PATH}`,
        ].filter((line): line is string => Boolean(line))
        // Dynamic skip with an explicit reason (vitest TestContext#skip) --
        // shown by --reporter=verbose and by CI test-result viewers that
        // read the skip annotation, unlike a bare `it.skipIf` boolean, which
        // carries no reason at all. This is the legitimate skip path
        // (external contributors; a CI runner with no ~/.claude), never
        // reached on THIS machine now that GLOBAL_PATH resolves correctly.
        ctx.skip(
          `compared ${COMPARED_COUNT}/2 copies, cannot run parity check: ${missing.join('; ')}`
        )
      }

      const projectIds = extractRubricIds(readFileSync(PROJECT_PATH, 'utf8'))
      const globalIds = extractRubricIds(readFileSync(GLOBAL_PATH, 'utf8'))
      const missingFromGlobal = projectIds.filter((id) => !globalIds.includes(id))

      expect(
        missingFromGlobal,
        `Project copy (${PROJECT_PATH}) declares ${JSON.stringify(projectIds)}; ` +
          `global copy (${GLOBAL_PATH}) declares ${JSON.stringify(globalIds)}. ` +
          `A check landed in the project copy alone is installed correctly and never runs, ` +
          `since the global copy is what Claude Code actually dispatches. Port the missing ` +
          `check(s) to the global copy, or record why not (SMI-6514 Open Question 2).`
      ).toEqual([])
    }
  )
})
