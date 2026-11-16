/**
 * Tests for the SMI-7223 shell sub-check of audit-standards.mjs Check 59.
 *
 * A bare `npx supabase` with no local package downloads registry-latest and
 * ignores the pinned CLI on PATH; that took down every edge-function deploy
 * on 2026-11-16. The case table below is the one the SMI-7223 plan review
 * settled on (three cross-family rounds), plus the two round-3 inputs.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'
// @ts-expect-error - .mjs helper has no typings
import {
  scanShellText,
  findBareNpxCliInShellAndWorkflows,
} from '../audit-shell-npx-cli-helpers.mjs'

const MUST_FLAG: string[] = [
  'npx supabase db push',
  'X=1 npx supabase link',
  '  SUPABASE_DB_PASSWORD="$P" npx supabase db push --linked',
  'if npx supabase "${args[@]}" 2>&1; then',
  'v=$(npx wrangler whoami)',
  'foo && npx supabase start',
  'run: npx --yes supabase functions deploy',
  '! npx supabase status',
  'exec npx supabase functions deploy foo',
  'time npx supabase status',
  'env X=1 npx supabase link',
  'sudo npx supabase status',
  'sudo -E npx supabase status',
  'bash -c "npx supabase status"',
  "sh -c 'npx wrangler deploy'",
  "printf '%s\\n' foo | xargs npx supabase",
  'npx \\\n  supabase status',
  'npx --yes=true supabase status',
  'elif npx supabase status; then',
  '{ npx supabase status; }',
  'nice npx supabase status',
  'nice -n 5 npx supabase status',
  'timeout 30 npx supabase status',
  'stdbuf -oL npx wrangler tail',
  'flock /tmp/l npx supabase db push',
  'run: |\n  echo start\n  npx supabase status',
  // Round 3: a quoted command word is still the command.
  '"npx" supabase status',
  "'npx' wrangler deploy",
]

const MUST_NOT_FLAG: string[] = [
  '# npx supabase db push',
  '    # Why not a bare `npx supabase db push`',
  `error "Apply 074 first via 'npx supabase db push --db-url URL'."`,
  'npx supabase@2.111.0 db push',
  'npx supabasefoo',
  'npx supabase-cli thing',
  'echo "npx supabase functions deploy <name>"',
  'node_modules/.bin/supabase db push',
  "cat <<'EOF'\nnpx supabase status\nEOF",
  'cat <<-EOF\n\tnpx supabase status\n\tEOF',
  "echo 'hint: npx supabase start'",
  'log "run npx wrangler deploy to fix"',
  'foo # then npx supabase status',
  // Round 3: ANSI-C quoting, with an escaped quote inside it.
  "echo $'don\\'t npx supabase status'",
  // A quoted command word inside a larger quoted string is still prose.
  `echo "use 'npx' supabase locally"`,
]

describe('scanShellText (SMI-7223)', () => {
  it.each(MUST_FLAG)('flags %j', (text) => {
    const hits = scanShellText(text)
    expect(hits).toHaveLength(1)
    expect(['supabase', 'wrangler']).toContain(hits[0].tool)
  })

  it.each(MUST_NOT_FLAG)('does not flag %j', (text) => {
    expect(scanShellText(text)).toEqual([])
  })

  it('resumes after a heredoc closes and reports the physical line', () => {
    const hits = scanShellText('cat <<EOF\nnpx supabase a\nEOF\nnpx supabase b')
    expect(hits.map((h: { line: number }) => h.line)).toEqual([4])
  })

  it('reports a continued command at its first physical line', () => {
    const hits = scanShellText('echo hi\nnpx \\\n  supabase status')
    expect(hits.map((h: { line: number }) => h.line)).toEqual([2])
  })

  // Presence control: main's two scripts as they were before SMI-7223.
  it("finds the five call sites in main's pre-fix scripts", () => {
    const dir = join(__dirname, 'fixtures', 'smi-7223')
    const deploy = scanShellText(
      readFileSync(join(dir, 'deploy-edge-functions.main.sh.txt'), 'utf8')
    )
    const staging = scanShellText(readFileSync(join(dir, 'validate-staging.main.sh.txt'), 'utf8'))
    expect(deploy.map((h: { line: number }) => h.line)).toEqual([202])
    expect(staging.map((h: { line: number }) => h.line)).toEqual([25, 36, 42, 44])
  })
})

describe('findBareNpxCliInShellAndWorkflows (SMI-7223)', () => {
  let repo: string | undefined
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
    repo = undefined
  })

  const env = makeFixtureEnv()

  function writeTree(dir: string, files: Record<string, string>): void {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true })
      writeFileSync(join(dir, rel), body)
    }
  }

  function makeRepo(files: Record<string, string>): string {
    const dir = makeFixtureTempDir('smi7223-')
    execFileSync('git', ['init', '-q'], { cwd: dir, env })
    writeTree(dir, files)
    execFileSync('git', ['add', '-A'], { cwd: dir, env })
    return dir
  }

  it('scans tracked nested scripts and workflows, and reports what it scanned', () => {
    repo = makeRepo({
      'scripts/deep/a.sh': 'echo ok\nnpx supabase link\n',
      'scripts/b.sh': 'node_modules/.bin/supabase link\n',
      '.github/workflows/w.yml': 'jobs:\n  x:\n    steps:\n      - run: npx wrangler deploy\n',
      'docs/c.sh': 'npx supabase link\n',
    })
    const { findings, scanned, via } = findBareNpxCliInShellAndWorkflows(repo, { env })
    expect(via).toBe('git')
    expect(scanned).toBe(3)
    expect(
      findings.map((f: { file: string; line: number }) => `${f.file}:${f.line}`).sort()
    ).toEqual(['.github/workflows/w.yml:4', 'scripts/deep/a.sh:2'])
  })

  it('returns no findings for a clean tree', () => {
    repo = makeRepo({ 'scripts/a.sh': 'supabase link\n' })
    expect(findBareNpxCliInShellAndWorkflows(repo, { env })).toEqual({
      findings: [],
      scanned: 1,
      via: 'git',
    })
  })

  // A worktree container can't resolve its gitdir; the scan must still run.
  it('falls back to a filesystem walk when git cannot answer', () => {
    repo = makeFixtureTempDir('smi7223-nogit-')
    writeTree(repo, {
      'scripts/a.sh': 'npx supabase link\n',
      'scripts/node_modules/x/b.sh': 'npx supabase link\n',
      '.github/workflows/w.yaml': '      - run: npx wrangler deploy\n',
      'docs/c.sh': 'npx supabase link\n',
    })
    const { findings, scanned, via } = findBareNpxCliInShellAndWorkflows(repo, { env })
    expect(via).toBe('filesystem')
    expect(scanned).toBe(2)
    expect(findings.map((f: { file: string }) => f.file).sort()).toEqual([
      '.github/workflows/w.yaml',
      'scripts/a.sh',
    ])
  })
})
