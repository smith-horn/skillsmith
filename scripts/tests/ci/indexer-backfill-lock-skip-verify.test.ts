/**
 * SMI-6887: indexer-backfill.yml's "Verify PAT bucket and write step summary" step.
 *
 * A lock-skipped backfill dispatch prints exactly
 * {"event":"lock_held_by_other_run","request_id":"<id>"} and exits 0 without a GitHub
 * call. The step used to read its missing token_source as 'unknown' and fail the run,
 * which skipped the autochain link (it runs only after a green backfill) and stopped
 * the chain. The guard now ends that exact shape green. Every other response must
 * still reach the token_source check unchanged.
 *
 * These cases execute the step's real `run:` text from the workflow file under
 * `bash -e`, the shell GitHub uses. The guard runs under real `node`; the unchanged
 * path's `jq` calls resolve to the test shim (`_lib/fake-jq.cjs`, real jq is not in
 * the test image).
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureTempDir } from '../_lib/git-fixture-env.js'
import { extractStep } from '../_lib/workflow-yaml.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'indexer-backfill.yml')
const FAKE_JQ = join(REPO_ROOT, 'scripts', 'tests', '_lib', 'fake-jq.cjs')
const STEP = 'Verify PAT bucket and write step summary'

/** The RESPONSE of prod run 40345939525 (2026-10-26), the incident that stopped the chain. */
const PROD_LOCK_SKIP =
  '{"event":"lock_held_by_other_run","request_id":"47b0d229-7b79-4832-b513-f631157704c2"}'
const LOCK_LINE = 'Lock contention'

interface Result {
  status: number | null
  out: string
  summary: string
}

function runVerify(response: string): Result {
  const step = extractStep(readFileSync(WORKFLOW, 'utf8'), STEP)
  const dir = makeFixtureTempDir('backfill-lock-skip-verify')
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'jq'), `#!/bin/bash\nexec node "${FAKE_JQ}" "$@"\n`, 'utf8')
    chmodSync(join(bin, 'jq'), 0o755)
    const script = join(dir, 'step.sh')
    const summaryFile = join(dir, 'summary.md')
    writeFileSync(script, step.runScript, 'utf8')
    writeFileSync(summaryFile, '', 'utf8')
    const r = spawnSync('bash', ['-e', script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RESPONSE: response,
        DRY_RUN_INPUT: 'false',
        RESUME_FROM_INPUT: '40308406615',
        RUN_ID: '40345939525',
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    })
    return {
      status: r.status,
      out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
      summary: readFileSync(summaryFile, 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('SMI-6887: a lock-skipped backfill run ends green', () => {
  it('the exact prod lock-skip payload exits 0 with a lock-contention summary, not a token error', () => {
    const r = runVerify(PROD_LOCK_SKIP)
    expect(r.status).toBe(0)
    expect(r.summary).toContain(LOCK_LINE)
    expect(r.summary).toContain('request_id=47b0d229-7b79-4832-b513-f631157704c2')
    expect(r.out).toContain('::notice::Lock held by another run')
    expect(r.out).not.toContain('token_source is')
    expect(r.summary).not.toContain('| Token Source |')
  })

  it('CONTROL: a normal pat response still passes through the unchanged path', () => {
    const r = runVerify(
      JSON.stringify({ data: { backfill: { token_source: 'pat', current_facet: '7680-81' } } })
    )
    expect(r.status).toBe(0)
    expect(r.summary).toContain('| Token Source | pat |')
    expect(r.summary).not.toContain(LOCK_LINE)
  })
})

describe('SMI-6887: every other response still reaches the token_source check', () => {
  // Each is one step away from the producer's exact shape. All must fail as today.
  const nearMisses: Array<[string, Record<string, unknown> | unknown[], string]> = [
    ['missing request_id', { event: 'lock_held_by_other_run' }, 'unknown'],
    ['null request_id', { event: 'lock_held_by_other_run', request_id: null }, 'unknown'],
    ['numeric request_id', { event: 'lock_held_by_other_run', request_id: 7 }, 'unknown'],
    ['empty request_id', { event: 'lock_held_by_other_run', request_id: '' }, 'unknown'],
    ['markdown in request_id', { event: 'lock_held_by_other_run', request_id: 'a|b' }, 'unknown'],
    ['an extra key', { event: 'lock_held_by_other_run', request_id: 'r', extra: 1 }, 'unknown'],
    ['data: null', { event: 'lock_held_by_other_run', request_id: 'r', data: null }, 'unknown'],
    ['an empty data', { event: 'lock_held_by_other_run', request_id: 'r', data: {} }, 'unknown'],
    ['a meta object', { event: 'lock_held_by_other_run', request_id: 'r', meta: {} }, 'unknown'],
    ['another event', { event: 'lock_rpc_error', request_id: 'r' }, 'unknown'],
    ['a different-case event', { event: 'LOCK_HELD_BY_OTHER_RUN', request_id: 'r' }, 'unknown'],
    [
      'a lock line carrying an app token_source',
      {
        event: 'lock_held_by_other_run',
        request_id: 'r',
        data: { backfill: { token_source: 'app' } },
      },
      'app',
    ],
    ['a normal app response', { data: { backfill: { token_source: 'app' } } }, 'app'],
    ['an empty object', {}, 'unknown'],
  ]

  it.each(nearMisses)('%s fails with the token_source error', (_label, body, source) => {
    const r = runVerify(JSON.stringify(body))
    expect(r.status).toBe(1)
    expect(r.out).toContain(`token_source is '${source}' (expected 'pat')`)
    expect(r.summary).not.toContain(LOCK_LINE)
  })

  // PR #3179 gate. All but the last PARSE to a valid lock-skip object but are not the
  // producer's bytes, so only the byte compare rejects them. The last pins the exact event
  // check against a startsWith-style loosening. Only JSON.stringify({event, request_id})
  // passes.
  const sameValueOtherBytes: Array<[string, string]> = [
    ['an escaped request_id', '{"event":"lock_held_by_other_run","request_id":"\\u0072"}'],
    [
      'a duplicate event key',
      '{"event":"wrong","event":"lock_held_by_other_run","request_id":"r"}',
    ],
    ['a unicode-escaped event key', '{"\\u0065vent":"lock_held_by_other_run","request_id":"r"}'],
    ['reordered keys', '{"request_id":"r","event":"lock_held_by_other_run"}'],
    ['added whitespace', '{"event": "lock_held_by_other_run", "request_id": "r"}'],
    ['a suffixed event', '{"event":"lock_held_by_other_run_x","request_id":"r"}'],
  ]

  it.each(sameValueOtherBytes)('%s fails with the token_source error', (_label, response) => {
    const r = runVerify(response)
    expect(r.status).toBe(1)
    expect(r.out).toContain(`token_source is 'unknown' (expected 'pat')`)
    expect(r.summary).not.toContain(LOCK_LINE)
  })

  it('CONTROL: the producer bytes for the same request id pass', () => {
    const r = runVerify(JSON.stringify({ event: 'lock_held_by_other_run', request_id: 'r' }))
    expect(r.status).toBe(0)
    expect(r.summary).toContain(LOCK_LINE)
  })

  // Not JSON objects at all: the step must not end green. Real jq and the shim both
  // stop the step at the first field read, before the token message, so only the
  // exit status and the absent lock summary are asserted.
  const notObjects: Array<[string, string]> = [
    ['an empty response', ''],
    ['non-JSON text', 'not json'],
    ['a lock line with trailing garbage', `${PROD_LOCK_SKIP} trailing`],
    ['two lock lines on one line', `${PROD_LOCK_SKIP}${PROD_LOCK_SKIP}`],
    ['a JSON array', '[]'],
    ['a bare JSON string', '"lock_held_by_other_run"'],
  ]

  it.each(notObjects)('%s does not end green', (_label, response) => {
    const r = runVerify(response)
    expect(r.status).not.toBe(0)
    expect(r.summary).not.toContain(LOCK_LINE)
  })
})
