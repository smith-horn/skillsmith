/**
 * SMI-6518: executable twin of `audit:standards` Check 70 -- asserts
 * docker-compose.yml's `dev` service SKILLSMITH_DOCKER_CPUS /
 * SKILLSMITH_DOCKER_MEM `${VAR:-default}` values match the "Default N" /
 * "Default X" prose .env.schema documents for the same two variables.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import {
  checkDockerEnvDefaultCoherence,
  extractComposeDockerDefaults,
  extractEnvSchemaDefault,
} from '../audit-docker-env-coherence-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

const MATCHING_COMPOSE = `
services:
  dev:
    cpus: '\${SKILLSMITH_DOCKER_CPUS:-4}'
    mem_limit: \${SKILLSMITH_DOCKER_MEM:-6g}
`

const MATCHING_SCHEMA = `
# Per-container CPU ceiling for the dev docker-compose service. Default 4
# @type=number(min=1) @sensitive=false @required=false
SKILLSMITH_DOCKER_CPUS=

# Per-container memory ceiling, Docker mem_limit syntax. Default 6g,
# empirically verified against a real npm run lint run.
# @type=string @sensitive=false @required=false
SKILLSMITH_DOCKER_MEM=
`

const MISMATCHED_CPUS_SCHEMA = `
# Per-container CPU ceiling for the dev docker-compose service. Default 6
# @type=number(min=1) @sensitive=false @required=false
SKILLSMITH_DOCKER_CPUS=

# Per-container memory ceiling, Docker mem_limit syntax. Default 6g,
# empirically verified against a real npm run lint run.
# @type=string @sensitive=false @required=false
SKILLSMITH_DOCKER_MEM=
`

describe('extractComposeDockerDefaults', () => {
  it('extracts both defaults from the dev service', () => {
    expect(extractComposeDockerDefaults(MATCHING_COMPOSE)).toEqual({ cpus: '4', mem: '6g' })
  })

  it('returns null for a missing key', () => {
    expect(extractComposeDockerDefaults('services:\n  dev:\n    ports: []\n')).toEqual({
      cpus: null,
      mem: null,
    })
  })

  // Cross-family pre-merge review findings (SMI-6518): the original regex
  // searched the whole file (no `dev`-service anchoring), matched commented
  // lines, and required single quotes for `cpus` but none for `mem_limit`.
  // Every case below pins one specific defect so a regression re-fails.
  it('anchors to the `dev` service, not an earlier service declaring the same vars', () => {
    const compose = `
services:
  test:
    cpus: '\${SKILLSMITH_DOCKER_CPUS:-2}'
    mem_limit: \${SKILLSMITH_DOCKER_MEM:-3g}
  dev:
    cpus: '\${SKILLSMITH_DOCKER_CPUS:-4}'
    mem_limit: \${SKILLSMITH_DOCKER_MEM:-6g}
`
    expect(extractComposeDockerDefaults(compose)).toEqual({ cpus: '4', mem: '6g' })
  })

  it('does not let an earlier service mask real drift in `dev` (end-to-end coherence check)', () => {
    // `dev` has actually drifted to 8 CPUs (schema still says 4), but an
    // earlier `test` service happens to declare 4 -- the exact masking
    // shape the finding described. The old whole-file-first-match regex
    // would have extracted `test`'s 4 and reported a false pass.
    const compose = `
services:
  test:
    cpus: '\${SKILLSMITH_DOCKER_CPUS:-4}'
  dev:
    cpus: '\${SKILLSMITH_DOCKER_CPUS:-8}'
    mem_limit: \${SKILLSMITH_DOCKER_MEM:-6g}
`
    const result = checkDockerEnvDefaultCoherence(compose, MATCHING_SCHEMA)
    expect(result.ok).toBe(false)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toContain('docker-compose.yml says 8')
    expect(result.mismatches[0]).toContain('.env.schema says 4')
  })

  it('ignores a commented-out decoy line above the live line inside the dev block', () => {
    const compose = `
services:
  dev:
    # cpus: '\${SKILLSMITH_DOCKER_CPUS:-99}'
    cpus: '\${SKILLSMITH_DOCKER_CPUS:-4}'
    mem_limit: \${SKILLSMITH_DOCKER_MEM:-6g}
`
    expect(extractComposeDockerDefaults(compose)).toEqual({ cpus: '4', mem: '6g' })
  })

  it('accepts both keys unquoted', () => {
    const compose = `
services:
  dev:
    cpus: \${SKILLSMITH_DOCKER_CPUS:-4}
    mem_limit: \${SKILLSMITH_DOCKER_MEM:-6g}
`
    expect(extractComposeDockerDefaults(compose)).toEqual({ cpus: '4', mem: '6g' })
  })

  it('accepts both keys double-quoted', () => {
    const compose = `
services:
  dev:
    cpus: "\${SKILLSMITH_DOCKER_CPUS:-4}"
    mem_limit: "\${SKILLSMITH_DOCKER_MEM:-6g}"
`
    expect(extractComposeDockerDefaults(compose)).toEqual({ cpus: '4', mem: '6g' })
  })

  it('accepts quoting swapped from the repo convention (mem quoted, cpus unquoted)', () => {
    const compose = `
services:
  dev:
    cpus: \${SKILLSMITH_DOCKER_CPUS:-4}
    mem_limit: '\${SKILLSMITH_DOCKER_MEM:-6g}'
`
    expect(extractComposeDockerDefaults(compose)).toEqual({ cpus: '4', mem: '6g' })
  })

  it('rejects a mismatched quote pair rather than extracting a malformed value', () => {
    const compose = `
services:
  dev:
    cpus: '\${SKILLSMITH_DOCKER_CPUS:-4}"
    mem_limit: \${SKILLSMITH_DOCKER_MEM:-6g}
`
    expect(extractComposeDockerDefaults(compose)).toEqual({ cpus: null, mem: '6g' })
  })

  it('returns null for cpus when the dev block has no cpus key at all', () => {
    const compose = `
services:
  dev:
    mem_limit: \${SKILLSMITH_DOCKER_MEM:-6g}
`
    expect(extractComposeDockerDefaults(compose)).toEqual({ cpus: null, mem: '6g' })
  })

  it('returns null for an empty default value rather than an empty string', () => {
    const compose = `
services:
  dev:
    cpus: '\${SKILLSMITH_DOCKER_CPUS:-}'
    mem_limit: \${SKILLSMITH_DOCKER_MEM:-6g}
`
    expect(extractComposeDockerDefaults(compose)).toEqual({ cpus: null, mem: '6g' })
  })

  it('returns both null when there is no `dev` service at all', () => {
    const compose = `
services:
  test:
    cpus: '\${SKILLSMITH_DOCKER_CPUS:-4}'
`
    expect(extractComposeDockerDefaults(compose)).toEqual({ cpus: null, mem: null })
  })
})

describe('extractEnvSchemaDefault', () => {
  it('extracts "Default N" for CPU, stopping at the next whitespace', () => {
    expect(extractEnvSchemaDefault(MATCHING_SCHEMA, 'SKILLSMITH_DOCKER_CPUS')).toBe('4')
  })

  it('extracts "Default Xg" for memory, stopping at the trailing comma', () => {
    expect(extractEnvSchemaDefault(MATCHING_SCHEMA, 'SKILLSMITH_DOCKER_MEM')).toBe('6g')
  })

  it('returns null when the key does not exist', () => {
    expect(extractEnvSchemaDefault(MATCHING_SCHEMA, 'SKILLSMITH_NONEXISTENT')).toBeNull()
  })
})

describe('checkDockerEnvDefaultCoherence', () => {
  it('passes when docker-compose.yml and .env.schema agree', () => {
    const result = checkDockerEnvDefaultCoherence(MATCHING_COMPOSE, MATCHING_SCHEMA)
    expect(result.ok).toBe(true)
    expect(result.problems).toEqual([])
    expect(result.mismatches).toEqual([])
    expect(result.compose).toEqual({ cpus: '4', mem: '6g' })
    expect(result.schema).toEqual({ cpus: '4', mem: '6g' })
  })

  it('fails when the CPU defaults disagree', () => {
    const result = checkDockerEnvDefaultCoherence(MATCHING_COMPOSE, MISMATCHED_CPUS_SCHEMA)
    expect(result.ok).toBe(false)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toContain('SKILLSMITH_DOCKER_CPUS')
    expect(result.mismatches[0]).toContain('docker-compose.yml says 4')
    expect(result.mismatches[0]).toContain('.env.schema says 6')
  })

  it('reports a problem, not a false pass, when docker-compose.yml has no parseable default', () => {
    const result = checkDockerEnvDefaultCoherence(
      'services:\n  dev:\n    ports: []\n',
      MATCHING_SCHEMA
    )
    expect(result.ok).toBe(false)
    expect(result.problems.length).toBeGreaterThan(0)
    expect(result.mismatches).toEqual([])
  })
})

describe('SMI-6518: the real docker-compose.yml and .env.schema in this repo agree', () => {
  it('current SKILLSMITH_DOCKER defaults match across both files', () => {
    const composeContent = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8')
    const envSchemaContent = readFileSync(join(REPO_ROOT, '.env.schema'), 'utf8')
    const result = checkDockerEnvDefaultCoherence(composeContent, envSchemaContent)
    expect(result.problems).toEqual([])
    expect(result.mismatches).toEqual([])
    expect(result.ok).toBe(true)
  })
})
