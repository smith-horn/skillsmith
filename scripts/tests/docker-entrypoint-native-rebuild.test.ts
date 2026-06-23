/**
 * Static-assertion tests for the native-module rebuild loop in docker-entrypoint.sh.
 *
 * These tests assert structural properties of the shell script without running
 * it, mirroring the convention from scripts/tests/audit-standards-parse-bash-array.test.ts.
 *
 * Assertions:
 *   C1 — Scoped to the VALIDATION_FAILED guard region only; within that region:
 *        (a) every NATIVE_MODULES entry is rebuilt with --ignore-scripts=false
 *        (b) no `npm rebuild` appears without --ignore-scripts=false
 *        (c) no `if [ "${module}" = ` carve-out remains
 *   C2 — NATIVE_MODULES (bash array) equals the Dockerfile `RUN npm rebuild …` list
 *   #5 — The verbose-hint line carries --ignore-scripts=false
 *   L15 — The rebuild loop is nested inside the VALIDATION_FAILED -eq 1 guard
 *
 * SMI-5351: all four native modules must use --ignore-scripts=false in the
 * rebuild loop; plain `npm rebuild` is a no-op under .npmrc ignore-scripts=true.
 */
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it, beforeAll } from 'vitest'

// ---------------------------------------------------------------------------
// File resolution — locate from the test file's directory, then walk up to
// the repo root (same pattern as sibling audit-standards-*.test.ts files
// which use readFileSync with relative paths from process.cwd()).
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Repo root is two levels up from scripts/tests/
const REPO_ROOT = resolve(__dirname, '..', '..')

const ENTRYPOINT_PATH = resolve(REPO_ROOT, 'docker-entrypoint.sh')
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'Dockerfile')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reuse the parseBashArray convention from audit-standards-helpers.mjs:
 * parse a Bash array declaration `NAME=(\n  entry1\n  entry2\n)\n` and
 * return the set of string entries (stripping quotes and inline comments).
 *
 * Returns null if the named array is not present in `src` or has no multiline
 * body (e.g. inline empty `NAME=()`).
 */
function parseBashArray(src: string, arrayName: string): Set<string> | null {
  // Match `NAME=( ... )` capturing the body between the parens. Handles BOTH
  // single-line `NAME=("a" "b" "c")` (the form NATIVE_MODULES uses) and
  // multi-line array declarations.
  const re = new RegExp(`(?:^|\\n)[\\t ]*${arrayName}=\\(([\\s\\S]*?)\\)`)
  const m = src.match(re)
  if (!m) return null
  // Strip full-line comments, then extract quoted strings and barewords.
  const body = m[1].replace(/#.*$/gm, '')
  const entries = new Set<string>()
  for (const raw of body.match(/"[^"]*"|'[^']*'|[^\s()]+/g) ?? []) {
    const tok = raw.replace(/^["']|["']$/g, '').trim()
    if (/^[a-z0-9@][a-z0-9_./-]*$/i.test(tok)) entries.add(tok)
  }
  return entries.size > 0 ? entries : null
}

/**
 * Parse the space-separated module list from the Dockerfile `RUN npm rebuild …`
 * line. This is a DIFFERENT shape from a bash array — tokens are space-separated
 * on a single line, terminated by `||` or end-of-line — so parseBashArray
 * cannot be reused here (C2/L18).
 *
 * Matches: `RUN npm rebuild better-sqlite3 onnxruntime-node esbuild hnswlib-node || true`
 * Returns a Set of the module token strings, or null if no such line is found.
 */
function parseDockerfileRebuildLine(src: string): Set<string> | null {
  // Capture everything between `npm rebuild` and `||` or end-of-line
  const m = src.match(/^RUN\s+npm\s+rebuild\s+([\w@/.-]+(?:\s+[\w@/.-]+)*)\s*(?:\|\|.*)?$/m)
  if (!m) return null
  const tokens = m[1]
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  return new Set(tokens)
}

/**
 * Extract the VALIDATION_FAILED -eq 1 guard region from docker-entrypoint.sh.
 *
 * The region is the text from the opening `if [ $VALIDATION_FAILED -eq 1 ]`
 * line through its matching `fi` line (inclusive). We use a stateful bracket
 * counter so nested if/fi pairs are handled correctly without ambiguity.
 *
 * Returns null if the guard is not found.
 */
function extractValidationFailedRegion(src: string): string | null {
  const lines = src.split('\n')

  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/if\s+\[\s+\$VALIDATION_FAILED\s+-eq\s+1\s+\]/.test(lines[i])) {
      startIdx = i
      break
    }
  }
  if (startIdx === -1) return null

  // Walk forward, tracking if/fi nesting depth
  let depth = 0
  let endIdx = -1
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]
    // Count `if` keywords (word-boundary match to avoid false positives)
    if (/\bif\b/.test(line)) depth++
    if (/\bfi\b/.test(line)) {
      depth--
      if (depth === 0) {
        endIdx = i
        break
      }
    }
  }
  if (endIdx === -1) return null

  return lines.slice(startIdx, endIdx + 1).join('\n')
}

// ---------------------------------------------------------------------------
// Load files once
// ---------------------------------------------------------------------------

let entrypointSrc: string
let dockerfileSrc: string

beforeAll(() => {
  entrypointSrc = readFileSync(ENTRYPOINT_PATH, 'utf8')
  dockerfileSrc = readFileSync(DOCKERFILE_PATH, 'utf8')
})

// ---------------------------------------------------------------------------
// L15: The rebuild loop is nested inside the VALIDATION_FAILED -eq 1 guard
// ---------------------------------------------------------------------------

describe('L15: rebuild loop nesting', () => {
  it('the VALIDATION_FAILED -eq 1 guard exists in docker-entrypoint.sh', () => {
    expect(entrypointSrc).toMatch(/if\s+\[\s+\$VALIDATION_FAILED\s+-eq\s+1\s+\]/)
  })

  it('the rebuild loop (for module in "${NATIVE_MODULES[@]}") is inside the VALIDATION_FAILED guard', () => {
    const region = extractValidationFailedRegion(entrypointSrc)
    expect(region).not.toBeNull()
    // The rebuild for loop must appear within the region
    expect(region).toMatch(/for\s+module\s+in\s+"\$\{NATIVE_MODULES\[@\]\}"/)
  })

  it('npm rebuild calls do NOT appear outside the VALIDATION_FAILED guard', () => {
    const region = extractValidationFailedRegion(entrypointSrc)
    expect(region).not.toBeNull()

    // Remove the region from the full file and verify no `npm rebuild` COMMAND
    // remains. Pure-comment lines legitimately discuss `npm rebuild` (the header
    // + the explanatory block above NATIVE_MODULES), so strip them first — only
    // actual command lines count (same comment-skip rule as C1(b) below).
    const regionText = region as string
    const outsideCommands = entrypointSrc
      .replace(regionText, '')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(outsideCommands).not.toMatch(/\bnpm\s+rebuild\b/)
  })
})

// ---------------------------------------------------------------------------
// C1: Within the VALIDATION_FAILED guard, assert the rebuild loop properties
// ---------------------------------------------------------------------------

describe('C1: rebuild loop assertions (scoped to VALIDATION_FAILED region)', () => {
  it('(a) every NATIVE_MODULES entry is rebuilt with --ignore-scripts=false', () => {
    const region = extractValidationFailedRegion(entrypointSrc)
    expect(region).not.toBeNull()

    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    expect(nativeModules).not.toBeNull()
    expect(nativeModules!.size).toBeGreaterThan(0)

    // Every module that is in NATIVE_MODULES must appear in an
    // `npm rebuild "${module}" --ignore-scripts=false` invocation within the region.
    // Because the loop iterates over the array variable (not each module by name),
    // we assert the canonical single rebuild command form is present.
    expect(region).toMatch(/npm\s+rebuild\s+"\$\{module\}"\s+--ignore-scripts=false/)
  })

  it('(b) no `npm rebuild` appears in the region without --ignore-scripts=false', () => {
    const region = extractValidationFailedRegion(entrypointSrc)
    expect(region).not.toBeNull()

    // Find all lines that contain `npm rebuild` in the region
    const lines = region!.split('\n')
    const rebuildLines = lines.filter((l) => /\bnpm\s+rebuild\b/.test(l))

    // Every rebuild line must include --ignore-scripts=false
    for (const line of rebuildLines) {
      // Skip lines that are pure comments
      const stripped = line.replace(/^\s*#.*$/, '').trim()
      if (!stripped) continue
      if (stripped.startsWith('#')) continue
      // Any npm rebuild invocation must carry the flag
      if (/\bnpm\s+rebuild\b/.test(stripped)) {
        expect(
          stripped,
          `Line contains 'npm rebuild' without --ignore-scripts=false: ${stripped}`
        ).toMatch(/--ignore-scripts=false/)
      }
    }
  })

  it('(c) no `if [ "${module}" = ` carve-out remains in the region', () => {
    const region = extractValidationFailedRegion(entrypointSrc)
    expect(region).not.toBeNull()
    // The original hnswlib-node carve-out was `if [ "${module}" = "hnswlib-node" ]`
    expect(region).not.toMatch(/if\s+\[\s+"\$\{module\}"\s+=\s+/)
  })
})

// ---------------------------------------------------------------------------
// C2: NATIVE_MODULES array equals Dockerfile `RUN npm rebuild …` list
// ---------------------------------------------------------------------------

describe('C2: NATIVE_MODULES sync with Dockerfile', () => {
  it('NATIVE_MODULES is present and non-empty in docker-entrypoint.sh', () => {
    const modules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    expect(modules).not.toBeNull()
    expect(modules!.size).toBeGreaterThan(0)
  })

  it('Dockerfile contains a `RUN npm rebuild …` line that is parseable', () => {
    const dockerModules = parseDockerfileRebuildLine(dockerfileSrc)
    expect(dockerModules).not.toBeNull()
    expect(dockerModules!.size).toBeGreaterThan(0)
  })

  it('NATIVE_MODULES entries equal the Dockerfile `RUN npm rebuild` modules (set equality)', () => {
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    const dockerModules = parseDockerfileRebuildLine(dockerfileSrc)

    expect(nativeModules).not.toBeNull()
    expect(dockerModules).not.toBeNull()

    const nativeArr = [...nativeModules!].sort()
    const dockerArr = [...dockerModules!].sort()

    expect(
      nativeArr,
      `NATIVE_MODULES in entrypoint [${nativeArr.join(', ')}] must equal Dockerfile rebuild list [${dockerArr.join(', ')}]`
    ).toEqual(dockerArr)
  })

  it('known modules (better-sqlite3, onnxruntime-node, esbuild, hnswlib-node) are present in both', () => {
    const nativeModules = parseBashArray(entrypointSrc, 'NATIVE_MODULES')
    const dockerModules = parseDockerfileRebuildLine(dockerfileSrc)

    expect(nativeModules).not.toBeNull()
    expect(dockerModules).not.toBeNull()

    const expected = ['better-sqlite3', 'onnxruntime-node', 'esbuild', 'hnswlib-node']
    for (const mod of expected) {
      expect(nativeModules!.has(mod), `NATIVE_MODULES missing: ${mod}`).toBe(true)
      expect(dockerModules!.has(mod), `Dockerfile rebuild list missing: ${mod}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// #5: The verbose-hint line carries --ignore-scripts=false
// ---------------------------------------------------------------------------

describe('#5: verbose-hint contains --ignore-scripts=false', () => {
  it('the failure-path verbose hint line includes --ignore-scripts=false', () => {
    // The hint is the `docker exec … npm rebuild ${FAILED_MODULES}` line
    // in the REBUILD_FAILED block. Find it and assert it carries the flag.
    const lines = entrypointSrc.split('\n')
    const hintLines = lines.filter(
      (l) => /docker\s+exec/.test(l) && /npm\s+rebuild/.test(l) && /FAILED_MODULES/.test(l)
    )

    expect(
      hintLines.length,
      'Expected exactly one verbose-hint line (docker exec … npm rebuild ${FAILED_MODULES} …)'
    ).toBeGreaterThan(0)

    for (const hint of hintLines) {
      expect(hint, `Verbose-hint line is missing --ignore-scripts=false:\n  ${hint}`).toMatch(
        /--ignore-scripts=false/
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Parsers sanity-check (unit tests for the helpers above)
// ---------------------------------------------------------------------------

describe('parseBashArray (local helper)', () => {
  it('parses double-quoted entries from a canonical multiline array', () => {
    const src = `NATIVE_MODULES=(\n  "better-sqlite3"\n  "onnxruntime-node"\n)\n`
    const result = parseBashArray(src, 'NATIVE_MODULES')
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual(['better-sqlite3', 'onnxruntime-node'])
  })

  it('returns null when the array is missing', () => {
    expect(parseBashArray('OTHER=(\n  foo\n)\n', 'NATIVE_MODULES')).toBeNull()
  })

  it('returns null for inline-empty array', () => {
    expect(parseBashArray('NATIVE_MODULES=()\n', 'NATIVE_MODULES')).toBeNull()
  })
})

describe('parseDockerfileRebuildLine (local helper)', () => {
  it('parses a space-separated RUN npm rebuild line with || suffix', () => {
    const src = `RUN npm rebuild better-sqlite3 onnxruntime-node esbuild hnswlib-node || true\n`
    const result = parseDockerfileRebuildLine(src)
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual([
      'better-sqlite3',
      'esbuild',
      'hnswlib-node',
      'onnxruntime-node',
    ])
  })

  it('returns null when no RUN npm rebuild line is present', () => {
    const src = `FROM node:22-slim\nRUN apt-get update\n`
    expect(parseDockerfileRebuildLine(src)).toBeNull()
  })

  it('does not include the `|| true` token as a module name', () => {
    const src = `RUN npm rebuild foo bar || true\n`
    const result = parseDockerfileRebuildLine(src)
    expect(result).not.toBeNull()
    expect(result!.has('||')).toBe(false)
    expect(result!.has('true')).toBe(false)
    expect([...result!].sort()).toEqual(['bar', 'foo'])
  })
})
