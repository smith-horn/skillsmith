/**
 * Tests for the `publish.yml` verify-block byte-identity gate (SMI-6513).
 *
 * **The acceptance bar is specific.** The original SMI-6493 bug survived shellcheck
 * and a fully green suite because coverage only ever exercised block 1. So a suite
 * that merely proves the current file passes would reproduce the original failure
 * exactly. These tests must go RED when drift is injected into block 2, into block 3,
 * and into block 4, each independently — N-1 through N-4 below.
 *
 * **Fixture strategy: no committed snapshot.** Every case starts from the REAL
 * `.github/workflows/publish.yml`, read once and mutated in memory as a string. A
 * committed copy drifts from the real file and the negative cases quietly start
 * testing a museum piece; reading the live file means injected drift is always drift
 * relative to what is shipping.
 *
 * Mutation is surgical, by `(jobId, stepName)` — never by line offset, for the same
 * reason the module itself never uses line numbers.
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  REGISTRY,
  TAIL_MARKER,
  analyzeVerifyBlocks,
  briefDiff,
  normalize,
  notEvaluated,
  reportLines,
  splitAtTailMarker,
} from '../lib/verify-block-identity.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/publish.yml')
const REAL_YAML = fs.readFileSync(WORKFLOW_PATH, 'utf8')

const CORE = { job: 'publish-core', step: 'Verify core on npm' }
const MCP = { job: 'publish-mcp-server', step: 'Verify mcp-server on npm' }
const CLI = { job: 'publish-cli', step: 'Verify cli on npm' }
const WRAPPER = {
  job: 'publish-skillsmith-cli',
  step: 'Verify skillsmith-cli on npm + smoke the wrapper',
}
const ALL_FOUR = [CORE, MCP, CLI, WRAPPER]

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed YAML is untyped
type Workflow = any

// js-yaml via createRequire — the pattern already used by scripts/audit-standards.mjs
// and scripts/audit-host-volume-fs-guard-helpers.mjs. A bare `import ... from 'js-yaml'`
// also works at runtime but has no type declarations in this repo (@types/js-yaml is not
// installed), so it trips TS7016 for anyone who points a typechecker at scripts/.
const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as {
  load: (text: string) => unknown
  dump: (doc: unknown, opts?: Record<string, unknown>) => string
}

function parse(yamlText: string): Workflow {
  return yaml.load(yamlText) as Workflow
}

/**
 * Re-serialize a parsed workflow. `lineWidth: -1` disables folding, and lives HERE
 * rather than at each call site: a folded block scalar silently rewrites `run` bodies,
 * which would make every negative case below test a corrupted fixture. One call site
 * forgetting the option is exactly the kind of invisible failure this suite guards
 * against elsewhere, so it is not something a caller can forget.
 */
function dump(doc: Workflow): string {
  return yaml.dump(doc, { lineWidth: -1, noRefs: true })
}

function findStep(doc: Workflow, jobId: string, stepName: string) {
  const steps = doc.jobs[jobId].steps as Array<{ name?: string; run?: string }>
  const step = steps.find((s) => s.name === stepName)
  if (!step) throw new Error(`fixture error: no step "${stepName}" in job "${jobId}"`)
  return step
}

/** Apply `edit` to one step's `run` body, addressed by (jobId, stepName). */
function mutateStepBody(
  yamlText: string,
  jobId: string,
  stepName: string,
  edit: (body: string) => string
): string {
  const doc = parse(yamlText)
  const step = findStep(doc, jobId, stepName)
  const before = step.run as string
  const after = edit(before)
  if (after === before) {
    throw new Error(`fixture error: edit to "${jobId} :: ${stepName}" changed nothing`)
  }
  step.run = after
  return dump(doc)
}

/** Apply the same edit to every one of the four registered blocks. */
function mutateAll(yamlText: string, edit: (body: string) => string): string {
  return ALL_FOUR.reduce((acc, b) => mutateStepBody(acc, b.job, b.step, edit), yamlText)
}

function renameStep(yamlText: string, jobId: string, from: string, to: string): string {
  const doc = parse(yamlText)
  findStep(doc, jobId, from).name = to
  return dump(doc)
}

function moveStep(yamlText: string, fromJob: string, toJob: string, stepName: string): string {
  const doc = parse(yamlText)
  const steps = doc.jobs[fromJob].steps as Array<{ name?: string }>
  const idx = steps.findIndex((s) => s.name === stepName)
  if (idx < 0) throw new Error(`fixture error: no step "${stepName}" in "${fromJob}"`)
  const [step] = steps.splice(idx, 1)
  doc.jobs[toJob].steps.push(step)
  return dump(doc)
}

/** Append a second step with the SAME name but a different body. */
function duplicateStep(yamlText: string, jobId: string, stepName: string): string {
  const doc = parse(yamlText)
  const original = findStep(doc, jobId, stepName)
  doc.jobs[jobId].steps.push({
    name: stepName,
    run: `${original.run as string}\necho "drifted duplicate"`,
  })
  return dump(doc)
}

function addStep(yamlText: string, jobId: string, name: string, run: string): string {
  const doc = parse(yamlText)
  doc.jobs[jobId].steps = doc.jobs[jobId].steps ?? []
  doc.jobs[jobId].steps.push({ name, run })
  return dump(doc)
}

function codesOf(result: { findings: Array<{ code: string }> }): string[] {
  return result.findings.map((f) => f.code)
}

/** The raw `run` body of the wrapper block, straight from the real file. */
function rawWrapperBody(yamlText = REAL_YAML): string {
  return findStep(parse(yamlText), WRAPPER.job, WRAPPER.step).run as string
}

function stripWholeLineComments(body: string): string {
  return body
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
}

const indentAll = (body: string) =>
  body
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')

// ---------------------------------------------------------------------------
// Harness self-test — the fixtures must be trustworthy before anything else
// ---------------------------------------------------------------------------

describe('fixture harness', () => {
  it('round-trips every verify body through parse -> dump without altering it', () => {
    // If dump folded a block scalar, every negative case below would be testing a
    // corrupted body and the suite's greenness would mean nothing.
    const before = parse(REAL_YAML)
    const after = parse(dump(before))
    for (const b of ALL_FOUR) {
      expect(findStep(after, b.job, b.step).run).toBe(findStep(before, b.job, b.step).run)
    }
  })

  it('re-dumping the untouched workflow still passes the check', () => {
    // Re-dumping rewrites YAML formatting throughout; the check must be indifferent.
    const result = analyzeVerifyBlocks(dump(parse(REAL_YAML)))
    expect(result.findings).toEqual([])
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Ordering tests — the marker invariant
// ---------------------------------------------------------------------------

describe('tail-marker ordering invariant', () => {
  it('T-ORDER-1: splitting AFTER comment-stripping loses the boundary', () => {
    // This is the test that locks the pipeline order. The marker is a whole-line
    // comment, so normalizing first destroys it. If someone reorders the pipeline to
    // normalize before splitting, this goes red with a named code instead of the
    // boundary silently vanishing.
    const stripped = stripWholeLineComments(rawWrapperBody())
    expect(stripped).not.toContain(TAIL_MARKER)

    const result = splitAtTailMarker(stripped)
    expect(result.ok).toBe(false)
    expect((result as { code: string }).code).toBe('VB-TAIL-MARKER-MISSING')
  })

  it('T-ORDER-2: splitting the raw body puts the smoke tail on the right side', () => {
    const result = splitAtTailMarker(rawWrapperBody())
    expect(result.ok).toBe(true)
    const { head, tail } = result as { head: string; tail: string }

    const firstTailLine = tail.split('\n').find((l) => l.trim().length > 0)
    expect(firstTailLine?.trim()).toBe('SMOKE_DIR="$(mktemp -d)"')
    expect(head).not.toContain('SMOKE_DIR')
    // The head keeps the registry verification, including its explicit failure path.
    expect(head).toContain('npm view')
    expect(head).toContain('exit 1')
  })

  it('matches the marker only as a whole trimmed line', () => {
    const cases: Array<[string, boolean]> = [
      [TAIL_MARKER, true],
      [`  ${TAIL_MARKER}`, true],
      [`      ${TAIL_MARKER}   `, true],
      [`SMOKE_DIR=x ${TAIL_MARKER}`, false],
      [`#${TAIL_MARKER}`, false],
      [`${TAIL_MARKER}-v2`, false],
      ['# audit:carveout-pure-js', false],
    ]
    for (const [line, shouldMatch] of cases) {
      const body = `echo before\n${line}\necho after`
      expect(splitAtTailMarker(body).ok, `line: ${JSON.stringify(line)}`).toBe(shouldMatch)
    }
  })
})

// ---------------------------------------------------------------------------
// Positive cases — must PASS
// ---------------------------------------------------------------------------

describe('positive cases', () => {
  it('P-1: the real, unmutated publish.yml passes', () => {
    const result = analyzeVerifyBlocks(REAL_YAML)
    expect(result.findings).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.status).toBe('passed')
    expect(result.comparedBlocks).toBe(4)
    expect(result.expectedBlocks).toBe(4)
  })

  it('P-2: whitespace, blank lines and comments in block 3 are tolerated', () => {
    const mutated = mutateStepBody(REAL_YAML, CLI.job, CLI.step, (body) =>
      [indentAll(body), '', '# a newly added whole-line comment', '   '].join('\n')
    )
    expect(analyzeVerifyBlocks(mutated).findings).toEqual([])
  })

  it('P-3: the same formatting edits applied to block 4 are tolerated', () => {
    // Block 4 additionally goes through the marker split and R1/R2/R3, so it must be
    // equally formatting-insensitive — including the marker line itself being indented.
    const mutated = mutateStepBody(REAL_YAML, WRAPPER.job, WRAPPER.step, (body) =>
      [indentAll(body), '', '# another added comment'].join('\n')
    )
    expect(analyzeVerifyBlocks(mutated).findings).toEqual([])
  })

  it('P-4: a real fix propagated to all four needs no baseline bump', () => {
    const mutated = mutateAll(REAL_YAML, (b) =>
      b.replace('VERIFY_MAX_ATTEMPTS=30', 'VERIFY_MAX_ATTEMPTS=40')
    )
    expect(analyzeVerifyBlocks(mutated).findings).toEqual([])
  })

  it('P-5: rewording a comment inside block 4 tail does not bump the pinned digest', () => {
    const mutated = mutateStepBody(REAL_YAML, WRAPPER.job, WRAPPER.step, (b) =>
      b.replace(
        '# SMI-6493: if the verify loop above took the slow path (a high attempt',
        '# SMI-6493: reworded comment text that says the same thing differently'
      )
    )
    expect(analyzeVerifyBlocks(mutated).findings).toEqual([])
  })

  it('P-6: no enterprise verify block exists, and none is registered', () => {
    // SMI-6498's scope, deliberately untouched here. Asserted so a future refactor
    // cannot quietly change it without this test noticing.
    expect(REGISTRY.map((r) => r.jobId)).not.toContain('publish-enterprise')
    const doc = parse(REAL_YAML)
    const enterpriseSteps = (doc.jobs['publish-enterprise'].steps ?? []) as Array<{
      name?: string
    }>
    expect(enterpriseSteps.filter((s) => /^Verify\b.*\bon npm\b/.test(s.name ?? ''))).toEqual([])
  })

  it('P-7: `Verify dependencies` is present and correctly ignored', () => {
    // Pins the discovery predicate against the loosening trap: a bare /Verify/ would
    // match this unrelated step and the "exactly these four" assertion would misfire.
    const doc = parse(REAL_YAML)
    const names = (doc.jobs['pre-publish-check'].steps as Array<{ name?: string }>).map(
      (s) => s.name
    )
    expect(names).toContain('Verify dependencies')
    expect(analyzeVerifyBlocks(REAL_YAML).findings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Negative cases — must FAIL with the named code
// ---------------------------------------------------------------------------

describe('negative cases: per-block drift (the four that answer the original bug)', () => {
  it('N-1: drift in block 2 only', () => {
    const mutated = mutateStepBody(REAL_YAML, MCP.job, MCP.step, (b) =>
      b.replace('VERIFY_MAX_ATTEMPTS=30', 'VERIFY_MAX_ATTEMPTS=5')
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-SCOPED-DIGEST-MISMATCH')
    expect(result.findings.some((f) => f.step === MCP.step)).toBe(true)
  })

  it('N-2: drift in block 3 only', () => {
    const mutated = mutateStepBody(REAL_YAML, CLI.job, CLI.step, (b) =>
      b.replace(
        '--prefer-offline=false --registry=https://registry.npmjs.org 2>/dev/null',
        '--registry=https://registry.npmjs.org 2>/dev/null'
      )
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-SCOPED-DIGEST-MISMATCH')
    expect(result.findings.some((f) => f.step === CLI.step)).toBe(true)
  })

  it('N-3: drift in block 4 final probe only', () => {
    const mutated = mutateStepBody(REAL_YAML, WRAPPER.job, WRAPPER.step, (b) =>
      b.replace(' --registry=https://registry.npmjs.org) || true', ') || true')
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-BLOCK4-MISMATCH')
  })

  it('N-4: block 4 gains an UNRELATED difference', () => {
    // The case a "skip block 4" implementation cannot catch, and the reason Stage 3 is
    // a forward rewrite rather than an exclusion.
    const mutated = mutateStepBody(REAL_YAML, WRAPPER.job, WRAPPER.step, (b) =>
      b.replace('VERIFY_INTERVAL=10', 'VERIFY_INTERVAL=10\nsleep 2')
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-BLOCK4-MISMATCH')
  })
})

describe('negative cases: tail region', () => {
  it('N-5: tail drift bumps the pinned digest', () => {
    const mutated = mutateStepBody(REAL_YAML, WRAPPER.job, WRAPPER.step, (b) =>
      b.replace('for attempt in 1 2 3; do', 'for attempt in 1 2; do')
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-BLOCK4-TAIL-DRIFT')
  })

  it('N-11: the tail marker is deleted', () => {
    const mutated = mutateStepBody(REAL_YAML, WRAPPER.job, WRAPPER.step, (b) =>
      b
        .split('\n')
        .filter((l) => l.trim() !== TAIL_MARKER)
        .join('\n')
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-TAIL-MARKER-MISSING')
  })

  it('N-12: a second tail marker makes the boundary ambiguous', () => {
    const mutated = mutateStepBody(REAL_YAML, WRAPPER.job, WRAPPER.step, (b) =>
      b.replace('VERIFY_INTERVAL=10', `${TAIL_MARKER}\nVERIFY_INTERVAL=10`)
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-TAIL-MARKER-DUPLICATE')
  })

  it('N-18: the tail gains a registry probe', () => {
    const mutated = mutateStepBody(REAL_YAML, WRAPPER.job, WRAPPER.step, (b) =>
      b.replace('SMOKE_DIR="$(mktemp -d)"', 'npm view foo version\nSMOKE_DIR="$(mktemp -d)"')
    )
    expect(codesOf(analyzeVerifyBlocks(mutated))).toContain('VB-TAIL-CONTAINS-PROBE')
  })

  it('N-19: the tail gains an explicit exit 1', () => {
    const mutated = mutateStepBody(REAL_YAML, WRAPPER.job, WRAPPER.step, (b) =>
      b.replace('SMOKE_DIR="$(mktemp -d)"', 'SMOKE_DIR="$(mktemp -d)" || exit 1')
    )
    expect(codesOf(analyzeVerifyBlocks(mutated))).toContain('VB-TAIL-CONTAINS-PROBE')
  })
})

describe('negative cases: structural / identity', () => {
  it('N-6: a step renamed out from under the check', () => {
    const mutated = renameStep(REAL_YAML, CLI.job, CLI.step, 'Verify cli package on npm')
    const codes = codesOf(analyzeVerifyBlocks(mutated))
    expect(codes).toContain('VB-UNREGISTERED-VERIFY-STEP')
    expect(codes).toContain('VB-MISSING-STEP')
  })

  it('N-9: an unregistered fifth verify step (the case SMI-6498 will hit)', () => {
    const mutated = addStep(
      REAL_YAML,
      'publish-enterprise',
      'Verify enterprise on npm',
      'echo "an arbitrary body"'
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-UNREGISTERED-VERIFY-STEP')
  })

  it('N-13: two steps sharing a registered name', () => {
    // The key set still has four members, so a name-keyed map would look correct while
    // silently comparing the drifted body. This must not pass.
    const mutated = duplicateStep(REAL_YAML, CLI.job, CLI.step)
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-DUPLICATE-STEP')
  })

  it('N-14: a verify step relocated to another job', () => {
    const mutated = moveStep(REAL_YAML, CLI.job, WRAPPER.job, CLI.step)
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    const wrongJob = result.findings.find((f) => f.code === 'VB-WRONG-JOB')
    expect(wrongJob).toBeDefined()
    expect(wrongJob?.message).toContain(CLI.job)
    expect(wrongJob?.message).toContain(WRAPPER.job)
  })

  it('N-10: YAML with no `jobs:` mapping', () => {
    const result = analyzeVerifyBlocks('name: nothing\non: push\n')
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-PARSE-ERROR')
  })

  it('N-10b: unparseable YAML never silently passes', () => {
    const result = analyzeVerifyBlocks('jobs: [unclosed\n  : : :\n')
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-PARSE-ERROR')
  })

  it('N-17: an empty `run` body', () => {
    const doc = parse(REAL_YAML)
    findStep(doc, CLI.job, CLI.step).run = ''
    const result = analyzeVerifyBlocks(dump(doc))
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-PARSE-ERROR')
  })
})

describe('negative cases: normalization guards', () => {
  it('N-7: restructuring the canonical block invalidates the R3 fragment', () => {
    // Applied identically to all four, so Stage 2 still agrees — only R3 notices.
    const mutated = mutateAll(REAL_YAML, (b) =>
      b.replace(
        'for attempt in $(seq 1 "$VERIFY_MAX_ATTEMPTS"); do',
        'attempt=0\nwhile [ "$attempt" -lt "$VERIFY_MAX_ATTEMPTS" ]; do\nattempt=$((attempt + 1))'
      )
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-R3-FRAGMENT-LOST')
  })

  it('N-8: a new non-ASCII glyph without an R2 table entry', () => {
    // Propagated to blocks 1-3 so Stage 2 still agrees; only the R2 precondition fires.
    const mutated = [CORE, MCP, CLI].reduce(
      (acc, b) => mutateStepBody(acc, b.job, b.step, (body) => body.split('✓').join('»')),
      REAL_YAML
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    const finding = result.findings.find((f) => f.code === 'VB-NON-ASCII-UNMAPPED')
    expect(finding).toBeDefined()
    expect(finding?.message).toContain('U+00BB') // the codepoint is named, not just "non-ASCII"
  })

  it('N-15: a package name that does not occur in its own body', () => {
    const mutated = mutateStepBody(REAL_YAML, CORE.job, CORE.step, (b) =>
      b.split('@skillsmith/core').join('@skillsmith/kore')
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-SUBSTITUTION-COUNT')
  })

  it('N-16: a sentinel literal already present in a body', () => {
    const mutated = mutateStepBody(REAL_YAML, CORE.job, CORE.step, (b) =>
      b.replace('VERIFY_INTERVAL=10', 'VERIFY_INTERVAL=10\necho "__PKG__"')
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-SENTINEL-COLLISION')
  })

  it('N-20: the masking limitation is pinned, not accidental', () => {
    // Documented, accepted behaviour: a package name inside an unrelated token is
    // substituted too, so two different tokens normalize identically. Pinned here so
    // it cannot change silently — if this ever goes red, the invariant changed.
    const a = normalize(
      'echo prefix-skillsmith-cli-suffix',
      'skillsmith-cli',
      'packages/skillsmith-cli/package.json'
    ).text
    const b = normalize('echo prefix-OTHERNAME-suffix', 'OTHERNAME', 'irrelevant/path.json').text
    expect(a).toBe('echo prefix-__PKG__-suffix')
    expect(a).toBe(b)
  })

  it('substitutes the manifest path BEFORE the package name', () => {
    // Reversing the order yields `packages/__PKG__/package.json` and a permanent,
    // unfixable digest mismatch that looks like real drift. Pinned explicitly because
    // the failure it guards is a silent one.
    const out = normalize(
      'VERSION=$(jq -r .version packages/skillsmith-cli/package.json)',
      'skillsmith-cli',
      'packages/skillsmith-cli/package.json'
    )
    expect(out.text).toBe('VERSION=$(jq -r .version __MANIFEST__)')
    expect(out.text).not.toContain('packages/__PKG__')
    expect(out.manifestCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The three-way outcome, and the coverage denominator
// ---------------------------------------------------------------------------

describe('three-way outcome', () => {
  it('reports `passed` only when everything was actually compared', () => {
    const result = analyzeVerifyBlocks(REAL_YAML)
    expect(result.status).toBe('passed')
    expect(result.ok).toBe(true)
    expect(result.comparedBlocks).toBe(result.expectedBlocks)
    expect(result.notEvaluatedReason).toBeNull()
  })

  it('reports `failed` — distinct from not-evaluated — on real drift', () => {
    const mutated = mutateStepBody(REAL_YAML, MCP.job, MCP.step, (b) =>
      b.replace('VERIFY_MAX_ATTEMPTS=30', 'VERIFY_MAX_ATTEMPTS=5')
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.status).toBe('failed')
    expect(result.ok).toBe(false)
  })

  it('reports `not_evaluated` — and never ok:true — when the check could not run', () => {
    const result = notEvaluated('ENOENT: .github/workflows/publish.yml is missing')
    expect(result.status).toBe('not_evaluated')
    expect(result.ok).toBe(false) // the whole point: a check that could not run is not a pass
    expect(result.comparedBlocks).toBe(0)
    expect(result.expectedBlocks).toBe(4)
    expect(codesOf(result)).toEqual(['VB-NOT-EVALUATED'])
    expect(result.notEvaluatedReason).toContain('ENOENT')
  })

  it('renders all three outcomes distinguishably', () => {
    const passed = reportLines(analyzeVerifyBlocks(REAL_YAML))
    const failed = reportLines(analyzeVerifyBlocks('name: x\non: push\n'))
    const skipped = reportLines(notEvaluated('docker not running'))

    expect(passed.lines[0]).toContain('PASSED')
    expect(failed.lines[0]).toContain('FAILED')
    expect(skipped.lines[0]).toContain('NOT EVALUATED')

    // A not-evaluated run must never read as a pass to a human skimming CI output.
    expect(skipped.lines.join('\n')).not.toContain('PASSED')
    expect(skipped.lines.join('\n')).toContain('not a pass')

    // Every headline carries the coverage fraction, so a scope-blind clean run does
    // not read identically to a real one.
    for (const r of [passed, failed, skipped]) {
      expect(r.lines[0]).toMatch(/\d+\/\d+ verify block\(s\) compared/)
    }
  })
})

describe('diagnostic rendering', () => {
  it('names the differing lines, with both labels', () => {
    const diff = briefDiff('same\nalpha\ntail', 'same\nbeta\ntail', 'left', 'right')
    expect(diff).toContain('- [left] alpha')
    expect(diff).toContain('+ [right] beta')
    // The common prefix/suffix is trimmed, so a reader sees only what changed.
    expect(diff).not.toContain('same')
  })

  it('falls back to a readable message when the lines are identical', () => {
    // Defensive branch: unreachable via analyzeVerifyBlocks (normalized bodies with
    // differing digests always differ by a line), but it must not render as an empty
    // string if a future caller passes non-normalized text.
    expect(briefDiff('same', 'same', 'a', 'b')).toContain('no line-level difference')
  })

  it('caps a very large diff instead of flooding the CI log', () => {
    const a = Array.from({ length: 60 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 60 }, (_, i) => `b${i}`).join('\n')
    const diff = briefDiff(a, b, 'a', 'b', 10)
    expect(diff.split('\n')).toHaveLength(11) // 10 shown + 1 summary line
    expect(diff).toContain('further differing line(s) not shown')
  })
})

describe('coverage denominator (SMI-6591 class: never drop a block silently)', () => {
  it('a block that cannot be parsed leaves the denominator intact and fails', () => {
    // The failure this guards: reporting "all identical" after comparing three of four.
    const doc = parse(REAL_YAML)
    findStep(doc, MCP.job, MCP.step).run = ''
    const result = analyzeVerifyBlocks(dump(doc))

    expect(result.expectedBlocks).toBe(4)
    expect(result.comparedBlocks).toBeLessThan(4)
    expect(codesOf(result)).toContain('VB-COVERAGE-SHORTFALL')
    expect(result.ok).toBe(false)
  })

  it('a block dropped at the marker split is also counted as not compared', () => {
    const mutated = mutateStepBody(REAL_YAML, WRAPPER.job, WRAPPER.step, (b) =>
      b
        .split('\n')
        .filter((l) => l.trim() !== TAIL_MARKER)
        .join('\n')
    )
    const result = analyzeVerifyBlocks(mutated)
    expect(result.comparedBlocks).toBe(3)
    expect(codesOf(result)).toContain('VB-COVERAGE-SHORTFALL')
  })

  it('a missing canonical block does not silently take the tail checks down too', () => {
    // Regression guard: the R1 tail checks must not be nested under Stage 3's
    // `canon && reshaped` precondition.
    const mutated = renameStep(REAL_YAML, CORE.job, CORE.step, 'Verify core package on npm')
    const withTailDrift = mutateStepBody(mutated, WRAPPER.job, WRAPPER.step, (b) =>
      b.replace('for attempt in 1 2 3; do', 'for attempt in 1 2; do')
    )
    const result = analyzeVerifyBlocks(withTailDrift)
    expect(codesOf(result)).toContain('VB-BLOCK4-TAIL-DRIFT')
  })

  it('tolerates a job with no `steps:` key without crashing', () => {
    // A degraded/partial workflow must produce findings, never an exception — an
    // exception in the audit caller would take the whole run down (the SMI-6520 class).
    const doc = parse(REAL_YAML)
    doc.jobs['a-job-with-no-steps'] = { 'runs-on': 'ubuntu-latest' }
    const result = analyzeVerifyBlocks(dump(doc))
    expect(result.findings).toEqual([])
    expect(result.comparedBlocks).toBe(4)
  })

  it('with only one usable block, compares nothing and says so', () => {
    // The degenerate end of the denominator rule: with nothing to compare against, the
    // honest answer is 0 compared — never "no mismatches found, therefore identical".
    const doc = parse(REAL_YAML)
    for (const b of [CORE, MCP, CLI]) findStep(doc, b.job, b.step).run = ''
    const result = analyzeVerifyBlocks(dump(doc))

    expect(result.comparedBlocks).toBe(0)
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('VB-COVERAGE-SHORTFALL')
    expect(codesOf(result).filter((c) => c === 'VB-PARSE-ERROR')).toHaveLength(3)
    expect(codesOf(result)).not.toContain('VB-SCOPED-DIGEST-MISMATCH')
  })

  it('renders a finding that carries only one half of the identity pair', () => {
    const rendered = reportLines({
      status: 'failed',
      ok: false,
      expectedBlocks: 4,
      comparedBlocks: 3,
      notEvaluatedReason: null,
      findings: [
        { code: 'VB-SYNTH-A', job: null, step: 'Verify cli on npm', message: 'x' },
        { code: 'VB-SYNTH-B', job: 'publish-cli', step: null, message: 'y' },
      ],
    })
    const text = rendered.lines.join('\n')
    expect(text).toContain('[? :: Verify cli on npm]')
    expect(text).toContain('[publish-cli :: ?]')
  })

  it('every registered block is reachable — no registration is dead', () => {
    // If a registered (jobId, stepName) pair stopped matching the discovery predicate,
    // it would silently never be compared. comparedBlocks === 4 on the real file is
    // what proves all four registrations are live.
    expect(REGISTRY).toHaveLength(4)
    expect(analyzeVerifyBlocks(REAL_YAML).comparedBlocks).toBe(4)
  })
})
