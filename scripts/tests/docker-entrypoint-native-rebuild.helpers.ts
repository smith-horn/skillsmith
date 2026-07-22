/**
 * Shared parsing/extraction helpers for docker-entrypoint-native-rebuild.test.ts
 * and docker-entrypoint-native-rebuild-smi5650.test.ts. Split out per
 * CLAUDE.md's 500-line guidance — this file holds the pure parsing logic;
 * the two sibling `.test.ts` files hold only `describe`/`it` suites.
 */
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// ---------------------------------------------------------------------------
// File resolution — locate from this file's directory, then walk up to the
// repo root (same pattern as sibling audit-standards-*.test.ts files).
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const REPO_ROOT = resolve(__dirname, '..', '..')
export const ENTRYPOINT_PATH = resolve(REPO_ROOT, 'docker-entrypoint.sh')
// SMI-5784 file-length split: the per-package native-module seed/validate
// logic (including the SHARED validate_native_module() function) was moved
// out of docker-entrypoint.sh into this sourced sibling per CLAUDE.md's
// 500-line convention. Anything that used to extract those blocks/that
// function from ENTRYPOINT_PATH's own source must now read from here
// instead — see docker-entrypoint-native-per-package.sh's own header for
// the split rationale.
export const NATIVE_PER_PACKAGE_PATH = resolve(REPO_ROOT, 'docker-entrypoint-native-per-package.sh')
export const DOCKERFILE_PATH = resolve(REPO_ROOT, 'Dockerfile')
export const LIB_SH_PATH = resolve(REPO_ROOT, 'scripts', '_lib.sh')
export const REGEN_LOCKFILE_PATH = resolve(REPO_ROOT, 'scripts', 'regen-lockfile.sh')

/**
 * Reuse the parseBashArray convention from audit-standards-helpers.mjs:
 * parse a Bash array declaration `NAME=(\n  entry1\n  entry2\n)\n` and
 * return the set of string entries (stripping quotes and inline comments).
 *
 * Returns null if the named array is not present in `src` or has no multiline
 * body (e.g. inline empty `NAME=()`).
 */
export function parseBashArray(src: string, arrayName: string): Set<string> | null {
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
export function parseDockerfileRebuildLine(src: string): Set<string> | null {
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
 * Parse the space-separated module list from scripts/regen-lockfile.sh's
 * `NATIVE_MODULES="better-sqlite3 onnxruntime-node esbuild hnswlib-node"`
 * declaration (a quoted shell STRING, not a bash array — a third distinct
 * shape from parseBashArray/parseDockerfileRebuildLine, SMI-5650 H3).
 *
 * Matches: `NATIVE_MODULES="better-sqlite3 onnxruntime-node esbuild hnswlib-node"`
 * Returns a Set of the module token strings, or null if no such assignment
 * is found or it has an empty body.
 */
export function parseQuotedSpaceSeparatedVar(src: string, varName: string): Set<string> | null {
  const re = new RegExp(`(?:^|\\n)[\\t ]*${varName}=["']([^"']*)["']`)
  const m = src.match(re)
  if (!m) return null
  const tokens = m[1]
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  return tokens.length > 0 ? new Set(tokens) : null
}

/**
 * Parse the module list from the Dockerfile's SMI-5650 native-seed stash
 * loop: `for module in better-sqlite3 onnxruntime-node esbuild hnswlib-node; do \`
 *
 * A FOURTH distinct shape from the three parsers above: a `for module in …`
 * loop header inside a multi-line `RUN … \`-continued shell command, not a
 * `RUN npm rebuild …` line (parseDockerfileRebuildLine) and not a bash array
 * (parseBashArray). Deliberately anchored on the literal `for module in`
 * loop-header syntax so it cannot accidentally match the (also present)
 * `RUN npm rebuild …` line that parseDockerfileRebuildLine already covers.
 *
 * Also reused (SMI-5650 Wave 2) against docker-entrypoint.sh itself to parse
 * the boot-time seed step's own `for module in … ; do` loop header — the
 * shape is identical, just in a different file.
 *
 * Returns a Set of the module token strings, or null if no such loop header
 * is found.
 */
export function parseDockerfileStashLoopModules(src: string): Set<string> | null {
  const m = src.match(/for\s+module\s+in\s+([\w@/.-]+(?:\s+[\w@/.-]+)*)\s*;\s*do\b/)
  if (!m) return null
  const tokens = m[1]
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  return tokens.length > 0 ? new Set(tokens) : null
}

/**
 * Filter a module set down to its FLAT (non-scope) entries, sorted.
 *
 * SMI-5650 Wave 2: `@esbuild` (a scope directory, not an installed package)
 * is intentionally asymmetric across the four canonical lists this file
 * cross-checks — it appears in docker-entrypoint.sh's NATIVE_MODULES and
 * scripts/_lib.sh's NATIVE_MODULES_FOR_OVERLAY (both drive the tmpfs-seed /
 * volume-reference mechanism, which DOES need to know about the scope), but
 * is deliberately ABSENT from the Dockerfile's `RUN npm rebuild …` line, the
 * Dockerfile's flat /opt/native-seed stash loop, and
 * scripts/regen-lockfile.sh's NATIVE_MODULES string — none of which can
 * meaningfully operate on a bare scope directory (`npm rebuild @esbuild` is
 * not a thing; the Dockerfile instead stashes the scope via its own
 * dedicated `mkdir -p /opt/native-seed/@esbuild && cp -a …` RUN block).
 * Callers that need the flat-only comparison should filter through this
 * helper rather than asserting blind set equality across all five entries.
 */
export function flatOnly(modules: Set<string>): string[] {
  return [...modules].filter((m) => !m.startsWith('@')).sort()
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
export function extractValidationFailedRegion(src: string): string | null {
  const lines = src.split('\n')

  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/if\s+\[\s+\$VALIDATION_FAILED\s+-eq\s+1\s+\]/.test(lines[i])) {
      startIdx = i
      break
    }
  }
  if (startIdx === -1) return null

  // Walk forward, tracking if/fi nesting depth, anchored to the START of the
  // (trimmed) line rather than "the word appears anywhere" (SMI-5650). This
  // codebase's bash always writes multi-line `if …; then` / `fi` (never
  // single-line `if …; then …; fi`), so every REAL control-flow keyword is
  // the line's first token — but prose is not: a comment may legitimately
  // use the bare word "if"/"fi" ("Falls through to npm rebuild if the seed
  // is missing … OR if SKILLSMITH_..."), and Wave 2 ALSO added a non-comment
  // echo MESSAGE elsewhere in this file containing "...if validation
  // fails..." as user-facing text — either would desync a bare `\bif\b`
  // scan and make the region never close. Anchoring to line-start handles
  // both cases in one rule (no separate comment-skip needed). `elif`
  // deliberately does NOT match `^\s*if\b` (starts with "e"): elif neither
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

  return lines.slice(startIdx, endIdx + 1).join('\n')
}
