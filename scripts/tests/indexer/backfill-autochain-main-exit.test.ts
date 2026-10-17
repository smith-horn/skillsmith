/**
 * SMI-7121: main() exit codes, driven end-to-end through a child process.
 *
 * `main()` is not exported, so the real entry point is spawned with SUPABASE_URL pointed
 * at a local HTTP server that answers the PostgREST reads recover() makes. A halt must
 * exit 3 and emit `autochain_halted`; an error must stay exit 1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '../../indexer/backfill-autochain-inputs.ts')

const dispatchInputs = {
  maxSkillsPerRepo: '50',
  pathPrefix: '.claude/skills',
  maxRanges: 10,
  minSizeBytes: 1024,
  maxSkillsPerDispatch: 5000,
  maxElapsedMinutes: 280,
  acceptTruncation: false,
  supabaseEnv: 'prod',
  tokenSource: 'backfill',
}
const baseCheckpoint = {
  run_id: 'r1',
  cursor: { path: '.claude/skills', facet: 'f3', last_page: 2 },
  facets_completed: 3,
  facets_total: 10,
  cap_saturated: false,
  truncated_repo_count: 0,
  incomplete_results_ranges: 0,
  dry_run: false,
  dispatch_inputs: dispatchInputs,
}
const counters = (over: Record<string, number> = {}) => ({
  admitted: 1,
  no_default_branch: 0,
  license_filtered: 0,
  ranges_crawled: 1,
  ...over,
})

let server: Server
let port = 0
/** What the fake PostgREST returns for the checkpoint read; null = zero rows. */
let checkpoint: Record<string, unknown> | null = null

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '')
    // postgrest-js maybeSingle() reads a JSON array: [] is zero rows, [row] is one.
    const rows =
      url.includes('indexer_backfill_checkpoint') && checkpoint ? [{ metadata: checkpoint }] : []
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(rows))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})
afterAll(() => {
  server.close()
})

interface MainResult {
  code: number | null
  stderr: string
  out: string
}

function runMain(env: Record<string, string>): Promise<MainResult> {
  const dir = mkdtempSync(join(tmpdir(), 'autochain-main-'))
  const outFile = join(dir, 'github_output')
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', script], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        SUPABASE_URL: `http://127.0.0.1:${port}`,
        SUPABASE_SERVICE_ROLE_KEY: 'k',
        RECOVERY_ENV: 'prod',
        GITHUB_OUTPUT: outFile,
        ...env,
      },
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => {
      let out = ''
      try {
        out = readFileSync(outFile, 'utf8')
      } catch {
        /* no output file written */
      }
      rmSync(dir, { recursive: true, force: true })
      resolve({ code, stderr, out })
    })
  })
}

describe('main() exit codes', () => {
  it('CONTROL: a clean checkpoint exits 0 and dispatches', async () => {
    checkpoint = {
      ...baseCheckpoint,
      dispatch_counters: counters(),
      resumed_from: { run_id: 'p', path: '.claude/skills' },
    }
    const r = await runMain({ COMPLETED_RUN_ID: 'r1' })
    expect(r.code, r.stderr).toBe(0)
    expect(r.out).toContain('skip<<EOF\nfalse\nEOF')
  })

  it('a halt exits 3, writes halted=true to GITHUB_OUTPUT and logs autochain_halted', async () => {
    checkpoint = {
      ...baseCheckpoint,
      dispatch_counters: counters({ license_filtered: 3 }),
      resumed_from: { run_id: 'p', path: '.claude/skills' },
    }
    const r = await runMain({ COMPLETED_RUN_ID: 'r1' })
    expect(r.code, r.stderr).toBe(3)
    expect(r.out).toContain('halted<<EOF\ntrue\nEOF')
    expect(r.out).toContain('skip<<EOF\ntrue\nEOF')
    expect(r.stderr).toContain('"event":"autochain_halted"')
    expect(r.stderr).toContain('license_filtered')
  })

  it('no checkpoint and no audit row exits 3 as no_progress_record', async () => {
    checkpoint = null
    const r = await runMain({ COMPLETED_RUN_ID: 'r1' })
    expect(r.code, r.stderr).toBe(3)
    expect(r.out).toContain('no_progress_record')
  })

  it('an error (missing COMPLETED_RUN_ID) stays exit 1', async () => {
    const r = await runMain({})
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('autochain_inputs_error')
  })

  it('an unknown acknowledgement exits 1 (error), not 3', async () => {
    checkpoint = { ...baseCheckpoint }
    const r = await runMain({ COMPLETED_RUN_ID: 'r1', ACKNOWLEDGE_HALTS: 'bogus' })
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/names an unknown halt .*bogus/)
  })
})
