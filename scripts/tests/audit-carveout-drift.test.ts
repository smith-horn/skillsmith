/**
 * Tests for the pure-JS carve-out drift check (Check 38 in
 * scripts/audit-standards.mjs, SMI-4647 + SMI-4648).
 *
 * Helpers under test live in scripts/audit-standards-helpers.mjs:
 *   - parseCiYmlJobs(content) → [{name, line, body}]
 *   - checkCarveOutInvariants(jobs, denyList) → {violationsA, violationsB}
 *
 * Convention matches scripts/tests/audit-standards.test.ts: dynamic ESM import
 * of the helper file at top-of-module.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  parseCiYmlJobs: (content: string) => Array<{ name: string; line: number; body: string }>
  checkCarveOutInvariants: (
    jobs: Array<{ name: string; line: number; body: string }>,
    denyList: string[]
  ) => {
    violationsA: Array<{ name: string; line: number; reason: string }>
    violationsB: Array<{ name: string; line: number; flag: string }>
  }
}

const { parseCiYmlJobs, checkCarveOutInvariants } = helpers

const fixture = (s: string): string => s.replace(/^\n/, '')

describe('parseCiYmlJobs', () => {
  it('returns empty list when there is no `jobs:` block', () => {
    const yml = fixture(`
name: ci
on:
  push:
env:
  NODE_VERSION: '22'
`)
    expect(parseCiYmlJobs(yml)).toEqual([])
  })

  it('only returns identifiers nested under the top-level `jobs:` key (skips on/env/permissions children)', () => {
    const yml = fixture(`
name: ci
on:
  push:
permissions:
  contents: read
concurrency:
  group: ci
jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`)
    const jobs = parseCiYmlJobs(yml)
    expect(jobs.map((j) => j.name)).toEqual(['lint'])
  })

  it('captures multiple sequential jobs with correct line numbers', () => {
    const yml = fixture(`
jobs:
  classify:
    runs-on: ubuntu-latest
    steps:
      - run: echo classify
  docker-build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`)
    const jobs = parseCiYmlJobs(yml)
    expect(jobs.map((j) => j.name)).toEqual(['classify', 'docker-build', 'lint'])
    // Line numbers are 1-indexed
    expect(jobs[0].line).toBe(2)
    expect(jobs[1].line).toBe(6)
    expect(jobs[2].line).toBe(10)
  })

  it('captures the full job body (including indented sub-keys and comments)', () => {
    const yml = fixture(`
jobs:
  lint:
    name: Lint
    # audit:carveout-pure-js — see plan
    runs-on: ubuntu-latest
    needs: [classify, detect-changes]
    steps:
      - run: npm run lint
  test:
    runs-on: ubuntu-latest
    needs: [docker-build]
    steps:
      - run: docker run --rm skillsmith-ci:abc test
`)
    const jobs = parseCiYmlJobs(yml)
    expect(jobs).toHaveLength(2)
    expect(jobs[0].body).toContain('# audit:carveout-pure-js')
    expect(jobs[0].body).toContain('npm run lint')
    expect(jobs[0].body).not.toContain('test:')
    expect(jobs[1].body).toContain('docker run --rm skillsmith-ci:abc')
  })
})

describe('checkCarveOutInvariants — Invariant A', () => {
  const denyList = ['retro-frontmatter']

  it('passes when a Docker-bound job invokes docker run skillsmith-ci:', () => {
    const yml = fixture(`
jobs:
  test:
    runs-on: ubuntu-latest
    needs: [docker-build, classify]
    steps:
      - run: |
          docker run --rm \\
            -v ${'$'}{{ github.workspace }}:/app \\
            skillsmith-ci:${'$'}{{ github.sha }} \\
            npm test
`)
    const { violationsA, violationsB } = checkCarveOutInvariants(parseCiYmlJobs(yml), denyList)
    expect(violationsA).toEqual([])
    expect(violationsB).toEqual([])
  })

  it('passes when a needs: docker-build job carries the carve-out marker', () => {
    const yml = fixture(`
jobs:
  lint:
    name: Lint
    # audit:carveout-pure-js — see plan
    runs-on: ubuntu-latest
    needs: [docker-build, classify]
    steps:
      - run: npm run lint
`)
    const { violationsA } = checkCarveOutInvariants(parseCiYmlJobs(yml), denyList)
    expect(violationsA).toEqual([])
  })

  it('flags a job that needs docker-build but neither runs Docker nor has the marker', () => {
    const yml = fixture(`
jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    needs: [docker-build, classify]
    steps:
      - run: npm test
`)
    const { violationsA } = checkCarveOutInvariants(parseCiYmlJobs(yml), denyList)
    expect(violationsA).toHaveLength(1)
    expect(violationsA[0].name).toBe('test')
    expect(violationsA[0].reason).toContain('needs: docker-build')
  })

  it('does not flag a job with no needs: docker-build (orchestration job)', () => {
    const yml = fixture(`
jobs:
  classify:
    runs-on: ubuntu-latest
    needs: [detect-changes]
    steps:
      - run: echo classify
`)
    const { violationsA } = checkCarveOutInvariants(parseCiYmlJobs(yml), denyList)
    expect(violationsA).toEqual([])
  })
})

describe('checkCarveOutInvariants — Invariant B', () => {
  const denyList = ['retro-frontmatter']

  it('passes when a carved-out job invokes audit:standards without --only', () => {
    const yml = fixture(`
jobs:
  compliance:
    name: Standards Compliance
    # audit:carveout-pure-js — see plan
    runs-on: ubuntu-latest
    needs: [detect-changes]
    steps:
      - run: npm run audit:standards
`)
    const { violationsB } = checkCarveOutInvariants(parseCiYmlJobs(yml), denyList)
    expect(violationsB).toEqual([])
  })

  it('flags a carved-out job invoking audit:standards --only retro-frontmatter', () => {
    const yml = fixture(`
jobs:
  compliance:
    # audit:carveout-pure-js — see plan
    runs-on: ubuntu-latest
    needs: [detect-changes]
    steps:
      - run: npm run audit:standards -- --only retro-frontmatter
`)
    const { violationsB } = checkCarveOutInvariants(parseCiYmlJobs(yml), denyList)
    expect(violationsB).toHaveLength(1)
    expect(violationsB[0].name).toBe('compliance')
    expect(violationsB[0].flag).toBe('retro-frontmatter')
  })

  it('does not flag a Docker-bound job that uses --only retro-frontmatter (carve-out scope only)', () => {
    const yml = fixture(`
jobs:
  test:
    runs-on: ubuntu-latest
    needs: [docker-build]
    steps:
      - run: |
          docker run --rm skillsmith-ci:abc \\
            npm run audit:standards -- --only retro-frontmatter
`)
    const { violationsB } = checkCarveOutInvariants(parseCiYmlJobs(yml), denyList)
    expect(violationsB).toEqual([])
  })

  it('flags every flag in the deny-list independently', () => {
    const yml = fixture(`
jobs:
  compliance:
    # audit:carveout-pure-js — see plan
    runs-on: ubuntu-latest
    steps:
      - run: npm run audit:standards -- --only retro-frontmatter
      - run: npm run audit:standards -- --only future-native-flag
`)
    const { violationsB } = checkCarveOutInvariants(parseCiYmlJobs(yml), [
      'retro-frontmatter',
      'future-native-flag',
    ])
    expect(violationsB).toHaveLength(2)
    expect(violationsB.map((v) => v.flag).sort()).toEqual([
      'future-native-flag',
      'retro-frontmatter',
    ])
  })

  it('does not false-positive when a flag name contains regex metacharacters (escape safety)', () => {
    // A deny-list flag of 'retro.frontmatter' (dot = wildcard) must not match
    // 'retro-frontmatter' (hyphen) in the job body.
    const yml = fixture(`
jobs:
  compliance:
    # audit:carveout-pure-js — see plan
    runs-on: ubuntu-latest
    steps:
      - run: npm run audit:standards -- --only retro-frontmatter
`)
    // Flag with dot should NOT match 'retro-frontmatter' (hyphen ≠ dot literal)
    const { violationsB } = checkCarveOutInvariants(parseCiYmlJobs(yml), ['retro.frontmatter'])
    expect(violationsB).toEqual([])
  })
})

describe('checkCarveOutInvariants — real ci.yml smoke', () => {
  it('passes on the actual workflow file in this repo (post-Wave-2 state)', () => {
    // Read the workflow at runtime so this test catches future drift.
    const path = '.github/workflows/ci.yml'
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    if (!fs.existsSync(path)) {
      // Tests can run from non-repo-root in some matrix shapes — skip cleanly.
      return
    }
    const content = fs.readFileSync(path, 'utf8')
    const jobs = parseCiYmlJobs(content)
    const { violationsA, violationsB } = checkCarveOutInvariants(jobs, ['retro-frontmatter'])
    expect(violationsA).toEqual([])
    expect(violationsB).toEqual([])
    // Sanity: at least one carved-out job + at least one Docker-bound job.
    const carved = jobs.filter((j) => /audit:carveout-pure-js/.test(j.body))
    const dockerBound = jobs.filter((j) => /docker run\s+.*skillsmith-ci:/s.test(j.body))
    expect(carved.length).toBeGreaterThanOrEqual(1)
    expect(dockerBound.length).toBeGreaterThanOrEqual(1)
  })
})
