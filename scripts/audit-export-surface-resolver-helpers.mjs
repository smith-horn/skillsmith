/**
 * SMI-6146: export-surface resolver — resolves a workspace package's full
 * exported-symbol set across its ENTIRE package.json `exports` map (not
 * just the root `.` entry), reusing the existing `parseTsExports`/
 * `collectTsEntryExports` helpers (scripts/audit-standards-helpers.mjs,
 * Check 29 / SMI-4193) rather than re-implementing TS export parsing.
 *
 * Background: SMI-6143 shipped `@skillsmith/mcp-server@0.7.10` depending on
 * `@skillsmith/core` exports that core's *published* version didn't yet
 * have — every fresh install broke. Two existing checks (verify-publish-
 * deps.mjs Check 2, audit:standards Check 58) both reason only about
 * version-range strings, never about what a package actually exports, so
 * neither could have caught it. This module is the "what does a sibling
 * actually export, from source, across every entry point" half of the fix
 * that powers audit:standards Check 63. See
 * docs/internal/implementation/smi-6146-export-surface-coherence-check.md
 * for the full design.
 *
 * Pure decision/orchestration layer: no direct fs I/O. Callers inject
 * `readFile(absPath)` and `resolveModule(fromAbsFile, relSpec)` — the exact
 * same shape Check 29 already uses (scripts/audit-standards.mjs's own
 * `readFileIfExists`/`resolveModule` in the Check 29 block) — so this
 * module and its tests never touch the real filesystem directly.
 */
import { join } from 'node:path'
import { collectTsEntryExports } from './audit-standards-helpers.mjs'

/** Strip a leading './' and any trailing '/' from an outDir/path segment. */
function normalizeDirSegment(seg) {
  return seg.replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * Read `compilerOptions.outDir` from a parsed tsconfig.json, normalized
 * (leading './' stripped, trailing '/' stripped). Returns null if
 * absent/unparseable — callers must not assume a default of 'dist': per
 * SMI-6146's design, a package whose tsconfig doesn't declare `outDir` is a
 * build shape this resolver has never seen, and must fail loud (an
 * `unmappable-dist-path` result), not silently guess.
 *
 * @param {{ compilerOptions?: { outDir?: string } }} tsconfigJson
 * @returns {string | null}
 */
export function getPackageOutDir(tsconfigJson) {
  const outDir = tsconfigJson?.compilerOptions?.outDir
  if (typeof outDir !== 'string' || outDir.trim() === '') return null
  return normalizeDirSegment(outDir)
}

/**
 * Map a dist-relative path (as it appears in an `exports`/`main`/`types`
 * entry, e.g. './dist/src/index.js' or './dist/tests/testkit.js') back to
 * its TypeScript source file, GENERICALLY: strip the package's own
 * `outDir` prefix, then swap the compiled extension for `.ts`.
 *
 * Deliberately NOT the narrower "dist/src/X.js -> src/X.ts" rule — that
 * breaks on @skillsmith/core's own `./testkit` export entry, which
 * resolves to `dist/tests/testkit.js` (real source
 * `packages/core/tests/testkit.ts`) because packages/core/tsconfig.json's
 * `outDir: dist` covers both `src/**` and `tests/**` under one outDir. The
 * generic strip-prefix rule handles both shapes identically, and any
 * future sibling directory nested directly under the same outDir.
 *
 * Returns null (a "fails loud" signal the caller must surface, not a
 * silent guess) when:
 *   - `distRelPath` doesn't start with `${outDir}/` after normalization, or
 *   - the extension isn't one this function knows how to map
 *     (`.js` / `.mjs` / `.cjs` / `.d.ts`).
 *
 * @param {string} distRelPath
 * @param {string} outDir - already normalized via getPackageOutDir
 * @returns {string | null}
 */
export function mapDistPathToSourcePath(distRelPath, outDir) {
  if (typeof distRelPath !== 'string' || typeof outDir !== 'string' || outDir === '') return null
  const normalized = normalizeDirSegment(distRelPath.replace(/^\.\//, ''))
  const prefix = `${outDir}/`
  if (!normalized.startsWith(prefix)) return null
  const rest = normalized.slice(prefix.length)
  if (rest.endsWith('.d.ts')) return `${rest.slice(0, -'.d.ts'.length)}.ts`
  const jsExtMatch = rest.match(/\.(m?js|cjs)$/)
  if (jsExtMatch) return `${rest.slice(0, -jsExtMatch[0].length)}.ts`
  return null
}

/**
 * Pick the dist-relative target from one `exports` map condition entry.
 * Accepts a bare string (`"exports": { ".": "./dist/index.js" }`), a
 * conditions object (preferring `import` > `default` > `require` > `types`
 * — an `import`/`default`/`require` `.js` target maps to source more
 * reliably via mapDistPathToSourcePath than a `.d.ts`-only `types` target,
 * but `types` is accepted as a last resort), or an array of fallback
 * targets (Node's array-exports form, e.g. `["./dist/index.js"]`).
 * Recurses through nested conditions/arrays — a shape like
 * `{ node: { import: "./x.js" } }` (no top-level `import`/`default`/etc)
 * — until a string is found or every branch is exhausted, so callers only
 * ever receive a string or null and never reach string operations on a
 * bare object (which would crash downstream in mapDistPathToSourcePath).
 *
 * @param {unknown} conditionEntry
 * @param {number} [depth] - recursion guard against pathological nesting
 * @returns {string | null}
 */
function pickDistTarget(conditionEntry, depth = 0) {
  if (depth > 10) return null
  if (typeof conditionEntry === 'string') return conditionEntry
  if (Array.isArray(conditionEntry)) {
    for (const item of conditionEntry) {
      const result = pickDistTarget(item, depth + 1)
      if (result) return result
    }
    return null
  }
  if (!conditionEntry || typeof conditionEntry !== 'object') return null
  const PREFERRED_CONDITION_KEYS = ['import', 'default', 'require', 'types', 'node']
  for (const key of PREFERRED_CONDITION_KEYS) {
    if (key in conditionEntry) {
      const result = pickDistTarget(conditionEntry[key], depth + 1)
      if (result) return result
    }
  }
  // No preferred key matched (or all resolved to null) — fall back to any
  // remaining condition (e.g. a custom condition name) in declaration
  // order, rather than giving up on an entry that genuinely has a usable
  // string target under a condition name this function doesn't special-case.
  for (const key of Object.keys(conditionEntry)) {
    if (PREFERRED_CONDITION_KEYS.includes(key)) continue
    const result = pickDistTarget(conditionEntry[key], depth + 1)
    if (result) return result
  }
  return null
}

/**
 * Match a requested subpath (e.g. './foo') against a wildcard export key
 * (e.g. './*') per Node's pattern-matching exports algorithm: the '*' in
 * the pattern captures the corresponding segment of the requested
 * subpath. Returns the captured text, or null if the pattern doesn't match
 * (wrong prefix/suffix) or matches with an empty capture (Node requires a
 * non-empty match — an empty capture is treated as no match).
 *
 * @param {string} pattern - e.g. './*' or './features/*.js'
 * @param {string} subpath - e.g. './foo'
 * @returns {string | null}
 */
function matchWildcardSubpath(pattern, subpath) {
  const starIdx = pattern.indexOf('*')
  if (starIdx === -1) return null
  const prefix = pattern.slice(0, starIdx)
  const suffix = pattern.slice(starIdx + 1)
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return null
  const captured = subpath.slice(prefix.length, subpath.length - suffix.length)
  if (captured === '' || captured.includes('*')) return null
  return captured
}

/**
 * Resolve a requested subpath against a package's wildcard export entries
 * (e.g. `"./*": "./dist/*.js"`), substituting the captured segment into
 * the target template's own '*'. When more than one wildcard pattern
 * matches, the pattern with the longest literal prefix wins (most
 * specific), matching Node's own precedence rule.
 *
 * @param {Array<{ pattern: string, targetTemplate: string }>} wildcardEntries
 * @param {string} subpath
 * @returns {string | null}
 */
function resolveWildcardTarget(wildcardEntries, subpath) {
  let best = null
  for (const { pattern, targetTemplate } of wildcardEntries) {
    const captured = matchWildcardSubpath(pattern, subpath)
    if (captured === null) continue
    const prefixLen = pattern.indexOf('*')
    if (!best || prefixLen > best.prefixLen) {
      best = { prefixLen, target: targetTemplate.replace('*', captured) }
    }
  }
  return best ? best.target : null
}

/**
 * Resolve a package.json's export entry points to dist-relative targets.
 *
 * Handles every legitimate Node `exports` field shape:
 *   - A bare string (`"exports": "./dist/index.js"`) — no subpath keys at
 *     all, an implicit single `.` entry.
 *   - A subpath-keyed object (`{ ".": ..., "./foo": ... }`, every key
 *     starting with `.`, or `{}`) — the common case.
 *   - A root conditional object (`{ "import": "...", "types": "..." }`,
 *     NO key starting with `.`) — describes the `.` entry only; the keys
 *     are condition names, not subpaths, and must not be misread as such.
 *   - A wildcard subpath key (`"./*": "./dist/*.js"`) — kept separate from
 *     `entries` (exact-match subpaths) as a pattern to be resolved against
 *     the actual requested subpath by resolveWildcardTarget, rather than
 *     stored as a literal (and never-matching) `'./*'` key.
 *   - Mixed dot/non-dot keys — invalid per Node's own exports validation
 *     (it throws at resolution time); rather than guess, only the
 *     dot-prefixed subpath keys are honored so a malformed package.json
 *     degrades to a partial, non-crashing surface instead of silently
 *     misreading a condition name as a subpath.
 *   - `main`/`types` fallback, or none of the three (`hasExportsSurface:
 *     false` — the caller must warn(), not crash, e.g. `packages/cli`
 *     today: bin-only, no library surface at all).
 *
 * @param {{ exports?: unknown, main?: string, types?: string }} pkgJson
 * @returns {{
 *   hasExportsSurface: boolean,
 *   entries: Map<string, string>,
 *   wildcardEntries: Array<{ pattern: string, targetTemplate: string }>,
 * }}
 *   entries maps subpath ('.', './telemetry', ...) -> dist-relative target.
 */
export function getPackageExportEntries(pkgJson) {
  const rawExports = pkgJson && pkgJson.exports

  if (typeof rawExports === 'string') {
    return {
      hasExportsSurface: true,
      entries: new Map([['.', rawExports]]),
      wildcardEntries: [],
    }
  }

  if (rawExports && typeof rawExports === 'object' && !Array.isArray(rawExports)) {
    const keys = Object.keys(rawExports)
    const dotKeys = keys.filter((k) => k.startsWith('.'))

    if (dotKeys.length === 0 && keys.length > 0) {
      // Root conditional-exports object: every key is a condition name
      // (`import`/`types`/...), not a subpath — describes the '.' entry.
      const target = pickDistTarget(rawExports)
      return {
        hasExportsSurface: true,
        entries: target ? new Map([['.', target]]) : new Map(),
        wildcardEntries: [],
      }
    }

    // Subpath-keyed object (every key starts with '.', or {}), OR a mixed
    // dot/non-dot object degraded to its dot-prefixed keys only (see
    // docstring above).
    const entries = new Map()
    const wildcardEntries = []
    const subpathKeys = dotKeys.length === keys.length ? keys : dotKeys
    for (const subpath of subpathKeys) {
      const target = pickDistTarget(rawExports[subpath])
      if (!target) continue
      if (subpath.includes('*')) {
        wildcardEntries.push({ pattern: subpath, targetTemplate: target })
      } else {
        entries.set(subpath, target)
      }
    }
    return { hasExportsSurface: true, entries, wildcardEntries }
  }

  if (typeof pkgJson?.main === 'string') {
    return {
      hasExportsSurface: true,
      entries: new Map([['.', pkgJson.main]]),
      wildcardEntries: [],
    }
  }
  if (typeof pkgJson?.types === 'string') {
    return {
      hasExportsSurface: true,
      entries: new Map([['.', pkgJson.types]]),
      wildcardEntries: [],
    }
  }
  return { hasExportsSurface: false, entries: new Map(), wildcardEntries: [] }
}

/**
 * Resolve the dist-relative target for one requested subpath, checking
 * exact-match `entries` first, then falling back to wildcard pattern
 * matching (resolveWildcardTarget) — so a legitimate import through a
 * wildcard subpath (e.g. `pkg/foo` against `"./*": "./dist/*.js"`) is
 * actually resolved rather than reported as undeclared.
 *
 * @param {{ entries: Map<string, string>, wildcardEntries: Array<{ pattern: string, targetTemplate: string }> }} exportInfo
 * @param {string} subpath
 * @returns {string | null}
 */
function resolveDistTargetForSubpath(exportInfo, subpath) {
  if (exportInfo.entries.has(subpath)) return exportInfo.entries.get(subpath)
  return resolveWildcardTarget(exportInfo.wildcardEntries, subpath)
}

/**
 * Resolve the full exported-symbol set for one (package, subpath) pair,
 * reusing `collectTsEntryExports` (same `export *`-recursion, same
 * visited-file cycle guard Check 29 already relies on).
 *
 * `cache` (a plain Map the caller owns and reuses across the whole
 * audit-standards run) is keyed by the resolved absolute entry-source
 * path — so a run touching multiple consumers of the same sibling only
 * parses that sibling's source once. Lazy by construction: this function
 * only ever resolves the specific (package, subpath) pair a caller asks
 * for — a run whose consumers only ever touch 3 of core's 23 export
 * entries never parses the other 20.
 *
 * @param {object} params
 * @param {string} params.pkgDirAbs - absolute path to the sibling package's directory
 * @param {object} params.pkgJson - the sibling's parsed package.json
 * @param {object} params.tsconfigJson - the sibling's parsed tsconfig.json (or null if missing)
 * @param {string} params.subpath - e.g. '.' or './telemetry'
 * @param {(absPath: string) => string | null} params.readFile
 * @param {(fromAbsFile: string, relSpec: string) => string | null} params.resolveModule
 * @param {Map<string, Set<string>>} [params.cache]
 * @returns {
 *   { status: 'ok', names: Set<string>, entrySourcePath: string } |
 *   { status: 'no-exports-surface' } |
 *   { status: 'subpath-not-declared' } |
 *   { status: 'unmappable-dist-path', distRelPath: string, outDir: string | null }
 * }
 */
export function resolveExportSetForSubpath({
  pkgDirAbs,
  pkgJson,
  tsconfigJson,
  subpath,
  readFile,
  resolveModule,
  cache,
}) {
  const exportInfo = getPackageExportEntries(pkgJson)
  if (!exportInfo.hasExportsSurface) return { status: 'no-exports-surface' }
  const distRelPath = resolveDistTargetForSubpath(exportInfo, subpath)
  if (distRelPath === null || distRelPath === undefined) {
    return { status: 'subpath-not-declared' }
  }

  const outDir = getPackageOutDir(tsconfigJson)
  const sourceRelPath = outDir ? mapDistPathToSourcePath(distRelPath, outDir) : null
  if (!sourceRelPath) {
    return { status: 'unmappable-dist-path', distRelPath, outDir }
  }

  const entrySourcePath = join(pkgDirAbs, sourceRelPath)
  if (cache && cache.has(entrySourcePath)) {
    return { status: 'ok', names: cache.get(entrySourcePath), entrySourcePath }
  }

  const names = collectTsEntryExports(entrySourcePath, readFile, resolveModule)
  if (cache) cache.set(entrySourcePath, names)
  return { status: 'ok', names, entrySourcePath }
}
