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
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
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

// SMI-7226: the lexer's contexts. Each row is [name, text, expected hit count,
// yaml]. The must-flag rows that run as whole commands were checked against
// bash 5.2 with a stub npx (see the SMI-7223 plan, Addendum A).
type LexRow = [string, string, number, boolean?]
const LEXER_ROWS: LexRow[] = [
  // Here-strings are not heredocs; real heredocs stay hidden.
  ['here-string word', 'cat <<<foo\nnpx supabase deploy\nfoo', 1],
  ['here-string EOF', 'read x <<<EOF\nnpx supabase deploy', 1],
  ['here-string quoted', 'read x <<< "$v"\nnpx supabase deploy', 1],
  ['real heredoc hidden', 'cat <<EOF\nnpx supabase deploy\nEOF', 0],
  ['real <<- heredoc hidden', 'cat <<-EOF\n\tnpx supabase deploy\n\tEOF', 0],
  ['heredoc after a here-string', 'read x <<<y; cat <<EOF\nnpx supabase deploy\nEOF', 0],
  ['two heredocs on one line', 'cat <<A <<B\nfirst\nA\nnpx supabase prose\nB', 0],
  ['quoted <<EOF is not a heredoc', 'echo "<<EOF"\nnpx supabase deploy', 1],
  ['heredoc in a trailing comment', 'echo hi # cat <<EOF\nnpx supabase s', 1],
  // Arithmetic: << is a shift, and $(( is arithmetic only when it closes as )).
  ['numeric shift', 'x=$((1<<2))\nnpx supabase deploy', 1],
  ['identifier shift', 'x=$((a<<b))\nnpx supabase deploy', 1],
  ['$[ ] shift', 'x=$[a<<EOF]\nnpx supabase status', 1],
  ['heredoc in $( ) inside (( ))', '(( x = $(cat <<EOF\nnpx supabase prose\nEOF\n) ))', 0],
  ['(( )) test', 'if (( a < b )); then npx supabase status; fi', 1],
  ['for (( )) loop', 'for ((i=0;i<3;i++)); do npx supabase s; done', 1],
  ['nested parens in $(( ))', 'x=$(( (1+2) * 3 )); npx supabase s', 1],
  ['spaced shift in $(( ))', 'echo $(( 1 << 2 )) && npx supabase s', 1],
  ['$(( that bash reads as $( (', 'x=$((echo hi; npx supabase status) )', 1],
  ['$((( nested subshell', 'x=$(((echo hi); npx supabase status) )', 1],
  ['(( as two subshells', '((echo a); npx supabase s)', 1],
  ['unclosed $(( fails closed', 'x=$((npx supabase status', 1],
  ['arithmetic in "…" is not a command', 'echo "$((1+2)) npx supabase"', 0],
  // Command substitution inside "…" runs a command.
  ['"$( )" assignment', 'x="$(npx supabase --version)"', 1],
  ['"$( )" echo', 'echo "$(npx supabase v)"', 1],
  ['backtick in "…"', 'echo "`npx supabase v`"', 1],
  ['unquoted backtick', 'v=`npx supabase s`', 1],
  ['subshell in "$( )"', 'x="$( (cd a && npx supabase status) )"', 1],
  ['nested quotes in "$( )"', 'x="$(echo "npx supabase")"', 0],
  ['text after "$( )" closes', 'echo "$(date) npx supabase"', 0],
  ['escaped \\$(', 'echo "\\$(npx supabase)"', 0],
  ["'$( )' is literal", "echo '$(npx supabase)'", 0],
  ['plain "…" prose', 'echo "npx supabase deploy"', 0],
  // case…esac: a pattern's ) does not close a substitution.
  ['case in "$( )"', 'x="$(case x in a) npx supabase status;; esac)"', 1],
  ['top-level case arm', 'case "$x" in a) npx supabase status ;; esac', 1],
  ['case after then', 'if x; then case $y in a) npx supabase s;; esac; fi', 1],
  ['echo case is a word', 'x="$(echo case) npx supabase status"', 0],
  ['x=case is a word', 'x="$(y=case; echo) npx supabase status"', 0],
  ['esac as an argument', 'x="$(case a in a) echo esac;; esac) npx supabase s"', 0],
  ['case word in "…" prose', 'echo "case a) npx supabase"', 0],
  // YAML run: values are decoded before scanning (workflow and action files).
  ['yaml single-quoted', "run: 'npx supabase deploy'", 1, true],
  ['yaml double-quoted', 'run: "npx supabase deploy"', 1, true],
  ['yaml list item', '  - run: "npx supabase status"', 1, true],
  ['yaml \\x escape', 'run: "\\x6epx supabase status"', 1, true],
  ['yaml \\u escape', 'run: "\\u006epx supabase status"', 1, true],
  ['yaml multi-line scalar', 'run: "npx supabase\n  status"', 1, true],
  ['yaml line after a decoded run:', 'run: "echo hi"\nnpx supabase s', 1, true],
  ['yaml block scalar', 'run: |\n  npx supabase status', 1, true],
  ['yaml inner "…" prose', `run: 'echo "npx supabase"'`, 0, true],
  ["yaml doubled ''", "run: 'echo ''npx supabase'''", 0, true],
  ['yaml escaped \\"', 'run: "echo \\"npx supabase\\""', 0, true],
  ['yaml trailing comment', "run: 'echo hi' # npx supabase", 0, true],
  ['yaml other key', 'name: "npx supabase deploy"', 0, true],
  ['yaml multi-line prose', 'run: "echo \'npx supabase\'\n  done"', 0, true],
  ['yaml unterminated at EOF', 'run: "npx supabase', 0, true],
  ['yaml quoting is not decoded in .sh', 'run: "npx supabase deploy"', 0],
  // Governance review of 1703b283d (SMI-7226): each row checked against bash 5.2.
  ['heredoc tag with -', 'cat <<END-OF\nhello\nEND-OF\nnpx supabase status', 1],
  [
    'quoted heredoc tag with -',
    "cat <<'END-OF'\nnpx supabase prose\nEND-OF\nnpx supabase status",
    1,
  ],
  ['"…" heredoc tag with -', 'cat <<"END-OF"\nnpx supabase prose\nEND-OF', 0],
  ['backslashed heredoc tag', 'cat <<\\EOF\nnpx supabase prose\nEOF\nnpx supabase status', 1],
  [
    '<<- strips tabs, then resumes',
    'cat <<-EOF\n\tnpx supabase prose\n\tEOF\nnpx supabase status',
    1,
  ],
  ['an indented delimiter does not end <<', 'cat <<EOF\n  EOF\nnpx supabase prose\nEOF', 0],
  ['bash -lc', 'bash -lc "npx supabase status"', 1],
  ['sh -ec', "sh -ec 'npx supabase status'", 1],
  ['bash -o pipefail -c', 'bash -o pipefail -c "npx supabase status"', 1],
  ['bash -l runs a script, not a command', 'bash -l "npx supabase status"', 0],
  [
    'nested case after a pattern',
    'x="$(case $a in b) case $c in d) :;; esac;; e) npx supabase status;; esac)"',
    1,
  ],
  ['npx --prefix value', 'npx --prefix ./x supabase status', 1],
  ['quoted tool word', 'npx "supabase" status', 1],
  ['@latest is not a pin', 'npx supabase@latest status', 1],
  ['@major is not a pin', 'npx wrangler@3 deploy', 1],
  ['backslash-newline joins with no space', 'npx\\\nsupabase status', 0],
  ['space before the backslash survives', 'npx \\\nsupabase status', 1],
  ['parens inside $(( )) before <<', 'x=$(( (1+(2)) <<EOF ))\nnpx supabase s', 1],
  ['$(( inside "…" before <<', 'echo "$(( 1<<EOF ))"\nnpx supabase s', 1],
  ['yaml folded >-', 'run: >-\n  npx\n  supabase status', 1, true],
  ['yaml folded > in a list', '  - run: >\n      npx\n      supabase status', 1, true],
  ['yaml plain multi-line', 'run: npx\n  supabase status', 1, true],
  ['yaml literal | keeps lines apart', 'run: |\n  npx\n  supabase status', 0, true],
  ['yaml literal | comment', 'run: |\n  # npx supabase status\n  echo ok', 0, true],
  [
    'yaml sibling key ends the block',
    "- run: echo 'npx supabase status'\n  name: npx supabase status",
    1,
    true,
  ],
  // Confirmation review of 3674b5722 (SMI-7226): each shell row checked against bash 5.2.
  ['bash -ce', "bash -ce 'npx supabase x'", 1],
  ['bash -c -e', "bash -c -e 'npx supabase x'", 1],
  ['bash -c --', "bash -c -- 'npx supabase x'", 1],
  ['/bin/bash -c', "/bin/bash -c 'npx supabase x'", 1],
  ['bash -O extglob -c', "bash -O extglob -c 'npx supabase x'", 1],
  ['bash script.sh is not -c', 'bash script.sh "npx supabase x"', 0],
  ['CRLF heredoc closes', 'cat <<EOF\r\nhi\r\nEOF\r\nnpx supabase y\r\n', 1],
  [
    'CRLF yaml literal heredoc',
    'run: |\r\n  cat <<EOF\r\n  hi\r\n  EOF\r\n  npx supabase y\r\n',
    1,
    true,
  ],
  ['unquoted heredoc body $( )', 'cat <<EOF\n$(npx supabase x)\nEOF', 1],
  ['unquoted heredoc body backtick', 'cat <<EOF\n`npx supabase x`\nEOF', 1],
  ['unquoted heredoc body prose', 'cat <<EOF\nrun npx supabase x "here"\nEOF', 0],
  ['quoted heredoc body $( ) is literal', "cat <<'EOF'\n$(npx supabase x)\nEOF", 0],
  ['escaped \\$( in a heredoc body', 'cat <<EOF\n\\$(npx supabase x)\nEOF', 0],
  ['-p another package', 'npx -p foo supabase x', 1],
  ['--package=another', 'npx --package=foo supabase x', 1],
  ['-p exact pin of the tool', 'npx -p supabase@2.111.0 supabase db push', 0],
  ['-p floating tool', 'npx -p supabase@latest supabase db push', 1],
  ['pin inside $( )', 'v=$(npx supabase@2.111.0)', 0],
  ['pin before ;', 'npx supabase@2.111.0;echo', 0],
  ['pin before |', 'npx supabase@2.111.0|jq', 0],
  ['pin before &&', 'npx supabase@2.111.0&&echo', 0],
  ['prerelease pin', 'npx supabase@2.111.0-beta.1 x', 0],
  ['build metadata pin', 'npx supabase@2.111.0+b1 x', 0],
  ['four-part version is not a pin', 'npx supabase@2.111.0.1 x', 1],
  ['mismatched quotes around the tool', `npx "supabase' x`, 0],
  ['<<- ignores a space-indented delimiter', 'cat <<-EOF\n  EOF\nnpx supabase prose\n\tEOF', 0],
]

describe('scanShellText lexer contexts (SMI-7226)', () => {
  it.each(LEXER_ROWS)('%s', (_name, text, want, yaml) => {
    expect(scanShellText(text, { yaml: yaml === true })).toHaveLength(want)
  })

  it('reports a literal | block hit at its physical line', () => {
    const hits = scanShellText('steps:\n  - run: |\n      echo a\n\n      npx supabase status\n', {
      yaml: true,
    })
    expect(hits.map((h: { line: number }) => h.line)).toEqual([5])
  })

  it('reports a decoded YAML run: hit at the run: line', () => {
    const hits = scanShellText('steps:\n  - run: "echo a"\n  - run: "npx supabase\n      status"', {
      yaml: true,
    })
    expect(hits.map((h: { line: number }) => h.line)).toEqual([3])
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

  // SMI-7226: composite actions are scanned, and YAML quoting is decoded only
  // in YAML files.
  it('scans composite actions and decodes quoted run: only in YAML', () => {
    repo = makeRepo({
      '.github/actions/a/action.yml': 'runs:\n  steps:\n    - run: "npx supabase status"\n',
      '.github/workflows/w.yml': "jobs:\n  x:\n    steps:\n      - run: 'npx wrangler deploy'\n",
      'scripts/s.sh': 'run: "npx supabase status"\n',
    })
    const { findings, scanned } = findBareNpxCliInShellAndWorkflows(repo, { env })
    expect(scanned).toBe(3)
    expect(
      findings.map((f: { file: string; line: number }) => `${f.file}:${f.line}`).sort()
    ).toEqual(['.github/actions/a/action.yml:3', '.github/workflows/w.yml:4'])
  })

  it('returns no findings for a clean tree', () => {
    repo = makeRepo({ 'scripts/a.sh': 'supabase link\n' })
    expect(findBareNpxCliInShellAndWorkflows(repo, { env })).toEqual({
      findings: [],
      scanned: 1,
      via: 'git',
      unreadable: [],
    })
  })

  // SMI-7226: a listed file that can't be read is reported, not counted.
  it('reports an unreadable tracked file instead of counting it as scanned', () => {
    repo = makeRepo({ 'scripts/a.sh': 'echo ok\n' })
    symlinkSync('does-not-exist.sh', join(repo, 'scripts', 'gone.sh'))
    execFileSync('git', ['add', '-A'], { cwd: repo, env })
    expect(findBareNpxCliInShellAndWorkflows(repo, { env })).toEqual({
      findings: [],
      scanned: 1,
      via: 'git',
      unreadable: ['scripts/gone.sh'],
    })
  })

  // A worktree container can't resolve its gitdir; the scan must still run.
  it('falls back to a filesystem walk when git cannot answer', () => {
    repo = makeFixtureTempDir('smi7223-nogit-')
    writeTree(repo, {
      'scripts/a.sh': 'npx supabase link\n',
      'scripts/node_modules/x/b.sh': 'npx supabase link\n',
      '.github/workflows/w.yaml': '      - run: npx wrangler deploy\n',
      '.github/actions/b/action.yaml': '    - run: npx supabase status\n',
      'docs/c.sh': 'npx supabase link\n',
    })
    const { findings, scanned, via } = findBareNpxCliInShellAndWorkflows(repo, { env })
    expect(via).toBe('filesystem')
    expect(scanned).toBe(3)
    expect(findings.map((f: { file: string }) => f.file).sort()).toEqual([
      '.github/actions/b/action.yaml',
      '.github/workflows/w.yaml',
      'scripts/a.sh',
    ])
  })
})
