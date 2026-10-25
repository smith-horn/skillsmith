/**
 * scripts/lib/audit-report.mjs + scripts/ci/audit-summary.mjs (SMI-7174).
 *
 * T6  Status comes from exit_code, not the report's status string.
 * T7  every report state renders without throwing, with the right text: missing, empty,
 *     {}, {"summary":null}, truncated, two concatenated objects, summary_found false,
 *     a passing and a failing report.
 * T10 readCounts accepts only the exact shape the audit writes.
 * T11 the summary CLI exits 0 even when rendering throws.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtureTempDir } from './_lib/git-fixture-env'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'ci', 'audit-summary.mjs')

type Counts = { passed: number; warnings: number; failed: number; score: number }
const mod = (await import('../lib/audit-report.mjs')) as {
  readCounts: (t: unknown) => Counts | null
  renderSummary: (p: string, o?: { readFile?: (p: string) => string }) => string
}

const COUNTS: Counts = { passed: 93, warnings: 15, failed: 1, score: 85 }
const report = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    timestamp: 't',
    exit_code: 0,
    status: 'passed',
    summary_found: true,
    summary: COUNTS,
    output: '',
    ...over,
  })
const render = (text: string) => mod.renderSummary('r.json', { readFile: () => text })

describe('readCounts (T10)', () => {
  it('accepts the shape the audit writes', () => {
    expect(mod.readCounts(JSON.stringify(COUNTS))).toEqual(COUNTS)
  })
  it.each([
    ['empty', ''],
    ['null', 'null'],
    ['{}', '{}'],
    ['array', '[1,2,3,4]'],
    ['a missing field', '{"passed":93,"warnings":15,"failed":1}'],
    ['a string', '{"passed":"93","warnings":15,"failed":1,"score":85}'],
    ['a non-integer', '{"passed":92.5,"warnings":15,"failed":1,"score":85}'],
    ['a negative', '{"passed":-1,"warnings":15,"failed":1,"score":85}'],
    ['score over 100', '{"passed":93,"warnings":15,"failed":1,"score":101}'],
    ['truncated', '{"passed":93,"warn'],
  ])('rejects %s', (_label, text) => {
    expect(mod.readCounts(text)).toBeNull()
  })
})

describe('renderSummary (T6, T7)', () => {
  it('valid passing report: the table, no reproduce line', () => {
    const md = render(report())
    expect(md).toContain('## Standards Audit Results')
    expect(md).toContain("Pass/fail comes from the 'Run standards audit' step")
    expect(md).toContain('| Status | Passed |')
    expect(md).toContain('| Compliance Score | 85% |')
    expect(md).toContain('| Passed | 93 |')
    expect(md).toContain('| Warnings | 15 |')
    expect(md).toContain('| Failed | 1 |')
    expect(md).not.toContain('Reproduce locally')
    expect(md).toContain('`audit-report` artifact')
  })

  it('T6: Status follows exit_code even when the status string disagrees', () => {
    expect(render(report({ exit_code: 1, status: 'passed' }))).toContain('| Status | Failed |')
    expect(render(report({ exit_code: 0, status: 'failed' }))).toContain('| Status | Passed |')
  })

  it('failing report adds the reproduce commands', () => {
    const md = render(report({ exit_code: 1, status: 'failed' }))
    expect(md).toContain('Reproduce locally')
    expect(md).toContain('./scripts/worktree-docker.sh exec -- npm run audit:standards')
  })

  it('summary_found false: says so and shows no counts', () => {
    const md = render(report({ exit_code: 1, summary_found: false, summary: null }))
    expect(md).toContain('The audit did not print its summary (exit 1)')
    expect(md).not.toMatch(/^\| Passed \| \d/m)
  })

  it('missing report', () => {
    const md = mod.renderSummary('r.json', {
      readFile: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      },
    })
    expect(md).toContain('Audit report not generated.')
  })

  it.each([
    ['empty', '', 'could not be parsed'],
    ['truncated', '{"exit_code":0,"summ', 'could not be parsed'],
    ['two concatenated objects', report() + report(), 'could not be parsed'],
    ['{}', '{}', 'unexpected shape'],
    ['summary null with found true', report({ summary: null }), 'unexpected shape'],
    ['found false with counts', report({ summary_found: false }), 'unexpected shape'],
    ['non-integer exit_code', report({ exit_code: '0' }), 'unexpected shape'],
  ])('%s: never throws, says it is unreadable', (_label, text, want) => {
    const md = render(text)
    expect(md).toContain(want)
    expect(md).not.toMatch(/^\| Passed \| \d/m)
  })
})

describe('audit-summary CLI (T11)', () => {
  let dir = ''
  beforeAll(() => {
    dir = makeFixtureTempDir('smi7174-sum-')
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('prints the table and exits 0 for a valid report', () => {
    writeFileSync(join(dir, 'ok.json'), report())
    const r = spawnSync('node', [CLI, join(dir, 'ok.json')], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('| Passed | 93 |')
  })

  it.each([
    ['missing', 'missing.json', 'Audit report not generated.'],
    ['a directory (read throws EISDIR)', 'adir', 'Cannot read the report'],
  ])('exits 0 for %s', (_label, name, want) => {
    if (name === 'adir') mkdirSync(join(dir, 'adir'), { recursive: true })
    const r = spawnSync('node', [CLI, join(dir, name)], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(want)
  })

  it('exits 0 even when rendering itself throws', () => {
    // renderSummary catches read and parse errors itself, so to reach the CLI's own
    // catch-all, break a call it makes outside those: validReport's JSON.stringify.
    writeFileSync(join(dir, 'boom.mjs'), "JSON.stringify = () => { throw new TypeError('boom') }\n")
    writeFileSync(join(dir, 'x.json'), report())
    const r = spawnSync('node', ['--import', join(dir, 'boom.mjs'), CLI, join(dir, 'x.json')], {
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Could not render the summary: boom')
  })

  it('T14: exits 0 even when every write to stdout throws', () => {
    writeFileSync(
      join(dir, 'nowrite.mjs'),
      [
        "const boom = () => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) }",
        'console.log = boom',
        'process.stdout.write = boom',
      ].join('\n') + '\n'
    )
    writeFileSync(join(dir, 'y.json'), report())
    const r = spawnSync('node', ['--import', join(dir, 'nowrite.mjs'), CLI, join(dir, 'y.json')], {
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
  })

  // A copy of the real CLI beside a broken or missing renderer module.
  it.each([
    ['broken (syntax error)', 'export const = ;\n'],
    ['missing', null],
  ])('T13: exits 0 when the renderer module is %s', (_label, body) => {
    const root = join(dir, `t13-${body === null ? 'missing' : 'broken'}`)
    mkdirSync(join(root, 'ci'), { recursive: true })
    mkdirSync(join(root, 'lib'), { recursive: true })
    copyFileSync(CLI, join(root, 'ci', 'audit-summary.mjs'))
    if (body !== null) writeFileSync(join(root, 'lib', 'audit-report.mjs'), body)
    const r = spawnSync('node', [join(root, 'ci', 'audit-summary.mjs'), join(dir, 'none.json')], {
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Could not render the summary')
  })
})
