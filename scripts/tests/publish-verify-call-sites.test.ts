/**
 * SMI-6497: the two-class registry contract for `publish.yml`'s verify call sites.
 *
 * This file is the LIVE replacement artifact for the retired
 * `scripts/lib/verify-block-identity.mjs` gate. Its existence is exactly
 * equivalent to "SMI-6497 has landed" -- SMI-6498's Step 0 keys off that.
 *
 * Parsing is `js-yaml` DIRECTLY, never `scripts/tests/_lib/workflow-yaml.ts`:
 * that helper's only export is `extractStep(yaml, stepName)`, which takes no
 * job id and resolves by first whole-file match, so it cannot express two of
 * this contract's own failure modes (VB-WRONG-JOB, VB-DUPLICATE-STEP).
 *
 * Lookup uses filter-plus-length, never `find`. `find` is precisely what makes
 * a duplicate invisible.
 *
 * Every negative case below was driven RED by removing the clause it exists to
 * enforce. An assertion never observed failing is not evidence of anything.
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load: (text: string) => unknown }

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/publish.yml')

// --------------------------------------------------------------------------
// The registry. Two classes, exact sets.
// --------------------------------------------------------------------------

interface Entry {
  job: string
  step: string
  pkg: string
  manifest: string
}

/** class `helper-call` -- all bodies must be the canonical two-line call shape. */
const HELPER_CALL_ENTRIES: Entry[] = [
  {
    job: 'publish-core',
    step: 'Verify core on npm',
    pkg: '@skillsmith/core',
    manifest: 'packages/core/package.json',
  },
  {
    job: 'publish-mcp-server',
    step: 'Verify mcp-server on npm',
    pkg: '@skillsmith/mcp-server',
    manifest: 'packages/mcp-server/package.json',
  },
  {
    job: 'publish-cli',
    step: 'Verify cli on npm',
    pkg: '@skillsmith/cli',
    manifest: 'packages/cli/package.json',
  },
  {
    job: 'publish-skillsmith-cli',
    // POST-SPLIT name. The plan's fenced contract carries the pre-split
    // "... on npm + smoke the wrapper" only because that fence is held
    // byte-identical with SMI-6498's copy; the rename is this plan's edit.
    step: 'Verify skillsmith-cli on npm',
    pkg: 'skillsmith-cli',
    manifest: 'packages/skillsmith-cli/package.json',
  },
]

const ENTERPRISE_JOB = 'publish-enterprise'

/**
 * class `independent` -- identity + discovery only, EXCLUDED from body
 * equality and from the canonical call shape, NOT excluded from the parse
 * guard.
 *
 * Deliberately EMPTY: its sole entry
 * (publish-enterprise, Verify enterprise on npm (GitHub Packages)) is created
 * by SMI-6498, which has not landed. Re-derived live at implementation time:
 * `publish-enterprise` owns eight steps and none matches the verify-name
 * predicate. The machinery ships from day one so SMI-6498's addition is a data
 * change, not a redesign; because no live entry exercises it, it is exercised
 * by the synthetic fixtures in `describe('independent class')` below.
 */
const INDEPENDENT_ENTRIES: Entry[] = []

/** The `independent` fixture entry -- SMI-6498's shape, not yet in the workflow. */
const ENTERPRISE_ENTRY: Entry = {
  job: ENTERPRISE_JOB,
  step: 'Verify enterprise on npm (GitHub Packages)',
  pkg: '@smith-horn/enterprise',
  manifest: 'packages/enterprise/package.json',
}

/**
 * Arm B exemptions and the `independent` class are two sides of ONE fact:
 * an empty class REQUIRES the exemption; a non-empty class FORBIDS it.
 * This function is what makes SMI-6498's "deletes the exemption in the same
 * commit that adds the entry" machine-checked rather than hoped for.
 */
function expectedArmBExemptions(independent: Entry[]): string[] {
  return independent.some((e) => e.job === ENTERPRISE_JOB) ? [] : [ENTERPRISE_JOB]
}

/** Cites SMI-6498: `publish-enterprise` publishes and owns no verification step of any kind. */
const ARM_B_EXEMPT_JOBS: string[] = [ENTERPRISE_JOB]

/**
 * Pre-publish probes. Re-derived live (not copied): six steps run
 * `npm view|info|dist-tag`, every one of them BEFORE its publish rather than
 * verifying one. A new publish job adds a row here.
 */
const PROBE_ALLOWLIST: Array<{ job: string; step: string }> = [
  { job: 'pre-publish-check', step: 'Check version availability' },
  { job: 'publish-core', step: 'Check if version already published' },
  { job: 'publish-mcp-server', step: 'Check if version already published' },
  { job: 'publish-cli', step: 'Check if version already published' },
  { job: 'publish-skillsmith-cli', step: 'Check if version already published' },
  { job: ENTERPRISE_JOB, step: 'Check if version already published' },
]

const HELPER_PATH = 'scripts/ci/verify-npm-publish.sh'
const MARKER = '# audit:publish-verify-step'
const MARKER_RE = /^[ \t]*# audit:publish-verify-step[ \t]*$/m
const VERIFY_NAME_RE = /^Verify\b.*\bon npm\b/
const PROBE_RE = /\bnpm\s+(view|info|dist-tag)\b/
const PUBLISH_RE = /npm publish/

/** The substitution's own constants. Assertion 2 rejects a raw body carrying either. */
const PKG_SENTINEL = '__SMI6497_PKG__'
const MANIFEST_SENTINEL = '__SMI6497_MANIFEST__'
const SENTINELS = [PKG_SENTINEL, MANIFEST_SENTINEL]

// --------------------------------------------------------------------------
// The checker
// --------------------------------------------------------------------------

interface StepNode {
  name?: unknown
  run?: unknown
}
interface Options {
  independent?: Entry[]
  armBExempt?: string[]
  /** DS-1 only: keys removed from BOTH comparison loops, simulating a dropped entry. */
  dropEntries?: string[]
}
interface Result {
  codes: string[]
  findings: string[]
  bodyEqualityCompared: number
  callShapeCompared: number
  helperCallRegistered: number
}

const keyOf = (v: { job: string; step: string }): string => `${v.job}::${v.step}`

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function typeName(v: unknown): string {
  if (v === undefined) return 'absent'
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'a list'
  return `a ${typeof v}`
}

/** Strips whole-line comments and trims. Arm C reads the RAW body, never this. */
function normalize(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .join('\n')
}

/** The canonical call shape, rendered per entry. Manifest first, then package. */
function renderCanonical(e: Entry): string {
  return `VERSION=$(jq -r .version ${e.manifest})\nbash ${HELPER_PATH} '${e.pkg}' "$VERSION"`
}

function analyze(doc: unknown, opts: Options = {}): Result {
  const independent = opts.independent ?? INDEPENDENT_ENTRIES
  const armBExempt = opts.armBExempt ?? ARM_B_EXEMPT_JOBS
  const dropped = new Set(opts.dropEntries ?? [])
  const registered = [...HELPER_CALL_ENTRIES, ...independent]
  const findings: string[] = []
  const add = (code: string, detail: string): void => {
    findings.push(`${code}: ${detail}`)
  }
  const result = (body = 0, shape = 0): Result => ({
    codes: findings.map((x) => x.slice(0, x.indexOf(':'))),
    findings,
    bodyEqualityCompared: body,
    callShapeCompared: shape,
    helperCallRegistered: HELPER_CALL_ENTRIES.length,
  })

  // --- Parse guard (VB-PARSE-ERROR), FIRST, over BOTH classes. Never a bare
  // --- throw, and never a VB-MISSING-STEP standing in for a malformed file.
  const jobs = isRecord(doc) ? doc.jobs : undefined
  if (!isRecord(jobs)) {
    add('VB-PARSE-ERROR', `jobs: is ${typeName(jobs)} (expected a mapping)`)
    return result()
  }
  const jobSteps = new Map<string, StepNode[]>()
  for (const [id, job] of Object.entries(jobs)) {
    const raw = isRecord(job) ? job.steps : undefined
    if (raw !== undefined && !Array.isArray(raw)) {
      add('VB-PARSE-ERROR', `job ${id}: steps: is ${typeName(raw)} (expected a list)`)
      continue
    }
    jobSteps.set(id, (Array.isArray(raw) ? raw : []).filter(isRecord) as StepNode[])
  }
  if (findings.length > 0) return result()

  // filter + length, never `find`: a duplicate must stay visible.
  const lookup = (job: string, step: string): StepNode[] =>
    (jobSteps.get(job) ?? []).filter((s) => s.name === step)
  const resolved = new Map<string, string>()
  for (const e of registered) {
    const hits = lookup(e.job, e.step)
    if (hits.length !== 1) continue // absent/duplicate is a discovery finding, not a parse error
    const run = hits[0].run
    const where = `${e.job} :: ${e.step}`
    if (typeof run !== 'string') {
      add('VB-PARSE-ERROR', `${where}: run: is ${typeName(run)} (expected a string)`)
    } else if (run.trim() === '') {
      add('VB-PARSE-ERROR', `${where}: run: is empty`)
    } else if (normalize(run) === '') {
      add('VB-PARSE-ERROR', `${where}: run: is empty after normalization (comment-only body)`)
    } else {
      resolved.set(keyOf(e), run)
    }
  }
  if (findings.length > 0) return result()

  // --- Assertion 2: the sentinel, on the RAW body, BEFORE any substitution.
  for (const e of registered) {
    const run = resolved.get(keyOf(e))
    if (run === undefined) continue
    for (const token of SENTINELS) {
      if (run.includes(token)) {
        add(
          'VB-SENTINEL-COLLISION',
          `${e.job} :: ${e.step} raw body already contains the sentinel ${token}`
        )
      }
    }
  }

  // --- Arm A: discovery by name, plus the four failure modes.
  const candidates: Array<{ job: string; step: string }> = []
  for (const [id, steps] of jobSteps) {
    for (const s of steps) {
      if (typeof s.name === 'string' && VERIFY_NAME_RE.test(s.name))
        candidates.push({ job: id, step: s.name })
    }
  }
  const registeredKeys = new Set(registered.map(keyOf))
  const registeredNames = new Set(registered.map((e) => e.step))

  const seen = new Set<string>()
  for (const c of candidates) {
    const key = keyOf(c)
    if (seen.has(key)) continue
    seen.add(key)
    const n = candidates.filter((x) => keyOf(x) === key).length
    if (n > 1) add('VB-DUPLICATE-STEP', `${c.job} :: ${c.step} appears ${n} times in that job`)
  }
  for (const e of registered) {
    if (candidates.filter((c) => c.job === e.job && c.step === e.step).length > 0) continue
    const elsewhere = candidates.filter((c) => c.step === e.step && c.job !== e.job)
    if (elsewhere.length > 0) {
      add(
        'VB-WRONG-JOB',
        `${e.step} is registered under ${e.job} but found in ${elsewhere.map((x) => x.job).join(', ')}`
      )
    } else {
      add('VB-MISSING-STEP', `${e.job} :: ${e.step} is registered but not present`)
    }
  }
  for (const c of candidates) {
    if (registeredKeys.has(keyOf(c))) continue
    if (registeredNames.has(c.step)) continue // already diagnosed as VB-WRONG-JOB
    add(
      'VB-UNREGISTERED-VERIFY-STEP',
      `${c.job} :: ${c.step} matches the verify-name predicate but is not registered`
    )
  }

  // --- Arm B: key off JOBS, never steps. `publish-mcp-server :: Annotate
  // --- registry publish failure` is a live step-level false positive (six
  // --- steps match `npm publish`, five jobs do); job-keying is immune.
  for (const [id, steps] of jobSteps) {
    if (!steps.some((s) => typeof s.run === 'string' && PUBLISH_RE.test(s.run))) continue
    if (armBExempt.includes(id)) continue
    if (registered.some((e) => e.job === id)) continue
    add('VB-UNCOVERED-PUBLISH-JOB', `${id} runs npm publish but owns no registered verify step`)
  }

  // --- Arm C: markers, read from the RAW body (normalization drops comments).
  const marked: Array<{ job: string; step: string }> = []
  for (const [id, steps] of jobSteps) {
    for (const s of steps) {
      if (typeof s.run === 'string' && typeof s.name === 'string' && MARKER_RE.test(s.run)) {
        marked.push({ job: id, step: s.name })
      }
    }
  }
  const markedKeys = new Set(marked.map(keyOf))
  for (const e of registered) {
    if (!markedKeys.has(keyOf(e)))
      add('VB-UNMARKED-REGISTERED-STEP', `${e.job} :: ${e.step} carries no \`${MARKER}\` line`)
  }
  for (const m of marked) {
    if (!registeredKeys.has(keyOf(m))) {
      add(
        'VB-UNREGISTERED-MARKED-STEP',
        `${m.job} :: ${m.step} carries the marker but is not registered`
      )
    }
  }
  // Backstop. The "or invokes the shared helper" clause is load-bearing: after
  // extraction the four call sites no longer contain `npm view`, so a backstop
  // that only knew `npm view` would go silent on exactly the steps it polices.
  const allow = new Set(PROBE_ALLOWLIST.map(keyOf))
  for (const [id, steps] of jobSteps) {
    for (const s of steps) {
      if (typeof s.run !== 'string' || typeof s.name !== 'string') continue
      if (!PROBE_RE.test(s.run) && !s.run.includes(HELPER_PATH)) continue
      const key = `${id}::${s.name}`
      if (markedKeys.has(key) || allow.has(key)) continue
      add(
        'VB-UNMARKED-PROBE',
        `${id} :: ${s.name} probes the registry or calls ${HELPER_PATH}, unmarked and not allow-listed`
      )
    }
  }

  // --- The contract's RELATIVE body-equality clause (helper-call only).
  const substituted: string[] = []
  for (const e of HELPER_CALL_ENTRIES) {
    if (dropped.has(keyOf(e))) continue
    const run = resolved.get(keyOf(e))
    if (run === undefined) continue
    // Manifest FIRST, then package. Re-derived: exactly one of four entries
    // self-corrupts under package-first ordering -- publish-skillsmith-cli,
    // whose package token `skillsmith-cli` is a substring of its own manifest
    // path `packages/skillsmith-cli/package.json`. The other three package
    // tokens (`@skillsmith/...`) appear in no manifest path, and no entry's
    // package token appears in any other entry's body. Manifest-first is
    // mandatory regardless; the justification is one entry, not four.
    substituted.push(
      normalize(run).split(e.manifest).join(MANIFEST_SENTINEL).split(e.pkg).join(PKG_SENTINEL)
    )
  }
  const bodyCompared = substituted.length
  if (bodyCompared > 0) {
    const distinct = new Set(substituted)
    if (distinct.size !== 1) {
      add(
        'VB-BODY-MISMATCH',
        `${distinct.size} distinct normalized bodies across ${bodyCompared} compared entries`
      )
    } else if ([...distinct][0] === '') {
      add('VB-BODY-MISMATCH', 'the shared normalized body is empty')
    }
  }

  // --- The byte-exact canonical call shape, rendered per entry. Keeps the
  // --- retired VB-SUBSTITUTION-COUNT name: this is the re-homed successor to
  // --- that code's zero-count arm, which is what used to stop a call site
  // --- from invoking the helper without naming its package.
  let shapeCompared = 0
  for (const e of HELPER_CALL_ENTRIES) {
    if (dropped.has(keyOf(e))) continue
    const run = resolved.get(keyOf(e))
    if (run === undefined) continue
    shapeCompared += 1
    const actual = normalize(run)
    const expected = renderCanonical(e)
    if (actual !== expected) {
      add(
        'VB-SUBSTITUTION-COUNT',
        `${e.job} :: ${e.step} call shape is not canonical\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`
      )
    }
  }

  // --- Assertion 1: the denominator, for BOTH loops, with its own code.
  const n = HELPER_CALL_ENTRIES.length
  if (bodyCompared !== n) {
    add(
      'VB-COVERAGE-SHORTFALL',
      `body-equality loop compared ${bodyCompared}/${n} registered helper-call entries`
    )
  }
  if (shapeCompared !== n) {
    add(
      'VB-COVERAGE-SHORTFALL',
      `call-shape loop compared ${shapeCompared}/${n} registered helper-call entries`
    )
  }

  return result(bodyCompared, shapeCompared)
}

// --------------------------------------------------------------------------
// Fixtures. Every case starts from the REAL workflow and is mutated in memory
// by (jobId, stepName) -- never by line offset, and never from a committed
// snapshot that would quietly become a museum piece.
// --------------------------------------------------------------------------

type MutDoc = { jobs: Record<string, { steps: Array<Record<string, unknown>> }> }

const REAL_DOC = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'))
const fresh = (): MutDoc => structuredClone(REAL_DOC) as MutDoc

function stepOf(d: MutDoc, job: string, name: string): Record<string, unknown> {
  const hits = (d.jobs[job]?.steps ?? []).filter((s) => s.name === name)
  if (hits.length !== 1)
    throw new Error(`fixture setup: ${job} :: ${name} matched ${hits.length} steps`)
  return hits[0]
}

const bind = (e: Entry): string => `VERSION=$(jq -r .version ${e.manifest})`
const body = (...lines: string[]): string => [MARKER, ...lines].join('\n') + '\n'

/** Rewrites ALL FOUR helper-call bodies identically -- the shape the relative
 *  equality clause cannot see, which is the whole reason the shape check exists. */
function withAllBodies(make: (e: Entry) => string): MutDoc {
  const d = fresh()
  for (const e of HELPER_CALL_ENTRIES) stepOf(d, e.job, e.step).run = make(e)
  return d
}

function withEnterpriseVerify(run: string): MutDoc {
  const d = fresh()
  d.jobs[ENTERPRISE_JOB].steps.push({ name: ENTERPRISE_ENTRY.step, run })
  return d
}

const INDEPENDENT_OPTS: Options = { independent: [ENTERPRISE_ENTRY], armBExempt: [] }
const CORE = HELPER_CALL_ENTRIES[0]
const CLI = HELPER_CALL_ENTRIES[2]

// --------------------------------------------------------------------------

describe('publish.yml verify call sites -- the live registry', () => {
  it('is green on the unmodified workflow, and states the scope it covered', () => {
    const r = analyze(REAL_DOC)
    expect(r.findings).toEqual([])
    expect(r.bodyEqualityCompared).toBe(r.helperCallRegistered)
    expect(r.callShapeCompared).toBe(r.helperCallRegistered)
    console.log(
      `[SMI-6497] body-equality ${r.bodyEqualityCompared}/${r.helperCallRegistered}, ` +
        `call-shape ${r.callShapeCompared}/${r.helperCallRegistered}, ` +
        `independent class ${INDEPENDENT_ENTRIES.length} live entries (SMI-6498 pending)`
    )
  })

  it('does not sweep up `Smoke the npx wrapper`: it fails the arm-A name predicate', () => {
    expect(VERIFY_NAME_RE.test('Smoke the npx wrapper')).toBe(false)
    const names = fresh().jobs['publish-skillsmith-cli'].steps.map((s) => String(s.name))
    expect(names).toContain('Smoke the npx wrapper')
    expect(analyze(REAL_DOC).codes).not.toContain('VB-UNREGISTERED-VERIFY-STEP')
  })
})

describe('parse guard -- VB-PARSE-ERROR, evaluated first, over both classes', () => {
  it('NP-1: `jobs:` absent -> VB-PARSE-ERROR, not a TypeError and not four VB-MISSING-STEP', () => {
    const r = analyze({ name: 'Publish' })
    expect(r.codes).toEqual(['VB-PARSE-ERROR'])
    expect(r.codes).not.toContain('VB-MISSING-STEP')
  })

  it('NP-2: `jobs:` a string, and separately a list -> VB-PARSE-ERROR', () => {
    for (const jobs of ['publish-core', [{ id: 'publish-core' }], null]) {
      const r = analyze({ jobs })
      expect(r.codes).toEqual(['VB-PARSE-ERROR'])
    }
  })

  it('NP-2b: a job whose `steps:` is not a list -> VB-PARSE-ERROR naming the job', () => {
    const d = fresh()
    ;(d.jobs['publish-core'] as unknown as Record<string, unknown>).steps = 'not-a-list'
    const r = analyze(d)
    expect(r.codes).toEqual(['VB-PARSE-ERROR'])
    expect(r.findings[0]).toContain('publish-core')
  })

  it('NP-3: a registered step has no `run:` key -> VB-PARSE-ERROR naming the step', () => {
    const d = fresh()
    delete stepOf(d, CORE.job, CORE.step).run
    const r = analyze(d)
    expect(r.codes).toEqual(['VB-PARSE-ERROR'])
    expect(r.findings[0]).toContain(`${CORE.job} :: ${CORE.step}`)
    expect(r.findings[0]).toContain('absent')
  })

  it('NP-4: a registered `run:` is a list, and separately a number -> VB-PARSE-ERROR naming the step', () => {
    for (const run of [['npm view'], 42]) {
      const d = fresh()
      stepOf(d, CORE.job, CORE.step).run = run
      const r = analyze(d)
      expect(r.codes).toEqual(['VB-PARSE-ERROR'])
      expect(r.findings[0]).toContain(`${CORE.job} :: ${CORE.step}`)
    }
  })

  it('NP-5: the INDEPENDENT entry\'s `run:` is "" -> VB-PARSE-ERROR, not excused by the body-equality carve-out', () => {
    const r = analyze(withEnterpriseVerify(''), INDEPENDENT_OPTS)
    expect(r.codes).toEqual(['VB-PARSE-ERROR'])
    expect(r.findings[0]).toContain(ENTERPRISE_ENTRY.step)
  })

  it("NP-5b: the INDEPENDENT entry's `run:` absent, and comment-only -> VB-PARSE-ERROR", () => {
    const absent = fresh()
    absent.jobs[ENTERPRISE_JOB].steps.push({ name: ENTERPRISE_ENTRY.step })
    expect(analyze(absent, INDEPENDENT_OPTS).codes).toEqual(['VB-PARSE-ERROR'])
    const commentOnly = analyze(
      withEnterpriseVerify(`${MARKER}\n# nothing else\n`),
      INDEPENDENT_OPTS
    )
    expect(commentOnly.codes).toEqual(['VB-PARSE-ERROR'])
    expect(commentOnly.findings[0]).toContain('empty after normalization')
  })

  it('NP-6: all four helper-call bodies are "" -> VB-PARSE-ERROR, not a green equality result', () => {
    const r = analyze(withAllBodies(() => ''))
    expect(r.codes).toEqual(Array(4).fill('VB-PARSE-ERROR'))
    expect(r.codes).not.toContain('VB-BODY-MISMATCH')
  })

  it('NP-7: all four helper-call bodies are comment-only -> VB-PARSE-ERROR via empty-after-normalization', () => {
    const r = analyze(withAllBodies(() => `${MARKER}\n# only comments here\n`))
    expect(r.codes).toEqual(Array(4).fill('VB-PARSE-ERROR'))
    expect(r.findings.every((x) => x.includes('empty after normalization'))).toBe(true)
  })
})

describe('arm A -- the four failure modes, one diagnosis each', () => {
  it('missing: a registered step deleted -> VB-MISSING-STEP', () => {
    const d = fresh()
    d.jobs[CLI.job].steps = d.jobs[CLI.job].steps.filter((s) => s.name !== CLI.step)
    const r = analyze(d)
    expect(r.codes).toContain('VB-MISSING-STEP')
    expect(r.codes).not.toContain('VB-WRONG-JOB')
  })

  it('missing: a registered step renamed out of the predicate -> VB-MISSING-STEP', () => {
    const d = fresh()
    stepOf(d, CLI.job, CLI.step).name = 'Verify cli package availability'
    expect(analyze(d).codes).toContain('VB-MISSING-STEP')
  })

  it('wrong job: a registered step moved to another job -> VB-WRONG-JOB, not VB-MISSING-STEP', () => {
    const d = fresh()
    const moved = stepOf(d, CLI.job, CLI.step)
    d.jobs[CLI.job].steps = d.jobs[CLI.job].steps.filter((s) => s.name !== CLI.step)
    d.jobs['publish-core'].steps.push(moved)
    const r = analyze(d)
    expect(r.codes).toContain('VB-WRONG-JOB')
    expect(r.codes).not.toContain('VB-MISSING-STEP')
    expect(r.findings.find((x) => x.startsWith('VB-WRONG-JOB'))).toContain('publish-core')
  })

  it('duplicate: a registered (jobId, stepName) appearing twice -> VB-DUPLICATE-STEP', () => {
    const d = fresh()
    d.jobs[CLI.job].steps.push(structuredClone(stepOf(d, CLI.job, CLI.step)))
    const r = analyze(d)
    expect(r.codes).toContain('VB-DUPLICATE-STEP')
    expect(r.findings.find((x) => x.startsWith('VB-DUPLICATE-STEP'))).toContain('appears 2 times')
  })

  it('extra: a conventionally named fifth verify step -> VB-UNREGISTERED-VERIFY-STEP', () => {
    const d = fresh()
    d.jobs['smoke-test'].steps.push({ name: 'Verify enterprise on npm', run: 'echo hi\n' })
    const r = analyze(d)
    expect(r.codes).toContain('VB-UNREGISTERED-VERIFY-STEP')
    expect(r.findings.find((x) => x.startsWith('VB-UNREGISTERED-VERIFY-STEP'))).toContain(
      'smoke-test'
    )
  })
})

describe('arm B -- job-keyed publish coverage, and the SMI-6498 coupling', () => {
  it('coupling: the empty `independent` class REQUIRES the exemption; a non-empty class FORBIDS it', () => {
    expect(expectedArmBExemptions([])).toEqual([ENTERPRISE_JOB])
    expect(expectedArmBExemptions([ENTERPRISE_ENTRY])).toEqual([])
    // The live coupling. SMI-6498 must delete the exemption in the same commit
    // that registers the enterprise entry, or this assertion fails.
    expect(ARM_B_EXEMPT_JOBS).toEqual(expectedArmBExemptions(INDEPENDENT_ENTRIES))
  })

  it('NB-1: a new job running npm publish with no registered entry -> VB-UNCOVERED-PUBLISH-JOB naming it', () => {
    const d = fresh()
    d.jobs['publish-widget'] = {
      steps: [{ name: 'Publish widget', run: 'npm publish -w widget\n' }],
    }
    const r = analyze(d)
    expect(r.codes).toContain('VB-UNCOVERED-PUBLISH-JOB')
    expect(r.findings.find((x) => x.startsWith('VB-UNCOVERED-PUBLISH-JOB'))).toContain(
      'publish-widget'
    )
  })

  it('NB-2 (control): the unmodified workflow raises no VB-UNCOVERED-PUBLISH-JOB beyond the named exemption', () => {
    // The counts come FIRST deliberately. vitest stops a case at its first
    // failing assertion, so putting the broad `not.toContain` first would mask
    // these two -- they are the only assertions in the file that pin the
    // job-vs-step distinction, and an assertion that cannot be observed failing
    // on its own is not evidence that it constrains anything.
    //
    // Arm B is JOB-keyed, not step-keyed: six steps match `npm publish` but
    // only five jobs do, because `publish-mcp-server :: Annotate registry
    // publish failure` carries the string inside an echo.
    const d = fresh()
    let jobHits = 0
    let stepHits = 0
    for (const job of Object.values(d.jobs)) {
      const hits = job.steps.filter(
        (s) => typeof s.run === 'string' && PUBLISH_RE.test(s.run as string)
      )
      stepHits += hits.length
      if (hits.length > 0) jobHits += 1
    }
    expect(jobHits).toBe(5)
    expect(stepHits).toBe(6)
    expect(analyze(REAL_DOC).codes).not.toContain('VB-UNCOVERED-PUBLISH-JOB')
  })

  it('NB-3: a widened exemption list hides a real finding, and the pinning assertion rejects it', () => {
    const d = fresh()
    d.jobs['publish-widget'] = {
      steps: [{ name: 'Publish widget', run: 'npm publish -w widget\n' }],
    }
    const widened = [...ARM_B_EXEMPT_JOBS, 'publish-widget']
    expect(analyze(d, { armBExempt: widened }).codes).not.toContain('VB-UNCOVERED-PUBLISH-JOB')
    expect(widened).not.toEqual(expectedArmBExemptions(INDEPENDENT_ENTRIES))
    expect(ARM_B_EXEMPT_JOBS).toHaveLength(1)
  })
})

describe('arm C -- markers, read raw, plus the probe backstop', () => {
  it("NC-1: a registered step's marker line deleted -> VB-UNMARKED-REGISTERED-STEP", () => {
    const d = fresh()
    const s = stepOf(d, CORE.job, CORE.step)
    s.run = String(s.run).replace(`${MARKER}\n`, '')
    const r = analyze(d)
    expect(r.codes).toContain('VB-UNMARKED-REGISTERED-STEP')
    expect(r.findings.find((x) => x.startsWith('VB-UNMARKED-REGISTERED-STEP'))).toContain(CORE.step)
  })

  it('NC-1b: markers are read from the RAW body -- normalization would erase every one of them', () => {
    const raw = String(stepOf(fresh(), CORE.job, CORE.step).run)
    expect(MARKER_RE.test(raw)).toBe(true)
    expect(MARKER_RE.test(normalize(raw))).toBe(false)
  })

  it('NC-2: the marker added to an unregistered step -> VB-UNREGISTERED-MARKED-STEP', () => {
    const d = fresh()
    const s = stepOf(d, 'smoke-test', 'Wait for npm propagation')
    s.run = `${MARKER}\n${String(s.run)}`
    const r = analyze(d)
    expect(r.codes).toContain('VB-UNREGISTERED-MARKED-STEP')
    expect(r.findings.find((x) => x.startsWith('VB-UNREGISTERED-MARKED-STEP'))).toContain(
      'Wait for npm propagation'
    )
  })

  it('NC-3: an unmarked `npm view` step in an already-covered job -> VB-UNMARKED-PROBE', () => {
    const d = fresh()
    d.jobs[ENTERPRISE_JOB].steps.push({
      name: 'Check enterprise package availability',
      run: 'npm view @smith-horn/enterprise version\n',
    })
    const r = analyze(d)
    expect(r.codes).toContain('VB-UNMARKED-PROBE')
    expect(r.findings.find((x) => x.startsWith('VB-UNMARKED-PROBE'))).toContain(
      'Check enterprise package availability'
    )
    // The name does not match arm A, which is exactly why this shape failed open before.
    expect(VERIFY_NAME_RE.test('Check enterprise package availability')).toBe(false)
  })

  it('NC-3b: the backstop also fires on a helper invocation with no `npm view` at all', () => {
    const d = fresh()
    d.jobs['smoke-test'].steps.push({
      name: 'Recheck core',
      run: `bash ${HELPER_PATH} '@skillsmith/core' "$V"\n`,
    })
    expect(analyze(d).codes).toContain('VB-UNMARKED-PROBE')
  })

  it('NC-4 (control): the unmodified workflow raises no VB-UNMARKED-PROBE; the six pre-publish probes stay green', () => {
    expect(analyze(REAL_DOC).codes).not.toContain('VB-UNMARKED-PROBE')
    const d = fresh()
    const probes: string[] = []
    for (const [id, job] of Object.entries(d.jobs)) {
      for (const s of job.steps) {
        if (typeof s.run === 'string' && PROBE_RE.test(s.run))
          probes.push(`${id}::${String(s.name)}`)
      }
    }
    expect(probes.sort()).toEqual(PROBE_ALLOWLIST.map(keyOf).sort())
    expect(PROBE_ALLOWLIST).toHaveLength(6)
  })
})

describe('the canonical call shape -- CS-*, all four bodies mutated identically', () => {
  // Each CS case below keeps the four bodies mutually identical after
  // substitution, so the relative body-equality clause PASSES. Asserting
  // `not.toContain('VB-BODY-MISMATCH')` is the demonstration that the shape
  // check is doing independent work, not shadowing an existing assertion.
  const shapeOnly = (d: MutDoc): void => {
    const r = analyze(d)
    expect(r.codes).toContain('VB-SUBSTITUTION-COUNT')
    expect(r.codes).not.toContain('VB-BODY-MISMATCH')
    expect(r.codes).not.toContain('VB-COVERAGE-SHORTFALL')
  }

  it('CS-1: the package argument missing -- the exact post-publish `set -u` death', () => {
    shapeOnly(withAllBodies((e) => body(bind(e), `bash ${HELPER_PATH} "$VERSION"`)))
  })
  it('CS-2: the arguments reordered', () => {
    shapeOnly(withAllBodies((e) => body(bind(e), `bash ${HELPER_PATH} "$VERSION" '${e.pkg}'`)))
  })
  it('CS-3: the package argument replaced by a literal that is not the registered package', () => {
    shapeOnly(
      withAllBodies((e) => body(bind(e), `bash ${HELPER_PATH} '@skillsmith/wrong' "$VERSION"`))
    )
  })
  it('CS-4: the version argument replaced by a constant', () => {
    shapeOnly(withAllBodies((e) => body(bind(e), `bash ${HELPER_PATH} '${e.pkg}' '0.0.0'`)))
  })
  it('CS-5: the package duplicated and the version dropped -- right arity, wrong meaning', () => {
    shapeOnly(withAllBodies((e) => body(bind(e), `bash ${HELPER_PATH} '${e.pkg}' '${e.pkg}'`)))
  })
  it('CS-6: the manifest binding removed, the helper called on an unset variable', () => {
    shapeOnly(withAllBodies((e) => body(`bash ${HELPER_PATH} '${e.pkg}' "$VERSION"`)))
  })
  it('CS-7: the binding reads the wrong field (.name) of the right manifest', () => {
    shapeOnly(
      withAllBodies((e) =>
        body(`VERSION=$(jq -r .name ${e.manifest})`, `bash ${HELPER_PATH} '${e.pkg}' "$VERSION"`)
      )
    )
  })
  it('CS-8: the binding uses the wrong command entirely', () => {
    shapeOnly(
      withAllBodies((e) =>
        body(`VERSION=$(cat ${e.manifest})`, `bash ${HELPER_PATH} '${e.pkg}' "$VERSION"`)
      )
    )
  })
  it("CS-9: one entry given ANOTHER registered entry's manifest -- only the association is wrong", () => {
    const d = fresh()
    stepOf(d, CORE.job, CORE.step).run = body(
      `VERSION=$(jq -r .version ${CLI.manifest})`,
      `bash ${HELPER_PATH} '${CORE.pkg}' "$VERSION"`
    )
    const r = analyze(d)
    expect(r.codes).toContain('VB-SUBSTITUTION-COUNT')
    expect(r.findings.find((x) => x.startsWith('VB-SUBSTITUTION-COUNT'))).toContain(CORE.job)
    // The contract's RELATIVE body-equality clause co-fires here. It is the
    // only case in this file that pins that clause at all, because on this
    // registry it is strictly subsumed by the shape check above: all four
    // canonical renders substitute to one identical string, so no input can
    // trip body-mismatch without also tripping the shape check. The clause is
    // kept because the fenced contract mandates it, not because it adds reach.
    expect(r.codes).toContain('VB-BODY-MISMATCH')
  })
  it('CS-10 (control): a third line in an otherwise correct body is a finding, not a tolerated extra', () => {
    shapeOnly(
      withAllBodies((e) => body(bind(e), `bash ${HELPER_PATH} '${e.pkg}' "$VERSION"`, 'echo done'))
    )
  })
})

describe('the denominator and the sentinel -- two assertions, two codes', () => {
  it('DS-1: an entry dropped from both loops leaves body-equality GREEN and trips only the denominator', () => {
    const r = analyze(REAL_DOC, { dropEntries: [keyOf(CORE)] })
    expect(r.codes).not.toContain('VB-BODY-MISMATCH')
    expect(r.codes).not.toContain('VB-SUBSTITUTION-COUNT')
    expect(r.codes).toContain('VB-COVERAGE-SHORTFALL')
    expect(r.bodyEqualityCompared).toBe(3)
    expect(r.callShapeCompared).toBe(3)
    expect(r.findings.filter((x) => x.startsWith('VB-COVERAGE-SHORTFALL'))).toHaveLength(2)
    expect(r.findings.find((x) => x.startsWith('VB-COVERAGE-SHORTFALL'))).toContain('3/4')
  })

  it('DS-2: a package argument replaced by a sentinel token -> VB-SENTINEL-COLLISION, before substitution', () => {
    const d = fresh()
    stepOf(d, CORE.job, CORE.step).run = body(
      bind(CORE),
      `bash ${HELPER_PATH} '${PKG_SENTINEL}' "$VERSION"`
    )
    const r = analyze(d)
    expect(r.codes).toContain('VB-SENTINEL-COLLISION')
    expect(r.findings.find((x) => x.startsWith('VB-SENTINEL-COLLISION'))).toContain(PKG_SENTINEL)
  })

  it('DS-2b: a manifest sentinel in a raw body is caught the same way', () => {
    const d = fresh()
    stepOf(d, CORE.job, CORE.step).run = body(
      `VERSION=$(jq -r .version ${MANIFEST_SENTINEL})`,
      `bash ${HELPER_PATH} '${CORE.pkg}' "$VERSION"`
    )
    expect(analyze(d).codes).toContain('VB-SENTINEL-COLLISION')
  })

  it('DS-3 (control): the unmodified workflow trips neither code, and the fraction is 4/4', () => {
    const r = analyze(REAL_DOC)
    expect(r.codes).not.toContain('VB-COVERAGE-SHORTFALL')
    expect(r.codes).not.toContain('VB-SENTINEL-COLLISION')
    expect(r.bodyEqualityCompared).toBe(4)
    expect(r.callShapeCompared).toBe(4)
    expect(r.helperCallRegistered).toBe(4)
  })
})

describe('independent class -- machinery with zero live entries (SMI-6498)', () => {
  it('has no live entry today, so its success path is exercised only by these fixtures', () => {
    expect(INDEPENDENT_ENTRIES).toEqual([])
    const names = fresh().jobs[ENTERPRISE_JOB].steps.map((s) => String(s.name))
    expect(names.filter((n) => VERIFY_NAME_RE.test(n))).toEqual([])
  })

  it('IND-1 (positive): identity + discovery succeed, and the entry is EXCLUDED from body equality', () => {
    const run = body(
      `npm view ${ENTERPRISE_ENTRY.pkg}@"$VERSION" version --registry=https://npm.pkg.github.com`
    )
    const r = analyze(withEnterpriseVerify(run), INDEPENDENT_OPTS)
    expect(r.findings).toEqual([])
    // Its body is nothing like the canonical two-liner, yet neither the
    // relative equality clause nor the shape check fires -- the exclusion works.
    expect(normalize(run)).not.toBe(renderCanonical(ENTERPRISE_ENTRY))
    // ... and the denominator still reports the four helper-call entries only.
    expect(r.bodyEqualityCompared).toBe(4)
    expect(r.callShapeCompared).toBe(4)
  })

  it('IND-2: a registered independent entry in the WRONG job -> VB-WRONG-JOB', () => {
    const d = fresh()
    d.jobs['smoke-test'].steps.push({
      name: ENTERPRISE_ENTRY.step,
      run: body('npm view x version'),
    })
    expect(analyze(d, INDEPENDENT_OPTS).codes).toContain('VB-WRONG-JOB')
  })

  it('IND-3: a registered independent entry that is absent -> VB-MISSING-STEP, and arm B does NOT double-diagnose', () => {
    const r = analyze(REAL_DOC, INDEPENDENT_OPTS)
    expect(r.codes).toContain('VB-MISSING-STEP')
    expect(r.findings.find((x) => x.startsWith('VB-MISSING-STEP'))).toContain(ENTERPRISE_ENTRY.step)
    // Arm B asks whether a publishing job OWNS a registered entry, not whether
    // that entry resolves. A registered-but-absent entry is exactly one defect
    // with exactly one fix, so VB-MISSING-STEP is the diagnosis and arm B stays
    // quiet. Nothing fails open: removing the registration instead is what
    // arm B catches, which is IND-3b.
    expect(r.codes).not.toContain('VB-UNCOVERED-PUBLISH-JOB')
  })

  it('IND-3b: with the entry UNregistered and unexempted, arm B is what goes red', () => {
    const r = analyze(REAL_DOC, { independent: [], armBExempt: [] })
    expect(r.codes).toContain('VB-UNCOVERED-PUBLISH-JOB')
    expect(r.findings.find((x) => x.startsWith('VB-UNCOVERED-PUBLISH-JOB'))).toContain(
      ENTERPRISE_JOB
    )
    // This is the measured state of `main` today, and the reason the exemption
    // exists: publish-enterprise publishes and owns no verification of any kind.
    expect(r.codes).not.toContain('VB-MISSING-STEP')
  })

  it('IND-4: an independent entry is NOT excluded from arm C -- it needs the marker too', () => {
    const run = 'npm view @smith-horn/enterprise version\n'
    const r = analyze(withEnterpriseVerify(run), INDEPENDENT_OPTS)
    expect(r.codes).toContain('VB-UNMARKED-REGISTERED-STEP')
  })
})
