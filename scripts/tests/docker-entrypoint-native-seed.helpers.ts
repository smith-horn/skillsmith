/**
 * Extraction + fixture helpers for docker-entrypoint-native-seed.test.ts
 * (SMI-5650 Wave 2). Split out per CLAUDE.md's 500-line guidance — this file
 * holds the "how to isolate and exercise the two live shell blocks" plumbing;
 * the sibling `.test.ts` holds only the `describe`/`it` suite.
 *
 * docker-entrypoint.sh cannot be run wholesale outside a real container (it
 * assumes an initialised node_modules/.bin/turbo, a built dist/, etc.), so —
 * mirroring scripts/tests/docker-entrypoint-native-rebuild.test.ts's
 * structural-assertion convention for the parts that are pure string/order
 * checks — this file adds a second layer for the parts that are genuinely
 * behavioral:
 *
 *   1. Extract ONLY the two SMI-5650 blocks (boot-time seed step; the
 *      re-seed-first fast path + its npm-rebuild fallback line) directly out
 *      of the LIVE docker-entrypoint.sh source via anchored if/fi
 *      depth-counting (same technique as the sibling file's
 *      extractValidationFailedRegion, hardened against comment lines from
 *      the start — see that file's SMI-5650 fix note for why).
 *   2. Rewrite the blocks' hardcoded /app + /opt/native-seed prefixes to
 *      point at an isolated fixture root, and (for the boot-time block only)
 *      swap its self-declared 4-module list for a single test module name.
 *   3. Execute the rewritten block(s) via `bash -c` against the fixture,
 *      with stub `node`/`npm` binaries on PATH (see makeFixture) standing in
 *      for the real requires/rebuilds, and assert on the REAL filesystem
 *      effects (what got written where) and captured output.
 *
 * Because the extraction is anchored on the live source, a future edit that
 * removes or restructures either block fails LOUDLY here (a thrown Error in
 * beforeAll) rather than silently testing stale copied-and-pasted logic.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Extraction helpers — anchor on a unique comment, then depth-count the
// following if/fi block. Mirrors extractValidationFailedRegion's technique
// in the sibling file, generalized to take an arbitrary anchor and hardened
// from the start to skip comment lines while counting (that file's own
// SMI-5650 fix note explains why: prose comments legitimately contain the
// bare words "if"/"fi", e.g. "Falls through to npm rebuild if the seed is
// missing … OR if SKILLSMITH_...").
// ---------------------------------------------------------------------------

function findIfBlockAfter(
  lines: string[],
  fromIdx: number
): { startIdx: number; endIdx: number } | null {
  let startIdx = -1
  for (let i = fromIdx; i < lines.length; i++) {
    if (/^\s*if\s+\[/.test(lines[i])) {
      startIdx = i
      break
    }
  }
  if (startIdx === -1) return null

  // Depth-count if/fi, anchored to the START of the (trimmed) line rather
  // than "the word appears anywhere". This codebase's bash always writes
  // multi-line `if …; then` / `fi` (never single-line `if …; then …; fi`),
  // so every REAL control-flow keyword is the line's first token — but a
  // user-facing echo MESSAGE is not: docker-entrypoint.sh's own boot-time
  // seed step has a warning that reads "...falling back to npm rebuild if
  // validation fails..." (prose, not code), which trips a bare `\bif\b`
  // scan exactly like the sibling docker-entrypoint-native-rebuild.test.ts
  // file's own SMI-5650 comment-line bug (see that file's fix note) — this
  // is the same failure class one line-start anchor away from ANY quoted
  // string, not just comments, hence the stricter anchor here from the
  // start rather than only skipping `#` lines. `elif` deliberately does NOT
  // match `^\s*if\b` (it starts with "e"), which is correct: elif neither
  // opens nor closes a nesting level.
  let depth = 0
  let endIdx = -1
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*if\b/.test(line)) depth++
    if (/^\s*fi\b/.test(line)) {
      depth--
      if (depth === 0) {
        endIdx = i
        break
      }
    }
  }
  if (endIdx === -1) return null
  return { startIdx, endIdx }
}

/**
 * Extract the boot-time seed step: the top-level
 *   if [ -f "/app/.git" ] && [ "${SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE:-}" != "1" ]; then
 *     for module in better-sqlite3 onnxruntime-node esbuild hnswlib-node; do
 *       ...
 *     done
 *   fi
 * block, verbatim from the live source.
 */
export function extractBootTimeSeedBlock(src: string): string {
  const anchor = '# SMI-5650: seed writable native-module named volumes (worktree only).'
  const lines = src.split('\n')
  const anchorIdx = lines.findIndex((l) => l.includes(anchor))
  if (anchorIdx === -1) {
    throw new Error(`extractBootTimeSeedBlock: anchor not found in docker-entrypoint.sh: ${anchor}`)
  }

  const block = findIfBlockAfter(lines, anchorIdx)
  if (!block) {
    throw new Error('extractBootTimeSeedBlock: if/fi block not found after the SMI-5650 anchor')
  }

  return lines.slice(block.startIdx, block.endIdx + 1).join('\n')
}

/**
 * Extract the VALIDATION_FAILED loop's re-seed-first fast path AND its
 * sibling npm-rebuild fallback line immediately following it:
 *   if [ -f "/app/.git" ] && [ "${SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE:-}" != "1" ] && [ -d "/opt/native-seed/${module}" ]; then
 *     ...
 *     if node -e "require('${module}')" 2>/dev/null; then
 *       ...
 *       continue
 *     fi
 *   fi
 *   npm rebuild "${module}" --ignore-scripts=false || echo ...
 *
 * The npm-rebuild line is a SIBLING statement (same loop-body indentation
 * level), not nested inside the if — extracted separately by finding the
 * first non-blank line after the if-block's closing `fi` and asserting it
 * matches the expected fallback shape.
 */
export function extractReseedFastPathWithFallback(src: string): string {
  const anchor = '# SMI-5650 (worktree): re-seed from the image stash first'
  const lines = src.split('\n')
  const anchorIdx = lines.findIndex((l) => l.includes(anchor))
  if (anchorIdx === -1) {
    throw new Error(
      `extractReseedFastPathWithFallback: anchor not found in docker-entrypoint.sh: ${anchor}`
    )
  }

  const block = findIfBlockAfter(lines, anchorIdx)
  if (!block) {
    throw new Error(
      'extractReseedFastPathWithFallback: if/fi block not found after the SMI-5650 re-seed anchor'
    )
  }

  let fallbackIdx = -1
  for (let i = block.endIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    fallbackIdx = i
    break
  }
  if (fallbackIdx === -1 || !/npm\s+rebuild\s+"\$\{module\}"/.test(lines[fallbackIdx])) {
    throw new Error(
      'extractReseedFastPathWithFallback: expected an `npm rebuild "${module}" …` fallback line ' +
        'immediately after the re-seed if-block (same loop-body level) — the fast-path/fallback ' +
        'shape this test depends on may have changed'
    )
  }

  return lines.slice(block.startIdx, fallbackIdx + 1).join('\n')
}

/**
 * Extract the `validate_native_module() { ... }` helper function verbatim.
 * Both extracted blocks below call this function rather than inlining a bare
 * `node -e "require('${module}')"` (SMI-5650 fix: that bare check is a false
 * green for better-sqlite3/esbuild, whose native binaries load lazily — see
 * the function's own header comment in docker-entrypoint.sh) — so it must be
 * prepended to the isolated fixture script alongside whichever block is
 * under test, or the extracted snippet fails with "command not found".
 */
export function extractValidateNativeModuleFunction(src: string): string {
  const lines = src.split('\n')
  const startIdx = lines.findIndex((l) => l.trim().startsWith('validate_native_module()'))
  if (startIdx === -1) {
    throw new Error(
      'extractValidateNativeModuleFunction: function definition not found in docker-entrypoint.sh'
    )
  }
  let endIdx = -1
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim() === '}') {
      endIdx = i
      break
    }
  }
  if (endIdx === -1) {
    throw new Error('extractValidateNativeModuleFunction: closing brace not found')
  }
  return lines.slice(startIdx, endIdx + 1).join('\n')
}

/**
 * Swap the boot-time block's self-declared 4-module loop header for an
 * arbitrary test module list, so a single test can exercise one module in
 * isolation without needing fixtures for all four.
 */
export function withTestModules(bootBlock: string, modules: string[]): string {
  const target = 'better-sqlite3 onnxruntime-node esbuild hnswlib-node'
  if (!bootBlock.includes(target)) {
    throw new Error(
      `withTestModules: expected module list "${target}" not found in the extracted boot-time block`
    )
  }
  return bootBlock.replace(target, modules.join(' '))
}

/** Wrap the re-seed fast-path block in its own `for module in …; do … done`. */
export function wrapInLoop(block: string, modules: string[]): string {
  return `for module in ${modules.join(' ')}; do\n${block}\ndone`
}

/**
 * Rewrite the block's hardcoded /app/node_modules, /opt/native-seed, and
 * /app/.git absolute prefixes to point inside an isolated fixture root.
 * Plain string split/join (not regex) — no escaping hazards from the
 * fixture's tmp-dir path.
 */
function substituteFixturePaths(block: string, fixtureRoot: string): string {
  return block
    .split('/app/node_modules/')
    .join(`${fixtureRoot}/app/node_modules/`)
    .split('/opt/native-seed/')
    .join(`${fixtureRoot}/opt/native-seed/`)
    .split('"/app/.git"')
    .join(`"${fixtureRoot}/app/.git"`)
}

// ---------------------------------------------------------------------------
// Fixture: isolated root + stub node/npm on PATH
// ---------------------------------------------------------------------------

export interface Fixture {
  root: string
  binDir: string
  npmRebuildLog: string
  nodeModulesDir: (moduleName: string) => string
  seedDir: (moduleName: string) => string
}

/**
 * Stub `node` — interprets `node -e "require('<module>')"` and succeeds
 * (exit 0) iff <fixture>/app/node_modules/<module>/GOOD_MARKER exists. This
 * models "the seed content actually satisfies require()" without needing a
 * real compiled .node binary — the marker file travels with `cp -a` exactly
 * like a real binary would.
 *
 * The module name is pulled out of `require('<module>')` via parameter
 * expansion using a QUOTE CHARACTER HELD IN A VARIABLE (`q="'"`), never a
 * bare `'` written directly inside an unquoted `${var#pattern}`/`${var%pattern}`
 * expression: bash's lexer parses quote characters as real shell syntax
 * BEFORE it interprets `${...}` semantics, so a literal `'` written inline
 * there (e.g. `${2#*require('}`) silently opens an actual single-quoted
 * string that swallows the rest of the script until the next stray `'` —
 * this was tripped and fixed while writing this file (see PR notes); routing
 * the quote character through a variable reference (`$q`) sidesteps the
 * re-parsing entirely, since a variable's VALUE is substituted as literal
 * pattern text, not re-tokenized as shell syntax.
 */
function makeNodeStub(nodeModulesRoot: string): string {
  return `#!/bin/sh
if [ "$1" = "-e" ]; then
  q="'"
  rest="\${2#*require(}"
  rest="\${rest#$q}"
  mod="\${rest%$q*}"
  if [ -n "$mod" ] && [ -f "${nodeModulesRoot}/$mod/GOOD_MARKER" ]; then
    exit 0
  fi
  exit 1
fi
exit 1
`
}

/**
 * Stub `npm` — records every `npm rebuild <module> …` invocation to a log
 * file (one module per line) so tests can assert whether the fallback path
 * was, or was not, exercised — without running a real npm rebuild.
 */
function makeNpmStub(npmRebuildLog: string): string {
  return `#!/bin/sh
if [ "$1" = "rebuild" ]; then
  echo "$2" >> "${npmRebuildLog}"
  exit 0
fi
exit 1
`
}

export function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'skillsmith-native-seed-'))
  mkdirSync(join(root, 'app', 'node_modules'), { recursive: true })
  mkdirSync(join(root, 'opt', 'native-seed'), { recursive: true })
  // Worktree signal: /app/.git must be a FILE (git's worktree marker).
  writeFileSync(join(root, 'app', '.git'), 'gitdir: ../fixture-git/worktrees/x\n', 'utf8')

  const binDir = join(root, '_bin')
  mkdirSync(binDir, { recursive: true })
  const npmRebuildLog = join(root, 'npm-rebuild.log')
  const nodeModulesRoot = join(root, 'app', 'node_modules')

  writeFileSync(join(binDir, 'node'), makeNodeStub(nodeModulesRoot), 'utf8')
  chmodSync(join(binDir, 'node'), 0o755)
  writeFileSync(join(binDir, 'npm'), makeNpmStub(npmRebuildLog), 'utf8')
  chmodSync(join(binDir, 'npm'), 0o755)

  return {
    root,
    binDir,
    npmRebuildLog,
    nodeModulesDir: (moduleName: string) => join(root, 'app', 'node_modules', moduleName),
    seedDir: (moduleName: string) => join(root, 'opt', 'native-seed', moduleName),
  }
}

/**
 * Execute an already fixture-path-substituted block via `bash -c`, with the
 * fixture's stub node/npm prepended to PATH (real coreutils/bash still
 * resolve via the inherited PATH). `set -e` matches docker-entrypoint.sh's
 * own top-of-file setting — a genuine crash inside the block surfaces as a
 * non-zero exit here exactly as it would in the real container.
 */
export function runBlock(
  fixture: Fixture,
  blockSrc: string,
  extraEnv: Record<string, string> = {},
  prelude = ''
): { status: number; output: string } {
  const substituted = substituteFixturePaths(blockSrc, fixture.root)
  const script = ['set -e', "YELLOW=''", "GREEN=''", "NC=''", prelude, substituted, ''].join('\n')

  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: `${fixture.binDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return { status: result.status ?? 1, output: (result.stdout ?? '') + (result.stderr ?? '') }
}
