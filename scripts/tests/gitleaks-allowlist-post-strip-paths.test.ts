/**
 * Regression test for SMI-6287 (Area 5 of the 2026-08 CI-failure remediation
 * plan — docs/internal/implementation/smi-6282-ci-failure-cluster-2026-08-remediation.md).
 *
 * Background: scripts/mirror-mcp-server.sh assembles the public mcp-server
 * mirror tree via `git archive --format=tar HEAD -- packages/mcp-server |
 * tar -x --strip-components=2 -C "$TREE_DIR"` — every git-tracked file under
 * packages/mcp-server/ is RELOCATED two path segments shorter in the mirror
 * tree (e.g. packages/mcp-server/src/assets/typosquat-reference-snapshot.json
 * becomes src/assets/typosquat-reference-snapshot.json). .gitleaks.toml's
 * vercel-token allowlist had a `paths` entry scoped to the PRE-strip location
 * only, so every mirror sync since that file was populated with live content
 * failed gitleaks' leak-audit gate — confirmed live by running the CI-pinned
 * gitleaks v8.21.2 directly against an assembled mirror tree (this exact
 * rule/file was the only finding) both before and after the fix.
 *
 * This test is broader than "just this one file": it asserts that ANY
 * .gitleaks.toml allowlist `paths` regex rooted at `packages/mcp-server/`
 * (i.e. literally scoped to the pre-strip location) has a corresponding
 * entry — in the SAME rule's allowlist config — that also covers the
 * post-strip relocated path. This guards against a FUTURE addition of a new
 * packages/mcp-server-rooted allowlist path entry that forgets its post-strip
 * counterpart, not just re-verifying today's single instance.
 *
 * Deliberately regex-based, not a real TOML parser: smol-toml exists in this
 * repo only as a root npm `overrides` pin for a transitive Vercel tool
 * dependency, not a confirmed real dependency of any Skillsmith package (see
 * packages/core/src/install/agent-config-merge.toml-block.ts's own header,
 * which reaches the identical conclusion independently) — adding a real TOML
 * dependency here is a lockfile-risk change out of scope for a test file.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeFixtureEnv } from './_lib/git-fixture-env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const GITLEAKS_TOML_PATH = resolve(REPO_ROOT, '.gitleaks.toml')

const MIRROR_SUBDIR = 'packages/mcp-server'
const MIRROR_ROOT_PREFIX = `${MIRROR_SUBDIR}/`
// SMI-5629: two path components (packages/mcp-server) are stripped by the
// mirror script's own `tar --strip-components=2` — kept in sync here as a
// literal, not derived, since the mirror script hardcodes the same value
// for the same reason (see scripts/mirror-mcp-server.sh's own comment at
// the git-archive call site).
const STRIP_COMPONENTS = 2

interface RuleChunk {
  /** e.g. `id = "vercel-token"`, or `[allowlist]` for the global block. */
  label: string
  pathsRegexes: string[]
}

/**
 * Split .gitleaks.toml into per-[[rules]] chunks plus the single global
 * [allowlist] chunk (both are top-level, column-0 headers — a nested
 * [[rules.allowlists]] header or a `paths = [` field never triggers a
 * split), and extract every `paths = [...]` array's ''' '''-delimited
 * regex-string entries within each chunk.
 */
function parseRuleChunks(src: string): RuleChunk[] {
  const lines = src.split('\n')
  const chunks: { label: string; body: string[] }[] = []
  let current: string[] = []
  let started = false

  const isTopLevelHeader = (line: string) =>
    /^\[\[rules\]\]\s*$/.test(line) || /^\[allowlist\]\s*$/.test(line)

  for (const line of lines) {
    if (isTopLevelHeader(line)) {
      if (started) chunks.push({ label: current[0], body: current })
      current = [line]
      started = true
      continue
    }
    if (started) current.push(line)
  }
  if (started) chunks.push({ label: current[0], body: current })

  return chunks.map(({ label, body }) => {
    const bodyText = body.join('\n')
    // Prefer the rule's own `id = "..."` line as the label when present —
    // more useful in a failure message than the bare `[[rules]]` header.
    const idMatch = bodyText.match(/^\s*id\s*=\s*"([^"]+)"/m)
    return {
      label: idMatch ? `rule "${idMatch[1]}"` : label,
      pathsRegexes: extractPathsRegexes(bodyText),
    }
  })
}

function extractPathsRegexes(chunkSrc: string): string[] {
  const regexes: string[] = []
  const arrayRe = /paths\s*=\s*\[([\s\S]*?)\]/g
  let arrayMatch: RegExpExecArray | null
  while ((arrayMatch = arrayRe.exec(chunkSrc))) {
    const body = arrayMatch[1]
    const strRe = /'''([\s\S]*?)'''/g
    let strMatch: RegExpExecArray | null
    while ((strMatch = strRe.exec(body))) {
      regexes.push(strMatch[1])
    }
  }
  return regexes
}

// SMI-6286/6287 pre-merge CI finding: root-level CI's own runner tripped a
// SECOND git-plumbing-unavailable shape this function didn't originally
// cover — "detected dubious ownership in repository at '/app'" (git's
// safe.directory check, triggered by a UID mismatch between the checkout's
// owner and the process running git; unrelated to this test's correctness,
// same environment-limitation class as "not a git repository" below).
function isGitPlumbingUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not a git repository/i.test(msg) || /detected dubious ownership/i.test(msg)
}

/**
 * Recursively list files under `walkDir`, returning paths relative to
 * `baseDir` with forward slashes — a filesystem-level stand-in for
 * `git ls-tree`/an extracted tar, skipping the same directories .gitignore
 * excludes (`node_modules`, `dist`; verified via `git check-ignore -v` that
 * both are gitignored under packages/mcp-server, and `git status`/`git
 * ls-files --others` confirm no OTHER untracked files live under
 * packages/mcp-server in a clean checkout, so this walk and `git ls-tree`
 * produce the same set). `baseDir` and `walkDir` are separate parameters so
 * the SAME function serves both the pre-strip listing (baseDir=REPO_ROOT,
 * walkDir=packages/mcp-server, yielding `packages/mcp-server/...` paths)
 * and the post-strip listing (baseDir=walkDir=packages/mcp-server, yielding
 * bare `...` paths — the fallback equivalent of stripping 2 components).
 */
function listFilesRelativeTo(baseDir: string, walkDir: string): string[] {
  const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])
  const results: string[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        results.push(relative(baseDir, join(dir, entry.name)).split(sep).join('/'))
      }
    }
  }
  walk(walkDir)
  return results
}

/**
 * Every git-tracked file under packages/mcp-server/ at HEAD, PRE-strip
 * (e.g. `packages/mcp-server/src/assets/typosquat-reference-snapshot.json`).
 *
 * Falls back to a filesystem walk (see listFilesRelativeTo) ONLY on the two
 * specific, diagnosed git-plumbing-unavailable failure modes this test has
 * actually hit (see isGitPlumbingUnavailableError) — any OTHER git failure
 * re-throws rather than silently masking a genuine bug as an environment
 * limitation:
 *
 * 1. **"not a git repository"** — running this test inside a git
 *    WORKTREE's own dev container: a worktree's `.git` is a pointer file
 *    naming an ABSOLUTE HOST path (`<main-checkout>/.git/worktrees/<name>`)
 *    that is never bind-mounted into that worktree's own container (only
 *    the worktree's working-tree directory is) — confirmed live: even a
 *    bare `git status` fails identically inside such a container.
 * 2. **"detected dubious ownership"** — CI's own root-level `Test (root)`
 *    job (not a worktree — a self-contained `.git` checkout), where git's
 *    `safe.directory` ownership check trips on a UID mismatch between the
 *    checkout's owner and the process running git. Confirmed live in CI
 *    (PR #2624): this test was very likely the first in this suite to
 *    invoke raw `git -C <path>` against `REPO_ROOT` inside that specific
 *    job, exposing a pre-existing environment gap rather than introducing
 *    one — no `git config --global --add safe.directory` step exists
 *    anywhere in `.github/workflows/` today. Handled the same way as case
 *    1 (graceful fallback in the test) rather than by adding that
 *    workflow-level config, since `.github/workflows/**` is an ADR-109
 *    infra-change trigger path requiring its own SPARC + plan-review cycle
 *    — out of proportion for what a test-local fallback already covers.
 *
 * SMI-4693: passes `env: makeFixtureEnv()` even though this isn't a temp
 * fixture — it's a deliberate READ against the real live checkout at
 * REPO_ROOT. `-C REPO_ROOT` alone does not protect that target: an
 * inherited `GIT_DIR`/`GIT_WORK_TREE` etc. still take precedence over `-C`,
 * so stripping GIT_DISCOVERY_VARS (what makeFixtureEnv does) is the same
 * protection this repo's OWN temp-fixture tests rely on, applied here for
 * the equivalent reason (only read-only `ls-tree`/`archive` calls — no
 * commit/config identity fields from makeFixtureEnv are exercised, but
 * reusing the one shared helper is simpler than hand-rolling a
 * git-discovery-only subset).
 */
function listPreStripFiles(): string[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-tree', '-r', '--name-only', 'HEAD', '--', MIRROR_SUBDIR],
      { encoding: 'utf8', env: makeFixtureEnv() }
    )
    return out.split('\n').filter((l) => l.length > 0)
  } catch (err) {
    if (!isGitPlumbingUnavailableError(err)) throw err
    return listFilesRelativeTo(REPO_ROOT, resolve(REPO_ROOT, MIRROR_SUBDIR))
  }
}

/**
 * Every file the mirror script's own tar pipeline would produce, POST-strip
 * — derived the SAME way scripts/mirror-mcp-server.sh does it
 * (`git archive --format=tar HEAD -- packages/mcp-server` piped into a tar
 * EXTRACT with `--strip-components=2` to a scratch dir, then walked) when
 * git plumbing is available. Extract-then-walk, not `tar -t
 * --strip-components` (list mode): verified live that BSD tar (macOS host
 * default) silently does NOT apply --strip-components in list mode — only
 * in extract mode — while GNU tar (the container's tar) applies it in both;
 * extracting first keeps this test correct on either tar implementation
 * rather than depending on which one happens to be on PATH. Falls back to
 * the same filesystem-walk listing under the diagnosed worktree-container
 * gap described on listPreStripFiles above.
 */
function listPostStripFilesViaMirrorMechanism(): string[] {
  try {
    const tarBuffer = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'archive', '--format=tar', 'HEAD', '--', MIRROR_SUBDIR],
      { maxBuffer: 64 * 1024 * 1024, env: makeFixtureEnv() }
    )
    const tmpDir = mkdtempSync(join(tmpdir(), 'gitleaks-poststrip-'))
    try {
      execFileSync(
        'tar',
        ['-x', `--strip-components=${STRIP_COMPONENTS}`, '-C', tmpDir, '-f', '-'],
        { input: tarBuffer, maxBuffer: 64 * 1024 * 1024 }
      )
      return listFilesRelativeTo(tmpDir, tmpDir)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  } catch (err) {
    if (!isGitPlumbingUnavailableError(err)) throw err
    const mirrorRoot = resolve(REPO_ROOT, MIRROR_SUBDIR)
    return listFilesRelativeTo(mirrorRoot, mirrorRoot)
  }
}

let gitleaksToml: string
let chunks: RuleChunk[]
let preStripFiles: string[]
let postStripFiles: string[]

beforeAll(() => {
  gitleaksToml = readFileSync(GITLEAKS_TOML_PATH, 'utf8')
  chunks = parseRuleChunks(gitleaksToml)
  preStripFiles = listPreStripFiles()
  postStripFiles = listPostStripFilesViaMirrorMechanism()
})

describe('sanity: parsing and mirror-mechanism derivation actually produced data', () => {
  it('parsed at least one rule chunk with a `paths` allowlist entry', () => {
    const chunksWithPaths = chunks.filter((c) => c.pathsRegexes.length > 0)
    expect(chunksWithPaths.length).toBeGreaterThan(0)
  })

  it('packages/mcp-server has git-tracked files (pre-strip listing is non-empty)', () => {
    expect(preStripFiles.length).toBeGreaterThan(0)
  })

  it('the mirror tar mechanism produces a non-empty post-strip listing', () => {
    expect(postStripFiles.length).toBeGreaterThan(0)
  })

  it('the known post-strip typosquat snapshot path is present (sanity-checks the strip-components mechanism itself)', () => {
    expect(postStripFiles).toContain('src/assets/typosquat-reference-snapshot.json')
  })
})

describe('SMI-6287: every packages/mcp-server-rooted allowlist path has a post-strip counterpart', () => {
  it('every pre-strip-rooted allowlist regex, for each real file it matches, has a same-rule allowlist entry covering the post-strip counterpart', () => {
    const failures: string[] = []

    for (const chunk of chunks) {
      const rootedRegexes = chunk.pathsRegexes.filter((r) => r.startsWith(MIRROR_ROOT_PREFIX))
      if (rootedRegexes.length === 0) continue

      for (const rawRegex of rootedRegexes) {
        const re = new RegExp(rawRegex)
        const matchedFiles = preStripFiles.filter((f) => re.test(f))

        if (matchedFiles.length === 0) {
          failures.push(
            `${chunk.label}: allowlist regex '''${rawRegex}''' is rooted at ${MIRROR_ROOT_PREFIX} but matches no git-tracked file under ${MIRROR_SUBDIR}/ — likely stale (file renamed/removed) rather than a real gap, but flagging so it's not silently ignored`
          )
          continue
        }

        for (const preStripPath of matchedFiles) {
          const postStripPath = preStripPath.split('/').slice(STRIP_COMPONENTS).join('/')
          expect(
            postStripFiles,
            `post-strip listing should contain the relocated counterpart of ${preStripPath}`
          ).toContain(postStripPath)

          const covered = chunk.pathsRegexes.some((r) => new RegExp(r).test(postStripPath))
          if (!covered) {
            failures.push(
              `${chunk.label}: allowlist regex '''${rawRegex}''' covers pre-strip path "${preStripPath}", but no allowlist regex in the same rule covers its post-strip counterpart "${postStripPath}" — the mirror sync's leak-audit gate will false-positive on this file (SMI-6287 regression)`
            )
          }
        }
      }
    }

    expect(failures, failures.join('\n')).toEqual([])
  })

  it("sanity: the vercel-token rule's typosquat-reference-snapshot.json entry is exercised by the assertion above (guards against the loop above silently matching zero rooted entries)", () => {
    const vercelChunk = chunks.find((c) => c.label === 'rule "vercel-token"')
    expect(vercelChunk).toBeDefined()
    const rooted = vercelChunk!.pathsRegexes.filter((r) => r.startsWith(MIRROR_ROOT_PREFIX))
    expect(rooted.length).toBeGreaterThan(0)
    expect(rooted.some((r) => r.includes('typosquat-reference-snapshot'))).toBe(true)
  })
})
