/**
 * publish.yml dependency-gating coverage for the audit-standards helpers.
 *
 * Two complementary helpers live here:
 *
 *   - `auditPublishYmlDependentGate` (SMI-5060/SMI-5066) — SOUNDNESS: any gate
 *     that EXISTS (a `needs.publish-<pkg>.result == 'skipped'` clause) must be
 *     paired with its `pre-publish-check.outputs.<key>-exists` predicate.
 *   - `auditPublishYmlRequiredGates` (SMI-5123) — POSITIVE COVERAGE: a gate that
 *     is REQUIRED (consumer depends on a publishable sibling) must not be
 *     MISSING. This guards the SMI-5123 bug where publish-cli depended on
 *     @skillsmith/mcp-server in package.json but had no gate on
 *     publish-mcp-server, so cli could publish a live dangling ref while
 *     mcp-server was skipped (cli@0.6.3 → mcp-server@^0.5.3 that didn't exist).
 *
 * The dependent-gate suite was relocated here from audit-standards.test.ts
 * (SMI-5141) — both suites cover the same publish.yml gating concern and that
 * file was over the 500-line CI gate.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  auditPublishYmlRequiredGates: (
    content: string,
    pkgJsons: Array<{ name: string; json: { dependencies?: Record<string, string> } }>
  ) => {
    required: Array<{ consumer: string; sibling: string; outputKey: string }>
    failures: Array<{ consumer: string; sibling: string; outputKey: string; reason: string }>
  }
  auditPublishYmlDependentGate: (content: string) => {
    matches: Array<{ lineno: number; line: string; pkg: string; outputKey: string }>
    failures: Array<{ lineno: number; line: string; pkg: string; outputKey: string }>
  }
  PUBLISH_JOB_TO_OUTPUT_ALIAS: Record<string, string>
}

const { auditPublishYmlRequiredGates, auditPublishYmlDependentGate, PUBLISH_JOB_TO_OUTPUT_ALIAS } =
  helpers

describe('auditPublishYmlRequiredGates (SMI-5123)', () => {
  // A correctly-gated cli job: needs: publish-mcp-server AND carries the
  // SMI-5060 paired predicate (mcp-exists output key per the alias map).
  const goodCliJob = [
    'jobs:',
    '  publish-cli:',
    '    needs: [pre-publish-check, validate, publish-core, publish-mcp-server]',
    '    if: |',
    "      (needs.publish-core.result == 'success' ||",
    "       (needs.publish-core.result == 'skipped' && needs.pre-publish-check.outputs.core-exists == 'true')) &&",
    "      (needs.publish-mcp-server.result == 'success' ||",
    "       (needs.publish-mcp-server.result == 'skipped' && needs.pre-publish-check.outputs.mcp-exists == 'true'))",
    '  publish-mcp-server:',
    '    needs: [pre-publish-check, validate, publish-core]',
  ].join('\n')

  const cliPkgs = [
    { name: '@skillsmith/cli', json: { dependencies: { '@skillsmith/mcp-server': '^0.5.3' } } },
    { name: '@skillsmith/mcp-server', json: { dependencies: {} } },
  ]

  it('passes when the cli→mcp gate is present (needs: + paired predicate)', () => {
    const { required, failures } = auditPublishYmlRequiredGates(goodCliJob, cliPkgs)
    expect(required).toHaveLength(1)
    expect(required[0]).toMatchObject({ consumer: 'cli', sibling: 'mcp-server', outputKey: 'mcp' })
    expect(failures).toHaveLength(0)
  })

  it('fails when the cli→mcp gate is missing entirely', () => {
    // publish-cli only gates on core — the SMI-5123 regression shape.
    const missingGate = [
      'jobs:',
      '  publish-cli:',
      '    needs: [pre-publish-check, validate, publish-core]',
      '    if: |',
      "      (needs.publish-core.result == 'success' ||",
      "       (needs.publish-core.result == 'skipped' && needs.pre-publish-check.outputs.core-exists == 'true'))",
      '  publish-mcp-server:',
      '    needs: [pre-publish-check, validate, publish-core]',
    ].join('\n')
    const { failures } = auditPublishYmlRequiredGates(missingGate, cliPkgs)
    // Two distinct failures: missing needs:, and missing paired predicate.
    expect(failures.length).toBeGreaterThanOrEqual(1)
    expect(failures.every((f) => f.consumer === 'cli' && f.sibling === 'mcp-server')).toBe(true)
  })

  it('ignores deps on non-publishable workspace packages', () => {
    // A dep that isn't itself in the publishable set must not require a gate.
    const pkgs = [
      { name: '@skillsmith/cli', json: { dependencies: { '@skillsmith/internal-lib': '^1.0.0' } } },
    ]
    const { required, failures } = auditPublishYmlRequiredGates(goodCliJob, pkgs)
    expect(required).toHaveLength(0)
    expect(failures).toHaveLength(0)
  })

  it('passes against the REAL publish.yml + real publishable package.json files', () => {
    const repoRoot = join(__dirname, '..', '..')
    const publishYml = readFileSync(join(repoRoot, '.github/workflows/publish.yml'), 'utf8')

    const publishableNames: string[] = JSON.parse(
      (publishYml.match(/PUBLISHABLE_PACKAGES_JSON:\s*'(\[[^']*\])'/) || [])[1] || '[]'
    )
    expect(publishableNames.length).toBeGreaterThan(0)

    const pkgJsons = publishableNames
      .map((name) => {
        const short = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
        const p = join(repoRoot, `packages/${short}/package.json`)
        return { name, json: JSON.parse(readFileSync(p, 'utf8')) }
      })
      .filter((x) => x.json)

    const { required, failures } = auditPublishYmlRequiredGates(publishYml, pkgJsons)
    // cli→core, cli→mcp-server, mcp-server→core, enterprise→core all required.
    expect(required.length).toBeGreaterThanOrEqual(1)
    expect(failures).toEqual([])
  })
})

/**
 * SMI-5066: regression tests for the generalized Check 48 helper. Background:
 * SMI-5060 introduced the paired-predicate invariant (every
 * `needs.publish-<pkg>.result == 'skipped'` clause must be guarded by
 * `pre-publish-check.outputs.<outputKey>-exists == 'true'` within ±1 line).
 * SMI-5066 generalized it from publish-core-only to any publish-<pkg>, with an
 * alias map for the pre-existing `publish-mcp-server` → `mcp-exists` outlier.
 *
 * These tests guard against future regressions in either the regex or the
 * alias-map convention.
 */
describe('auditPublishYmlDependentGate (SMI-5060/SMI-5066)', () => {
  it('PUBLISH_JOB_TO_OUTPUT_ALIAS maps mcp-server to mcp', () => {
    // The alias map exists to document and handle the convention drift
    // between the publish-* job name and the pre-publish-check output key.
    expect(PUBLISH_JOB_TO_OUTPUT_ALIAS['mcp-server']).toBe('mcp')
  })

  it('passes when publish-core skipped clause is paired with core-exists guard', () => {
    const yml = [
      'jobs:',
      '  publish-mcp-server:',
      '    if: |',
      "      (needs.publish-core.result == 'success' ||",
      "       (needs.publish-core.result == 'skipped' && needs.pre-publish-check.outputs.core-exists == 'true'))",
    ].join('\n')
    const { matches, failures } = auditPublishYmlDependentGate(yml)
    expect(matches).toHaveLength(1)
    expect(matches[0].pkg).toBe('core')
    expect(matches[0].outputKey).toBe('core')
    expect(failures).toHaveLength(0)
  })

  it('passes when publish-enterprise skipped clause is paired with enterprise-exists guard', () => {
    const yml = [
      'jobs:',
      '  publish-enterprise:',
      '    if: |',
      "      (needs.publish-core.result == 'success' ||",
      "       (needs.publish-core.result == 'skipped' && needs.pre-publish-check.outputs.core-exists == 'true'))",
    ].join('\n')
    const { matches, failures } = auditPublishYmlDependentGate(yml)
    expect(matches).toHaveLength(1)
    expect(matches[0].pkg).toBe('core')
    expect(matches[0].outputKey).toBe('core')
    expect(failures).toHaveLength(0)
  })

  it('passes when publish-mcp-server skipped clause is paired with mcp-exists guard (alias map)', () => {
    const yml = [
      'jobs:',
      '  publish-cli:',
      '    if: |',
      "      (needs.publish-mcp-server.result == 'success' ||",
      "       (needs.publish-mcp-server.result == 'skipped' && needs.pre-publish-check.outputs.mcp-exists == 'true'))",
    ].join('\n')
    const { matches, failures } = auditPublishYmlDependentGate(yml)
    expect(matches).toHaveLength(1)
    expect(matches[0].pkg).toBe('mcp-server')
    expect(matches[0].outputKey).toBe('mcp') // alias resolved
    expect(failures).toHaveLength(0)
  })

  it('fails when publish-core skipped clause has no paired guard', () => {
    const yml = [
      'jobs:',
      '  publish-mcp-server:',
      '    if: |',
      "      (needs.publish-core.result == 'success' ||",
      "       needs.publish-core.result == 'skipped')",
    ].join('\n')
    const { matches, failures } = auditPublishYmlDependentGate(yml)
    expect(matches).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0].pkg).toBe('core')
    expect(failures[0].outputKey).toBe('core')
  })

  it('fails when publish-enterprise skipped clause has no paired guard', () => {
    const yml = [
      'jobs:',
      '  publish-enterprise:',
      '    if: |',
      "      (needs.publish-core.result == 'success' ||",
      "       needs.publish-core.result == 'skipped')",
    ].join('\n')
    const { matches, failures } = auditPublishYmlDependentGate(yml)
    expect(matches).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0].pkg).toBe('core')
  })

  it('ignores comment-only lines containing the skipped phrase', () => {
    const yml = [
      'jobs:',
      "  # Documentation: when needs.publish-core.result == 'skipped' fires,",
      '  # the guard handles it.',
      '  publish-mcp-server:',
      "    if: needs.pre-publish-check.outputs.mcp-exists != 'true'",
    ].join('\n')
    const { matches, failures } = auditPublishYmlDependentGate(yml)
    expect(matches).toHaveLength(0)
    expect(failures).toHaveLength(0)
  })

  it('fails when paired guard is more than ±1 line away from the skipped clause', () => {
    // The window is intentionally tight (±1 line) to match the canonical YAML
    // shape produced by gh actions multi-line `if: |` blocks. A guard that
    // drifts farther is a smell — either the YAML restructured or the guard
    // was decoupled.
    const yml = [
      'jobs:',
      '  publish-mcp-server:',
      '    if: |',
      "      (needs.publish-core.result == 'success' ||",
      "       needs.publish-core.result == 'skipped') &&",
      '      true &&',
      '      true &&',
      "      needs.pre-publish-check.outputs.core-exists == 'true'",
    ].join('\n')
    const { failures } = auditPublishYmlDependentGate(yml)
    expect(failures).toHaveLength(1)
  })
})
