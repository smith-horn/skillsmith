/**
 * Pure helpers extracted from audit-standards.mjs for SMI-3987 / SMI-3986.
 *
 * These are referenced by both:
 * - scripts/audit-standards.mjs (Check 11 & Check 23)
 * - scripts/tests/audit-standards.test.ts (unit tests via dynamic ESM import)
 *
 * The plan (docs/internal/implementation/smi-3987-3986-audit-standards-fixes.md)
 * originally called for hoisting these helpers to the top of audit-standards.mjs
 * itself, matching the convention in scripts/ci/check-supply-chain-pins.mjs.
 * That convention wraps the CLI body in a `main()` function so dynamic imports
 * don't trigger side effects. audit-standards.mjs is ~1670 lines and wrapping
 * its CLI body in `main()` would require indenting every line by 2 spaces — a
 * pure-mechanical change that bloats the diff and obscures the actual fix.
 *
 * Pragmatic adjustment: extract the 3 pure helpers to this small companion
 * file. The test imports from here directly. audit-standards.mjs imports them
 * by name and uses them inside its existing check blocks. Same plan-review E3
 * intent (use real exports, not shadow re-implementation), without the
 * indentation churn.
 *
 * Zero dependencies. No I/O. No side effects.
 */

/**
 * Parse a semver-ish version string into [major, minor, patch].
 * Returns null if the string does not start with `<int>.<int>.<int>`.
 * Prerelease tags and build metadata are ignored (sufficient for the npm
 * override specs used in root package.json — none use prereleases).
 */
export const parseSemver = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * Minimal zero-dep semver subset matching the operators used in root
 * package.json overrides: ^, ~, >=, >, and exact-literal. Sufficient for
 * Check 11's "did this override actually take effect?" question. Not a
 * general-purpose semver implementation — DO NOT use for application code.
 */
export const satisfies = (version, spec) => {
  const vp = parseSemver(version)
  if (!vp) return false
  if (spec.startsWith('^')) {
    const sp = parseSemver(spec.slice(1))
    if (!sp) return false
    if (sp[0] > 0) {
      return vp[0] === sp[0] && (vp[1] > sp[1] || (vp[1] === sp[1] && vp[2] >= sp[2]))
    }
    // ^0.x.y is tighter: locks minor
    return vp[0] === 0 && vp[1] === sp[1] && vp[2] >= sp[2]
  }
  if (spec.startsWith('~')) {
    const sp = parseSemver(spec.slice(1))
    if (!sp) return false
    return vp[0] === sp[0] && vp[1] === sp[1] && vp[2] >= sp[2]
  }
  if (spec.startsWith('>=')) {
    const sp = parseSemver(spec.slice(2).trim())
    if (!sp) return false
    if (vp[0] !== sp[0]) return vp[0] > sp[0]
    if (vp[1] !== sp[1]) return vp[1] > sp[1]
    return vp[2] >= sp[2]
  }
  if (spec.startsWith('>')) {
    const sp = parseSemver(spec.slice(1).trim())
    if (!sp) return false
    if (vp[0] !== sp[0]) return vp[0] > sp[0]
    if (vp[1] !== sp[1]) return vp[1] > sp[1]
    return vp[2] > sp[2]
  }
  // Literal / exact pin
  return version === spec
}

/**
 * SMI-5079: Parse `npm ls --json` output robustly.
 *
 * `npm ls` exits non-zero on tree warnings (peer-warning soup post-SMI-3984)
 * and may interleave non-JSON prelude or warning lines into the captured
 * output. Plain `JSON.parse(stdout)` then fails, dropping Check 11 into the
 * pessimistic "could not inspect tree" path on overrides that ARE working.
 *
 * Strategy:
 *   1. Try `JSON.parse(stdout)` directly (fast path, most common).
 *   2. If stdout has prelude text, try parsing the substring starting at the
 *      first `{`.
 *   3. If both fail, try the same two strategies against `stderr` (some
 *      npm builds split warnings/JSON across the streams).
 *   4. Return null if nothing parses — caller falls through to pessimistic
 *      warning, preserving the pre-SMI-3987 safe default.
 *
 * Returns the parsed tree object on success, or null.
 */
export const parseNpmLsJson = (stdout, stderr) => {
  const tryParse = (raw) => {
    if (!raw || typeof raw !== 'string') return null
    try {
      return JSON.parse(raw)
    } catch {
      // intentional fallthrough — try substring strategy
    }
    const braceIdx = raw.indexOf('{')
    if (braceIdx < 0) return null
    try {
      return JSON.parse(raw.slice(braceIdx))
    } catch {
      return null
    }
  }
  return tryParse(stdout) ?? tryParse(stderr)
}

// SMI-NNNN extraction patterns for Check 23. Subject-line refs always count
// as completion claims. Body refs only count when prefixed by a closing
// keyword (closes/closed/fix/fixes/fixed/resolve/resolves/resolved). The
// {1,20} cap on the captured run is a sanity bound — realistic max is ~5-10
// SMIs per marker; cap is documented but not strictly required.
const SUBJECT_ISSUE_RE = /\b(SMI-\d+)\b/gi
const CLOSES_MARKER_RE =
  /\b(closes|closed|fix|fixes|fixed|resolve|resolves|resolved)[:]?\s+((?:SMI-\d+[,\s]*){1,20})/gi
const BODY_ISSUE_RE = /\bSMI-\d+\b/gi

/**
 * Return the set of SMI-NNNN refs that this commit CLAIMS to complete.
 *
 * Counted as completion claims:
 *   1. Any SMI-NNNN that appears in the subject line.
 *   2. SMI-NNNN that appears in the body AFTER a closing keyword
 *      (closes/closed/fix/fixes/fixed/resolve/resolves/resolved), with or
 *      without the trailing colon. Example matches:
 *        - "closes: SMI-1234"
 *        - "fixes SMI-1234, SMI-5678" (no colon, multiple refs)
 *        - "Closed: SMI-1234"
 *
 * NOT counted (the SMI-3987 cite-in-body false positive fix):
 *   - SMI refs that appear in the body without a closing keyword prefix.
 *     Example: "per SMI-3099 doc" → not counted.
 *
 * Returns a Set of upper-cased SMI-NNNN strings.
 */
export const extractCompletionIssues = (subject, body) => {
  const out = new Set()
  let m
  // Subject line: every SMI-NNNN counts
  SUBJECT_ISSUE_RE.lastIndex = 0
  while ((m = SUBJECT_ISSUE_RE.exec(subject))) out.add(m[1].toUpperCase())
  // Body: only after a closes-marker
  CLOSES_MARKER_RE.lastIndex = 0
  while ((m = CLOSES_MARKER_RE.exec(body))) {
    const run = m[2]
    let s
    BODY_ISSUE_RE.lastIndex = 0
    while ((s = BODY_ISSUE_RE.exec(run))) out.add(s[0].toUpperCase())
  }
  return out
}

// ============================================================================
// SMI-4193: Smoke-test export drift helpers
// ============================================================================
//
// These helpers power Check 29. They prevent a recurrence of SMI-4189: a name
// removed from @skillsmith/core's public exports but still listed in the
// smoke-test `required` arrays passes local tests (workspace resolution) but
// fails the post-publish smoke run. Cost: a republish cycle.
//
// Design: pure parsing only. Caller does I/O and drives `export *` recursion
// by re-invoking `parseTsExports` on each resolved barrel path.

const COMMENT_BLOCK_RE = /\/\*[\s\S]*?\*\//g
const COMMENT_LINE_RE = /\/\/.*$/gm

const stripComments = (src) => src.replace(COMMENT_BLOCK_RE, '').replace(COMMENT_LINE_RE, '')

/**
 * Parse a single TypeScript file's export surface. Returns the directly-named
 * exports plus the relative specifiers of any `export * from './x.js'` chains
 * that the caller must recurse into.
 *
 * Handles:
 *   - export { A, B, type C, D as E } [from '...']
 *   - export (async) function|const|class|enum|let|var|interface|type Name
 *   - export * from './path.js'
 *
 * Ignores:
 *   - export default — has no named identity
 *   - re-exports from external packages (absolute specifiers) — not
 *     barrels we can resolve
 */
export const parseTsExports = (content) => {
  const src = stripComments(content)
  const names = new Set()
  const starFrom = []

  // export { ... } [from '...']
  const namedRe = /export\s+(?:type\s+)?\{([^}]+)\}(?:\s+from\s+['"]([^'"]+)['"])?/g
  let m
  while ((m = namedRe.exec(src))) {
    for (const raw of m[1].split(',')) {
      const entry = raw.trim()
      if (!entry) continue
      // `A as B` → B is the export name; `type A` → A
      const asMatch = entry.match(/\s+as\s+([A-Za-z_$][\w$]*)$/)
      const rawName = asMatch ? asMatch[1] : entry.replace(/^type\s+/, '').trim()
      const name = rawName.match(/^[A-Za-z_$][\w$]*$/)?.[0]
      if (name) names.add(name)
    }
  }

  // export (async)? function|const|class|enum|let|var|interface|type Name
  const declRe =
    /export\s+(?:async\s+)?(?:function\*?|const|class|enum|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/g
  while ((m = declRe.exec(src))) names.add(m[1])

  // export * from './path'  — record for caller to recurse
  const starRe = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g
  while ((m = starRe.exec(src))) starFrom.push(m[1])

  return { names, starFrom }
}

/**
 * Walk an entry-point TS file (e.g. packages/core/src/index.ts) and return
 * the full set of names it exports, following `export * from` chains.
 *
 * `readFile(absPath)` returns the file contents (string). Return null/''
 * for non-existent files — they're silently skipped so missing barrels
 * don't crash the audit.
 *
 * `resolveModule(fromFile, relSpec)` returns the absolute path of the
 * module referenced by `relSpec` (e.g. `./exports/services.js`), accounting
 * for the project's .js-in-source convention. Return null if unresolvable.
 */
export const collectTsEntryExports = (entryPath, readFile, resolveModule) => {
  const names = new Set()
  const visited = new Set()
  const stack = [entryPath]

  while (stack.length > 0) {
    const current = stack.pop()
    if (visited.has(current)) continue
    visited.add(current)

    const content = readFile(current)
    if (!content) continue

    const { names: localNames, starFrom } = parseTsExports(content)
    for (const n of localNames) names.add(n)

    for (const spec of starFrom) {
      const resolved = resolveModule(current, spec)
      if (resolved && !visited.has(resolved)) stack.push(resolved)
    }
  }

  return names
}

/**
 * Extract every string literal from every `required = [...]` or
 * `const required = [...]` assignment in the given smoke-test source.
 *
 * Returns an array of `{ name, arrayIndex }` records so callers can report
 * which block a missing name came from. Array indices are 0-based in the
 * order the arrays appear in the file (first required = block 0, etc.).
 *
 * Current smoke-test layout (scripts/smoke-test-published.ts) has three
 * `required` arrays, all validating @skillsmith/core exports. If future
 * packages add their own arrays, extend the caller's target-package map
 * (not this parser — it is package-agnostic).
 */
export const extractSmokeTestRequiredArrays = (content) => {
  const src = stripComments(content)
  const results = []
  const arrayRe = /\brequired\s*=\s*\[([\s\S]*?)\]/g
  let m
  let arrayIndex = 0
  while ((m = arrayRe.exec(src))) {
    const body = m[1]
    const strLit = /['"]([A-Za-z_$][\w$]*)['"]/g
    let s
    while ((s = strLit.exec(body))) {
      results.push({ name: s[1], arrayIndex })
    }
    arrayIndex++
  }
  return results
}

// ============================================================================
// SMI-4456 / SMI-4457 / SMI-4458: post-merge bug trifecta backstops (R-1/R-2/R-3)
// ============================================================================
// These three helpers power audit checks that prevent recurrence of the
// SMI-4454 surface-drift bug class. See retro:
//   docs/internal/retros/2026-04-24-smi-4454-post-merge-bug-trifecta.md
// All pure functions, no I/O — caller drives file reads.

/**
 * R-1 (SMI-4456): extract every Commander.js subcommand name registered by
 * the CLI. Combines names from the entry-point (`program.command('x')` and
 * explicit `.name('x')` overrides) with every `new Command('x')` and
 * `.alias('x')` declaration in the command factory files.
 *
 * @param {string} indexSrc — `packages/cli/src/index.ts` contents.
 * @param {Record<string, string>} commandSources — map of file path → source
 *   for every `packages/cli/src/commands/**\/*.ts` file (test files excluded
 *   by caller).
 * @returns {Set<string>} every name a user can legally type after `skillsmith`
 *   or `sklx`. Includes top-level commands, aliases, and known sub-commands.
 */
export const extractCliCommandNames = (indexSrc, commandSources) => {
  const names = new Set()
  // entry-point: program.command('<name>')
  for (const m of indexSrc.matchAll(/program\s*\.\s*command\(\s*['"]([a-z][\w-]*)['"]/g)) {
    names.add(m[1])
  }
  // entry-point: .name('<name>') overrides applied at addCommand time
  for (const m of indexSrc.matchAll(/\.name\(\s*['"]([a-z][\w-]*)['"]\s*\)/g)) {
    names.add(m[1])
  }
  // factories: new Command('<name>') + .alias('<name>')
  for (const src of Object.values(commandSources)) {
    const stripped = stripComments(src)
    for (const m of stripped.matchAll(/new\s+Command\(\s*['"]([a-z][\w-]*)['"]/g)) {
      names.add(m[1])
    }
    for (const m of stripped.matchAll(/\.alias\(\s*['"]([a-z][\w-]*)['"]\s*\)/g)) {
      names.add(m[1])
    }
  }
  return names
}

/**
 * R-1 (SMI-4456): scan CLI source for user-visible hint strings of the form
 * "Try it: skillsmith <subcmd>", "Run: sklx <subcmd>", etc. Returns each cited
 * subcommand with its location so the caller can match against the registered
 * command set.
 *
 * Patterns recognized: `(Try it|Run|Visit|Use):\s+(skillsmith|sklx)\s+<word>`.
 * URL hints (Visit: https://…) are not flagged here — different surface, see
 * R-2 for URL-shape checks. Comment lines (`//`, `*`) are skipped.
 *
 * @param {Record<string, string>} cliSrcByPath — map of file path → source.
 *   Caller is responsible for excluding test files.
 * @returns {Array<{file: string, line: number, refToken: string, fullMatch: string}>}
 */
export const findCliHintCommandRefs = (cliSrcByPath) => {
  const out = []
  // Match the hint marker, an optional opening backtick/quote, then
  // "skillsmith <word>" or "sklx <word>" on the same line.
  const HINT_RE = /(?:Try it|Run|Visit|Use):\s+`?(?:skillsmith|sklx)\s+([a-z][\w-]*)/g
  for (const [file, src] of Object.entries(cliSrcByPath)) {
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
      HINT_RE.lastIndex = 0
      let m
      while ((m = HINT_RE.exec(line)) !== null) {
        out.push({
          file,
          line: i + 1,
          refToken: m[1],
          fullMatch: m[0],
        })
      }
    }
  }
  return out
}

/**
 * R-2 (SMI-4457): find website client-side fetches that use a relative
 * `/functions/v1/...` path instead of the canonical
 * `${import.meta.env.PUBLIC_API_BASE_URL}/functions/v1/...` (or
 * `https://api.skillsmith.app/functions/v1/...`). Astro server-render emits
 * to www.skillsmith.app where `/functions/v1/...` 404s; the bug pattern was
 * introduced in PR #751 and surfaced as B1 in the SMI-4454 trifecta retro.
 *
 * @param {Record<string, string>} websiteSrcByPath — map of file path →
 *   source for every `packages/website/src/**\/*.{astro,ts}` file.
 * @returns {Array<{file: string, line: number, snippet: string}>}
 */
export const findRelativeFunctionsV1Urls = (websiteSrcByPath) => {
  const out = []
  // Quoted-literal path that begins with /functions/v1/. Excludes
  // `${var}/functions/v1/...` (where the leading `/` is an absolute-path
  // continuation of an interpolated origin) by requiring the quote/backtick
  // immediately before the slash.
  const REL_RE = /['"`]\/functions\/v1\//g
  for (const [file, src] of Object.entries(websiteSrcByPath)) {
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
      REL_RE.lastIndex = 0
      if (REL_RE.test(line)) {
        out.push({
          file,
          line: i + 1,
          snippet: trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed,
        })
      }
    }
  }
  return out
}

/**
 * R-3 (SMI-4458): flag PL/pgSQL `CREATE FUNCTION ... RETURNS TABLE(...)`
 * blocks whose body contains an unqualified `RETURNING <col>` matching one of
 * the TABLE output column names. PL/pgSQL treats TABLE(...) outputs as
 * implicit OUT parameters; the RETURNING clause is then ambiguous and
 * Postgres raises at call time. See B2 in the SMI-4454 trifecta retro.
 *
 * Walks migrations in lexicographic order (filename = version) and tracks
 * the LATEST `CREATE [OR REPLACE] FUNCTION` definition per function name —
 * so a later migration that re-declares the function with the fix
 * (qualified column) causes the audit to pass on main.
 *
 * Heuristic, not a parser. False positives are possible (cured by aliasing
 * the table and qualifying the column — harmless either way).
 *
 * @param {Record<string, string>} migrationsByPath — map of migration file
 *   path → source. Lexicographic key order = version order.
 * @returns {Array<{file: string, line: number, fnName: string, col: string, snippet: string}>}
 */
export const findReturningTableAmbiguity = (migrationsByPath) => {
  const sortedFiles = Object.keys(migrationsByPath).sort()
  const latestDefs = new Map()
  const FN_HEADER_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(/gi

  for (const file of sortedFiles) {
    const src = migrationsByPath[file]
    // Locate every `CREATE [OR REPLACE] FUNCTION` start; segment the source
    // into per-function blocks bounded by the next CREATE FUNCTION (or EOF).
    // This prevents the regex from skipping a non-TABLE-returning function
    // and incorrectly matching the next one's RETURNS TABLE block.
    const headers = []
    FN_HEADER_RE.lastIndex = 0
    let h
    while ((h = FN_HEADER_RE.exec(src)) !== null) {
      headers.push({ name: h[1], start: h.index })
    }
    for (let i = 0; i < headers.length; i++) {
      const blk = headers[i]
      const end = i + 1 < headers.length ? headers[i + 1].start : src.length
      const segment = src.slice(blk.start, end)
      // Only consider RETURNS TABLE functions written in plpgsql.
      const tableM = segment.match(/RETURNS\s+TABLE\s*\(([\s\S]*?)\)\s*LANGUAGE\s+plpgsql/i)
      if (!tableM) continue
      // Postgres dollar-quoting allows arbitrary tags: $$ ... $$, $function$ ... $function$,
      // $body$ ... $body$, etc. Capture the tag and require a matching closer.
      const bodyM = segment.match(/AS\s+\$(\w*)\$([\s\S]*?)\$\1\$/)
      if (!bodyM) continue
      const body = bodyM[2]
      const tableColsRaw = tableM[1]
      const cols = []
      for (const part of tableColsRaw.split(',')) {
        const cm = part.trim().match(/^(\w+)\s+\S/)
        if (cm) cols.push(cm[1])
      }
      const declStartLine = src.slice(0, blk.start).split('\n').length
      // bodyM.index is relative to `segment`; the actual body content starts
      // after `AS $$` (length of the prefix before capture group 1).
      const bodyOffsetInSegment = bodyM.index + bodyM[0].indexOf(body)
      const bodyStartLine = src.slice(0, blk.start + bodyOffsetInSegment).split('\n').length
      latestDefs.set(blk.name, {
        file,
        declStartLine,
        bodyStartLine,
        body,
        tableCols: cols,
      })
    }
  }

  const violations = []
  // Match RETURNING followed by a single bareword column name. Reject
  // qualified refs (`alias.col`) by requiring no `.` immediately before.
  const RET_RE = /(?<![.\w])RETURNING\s+(\w+)\b/gi
  for (const [fnName, def] of latestDefs) {
    if (def.tableCols.length === 0) continue
    const colSet = new Set(def.tableCols)
    const lines = def.body.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().startsWith('--')) continue
      RET_RE.lastIndex = 0
      let rm
      while ((rm = RET_RE.exec(line)) !== null) {
        const col = rm[1]
        // Defensive: even with the lookbehind, double-check via per-line
        // pattern that no `<alias>.<col>` form appears for this column.
        const qualified = new RegExp(`\\.\\s*${col}\\b`)
        if (qualified.test(line)) continue
        if (colSet.has(col)) {
          violations.push({
            file: def.file,
            line: def.bodyStartLine + i,
            fnName,
            col,
            snippet: line.trim().slice(0, 120),
          })
        }
      }
    }
  }
  return violations
}

/**
 * R-4 (SMI-4459): given a list of file paths and a set of trigger globs from
 * `scripts/smoke-prod/surfaces.json`, return paths NOT covered by any glob
 * and NOT matched by an allowlist entry. The orchestrator's glob semantics
 * are mirrored exactly:
 *   - `prefix/**` matches `prefix/anything/below`
 *   - `prefix/*`  matches files directly under `prefix/`
 *   - exact path matches iff equal
 *
 * @param {string[]} candidatePaths — paths to check (e.g., every
 *   `supabase/functions/*\/index.ts` and `packages/website/src/pages/**.astro`).
 * @param {string[]} surfaceGlobs — flattened set of trigger_globs from all
 *   surfaces in surfaces.json.
 * @param {string[]} allowlistGlobs — entries from
 *   `scripts/smoke-prod/.surfaces-allowlist.txt` (non-empty, non-comment lines).
 * @returns {string[]} paths that are user-facing but neither covered nor allowlisted.
 */
export const findUncoveredSurfacePaths = (candidatePaths, surfaceGlobs, allowlistGlobs) => {
  const matchesGlob = (file, glob) => {
    if (glob.endsWith('/**')) {
      const prefix = glob.slice(0, -3)
      return file === prefix || file.startsWith(prefix + '/')
    }
    if (glob.endsWith('/*')) {
      const prefix = glob.slice(0, -2)
      if (!file.startsWith(prefix + '/')) return false
      const rest = file.slice(prefix.length + 1)
      return rest.length > 0 && !rest.includes('/')
    }
    return file === glob
  }
  const matchesAny = (file, globs) => globs.some((g) => matchesGlob(file, g))

  const uncovered = []
  for (const path of candidatePaths) {
    if (matchesAny(path, surfaceGlobs)) continue
    if (matchesAny(path, allowlistGlobs)) continue
    uncovered.push(path)
  }
  return uncovered
}

// ----- SMI-4647 + SMI-4648: pure-JS carve-out drift -----

/**
 * Parse a GitHub Actions workflow YAML into a list of jobs.
 * Each job: { name, line (1-indexed), body (string of full job block) }.
 *
 * Only jobs nested under the top-level `jobs:` key are returned — other
 * 2-space-indented identifiers (e.g. `on.push`) are skipped.
 *
 * @param {string} ciYmlContent — full text of `.github/workflows/<file>.yml`.
 * @returns {Array<{name: string, line: number, body: string}>}
 */
export const parseCiYmlJobs = (ciYmlContent) => {
  const lines = ciYmlContent.split('\n')
  // Find the `jobs:` top-level key (column 0).
  let jobsStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^jobs:\s*$/.test(lines[i])) {
      jobsStart = i + 1
      break
    }
  }
  if (jobsStart === -1) return []
  // Find where the `jobs:` block ends — first line after jobsStart at column 0
  // that starts a new top-level key (or EOF).
  let jobsEnd = lines.length
  for (let i = jobsStart; i < lines.length; i++) {
    if (/^[a-zA-Z_][a-zA-Z0-9_-]*:/.test(lines[i])) {
      jobsEnd = i
      break
    }
  }
  // Within [jobsStart, jobsEnd), match 2-space-indented job headers.
  const jobs = []
  for (let i = jobsStart; i < jobsEnd; i++) {
    const m = lines[i].match(/^  ([a-z][a-z0-9-]*):\s*$/)
    if (!m) continue
    const jobName = m[1]
    let end = jobsEnd
    for (let j = i + 1; j < jobsEnd; j++) {
      if (/^  [a-z][a-z0-9-]*:\s*$/.test(lines[j])) {
        end = j
        break
      }
    }
    jobs.push({ name: jobName, line: i + 1, body: lines.slice(i, end).join('\n') })
  }
  return jobs
}

// ============================================================================
// SMI-4925: skills-recreate migration FK-cascade guard
// ============================================================================
//
// SQLite fires ON DELETE CASCADE actions *immediately* when foreign_keys=ON,
// not deferred to end of transaction. The skills-recreate pattern (DROP TABLE
// skills + RENAME) therefore silently deletes all child rows in any table with
// a hard `skill_id ... REFERENCES skills(id) ON DELETE CASCADE` column.
//
// SMI-4919 fixed this in v17 by backing `skill_categories` (the only such
// child as of that migration) into a TEMP table before DROP TABLE skills and
// restoring it after the RENAME — all inside one BEGIN/COMMIT.
//
// This helper detects any future migration that recreates the skills table
// WITHOUT that backup/restore pair, preventing the bug from being reintroduced.
//
// If a new ON DELETE CASCADE child of `skills` is added to schema-sql.ts,
// the conforming backup/restore pattern must be extended to include it, and
// the regex below updated accordingly (the helper would still catch the
// absence of the _skill_categories_backup pattern, which is a useful signal).

/**
 * Detect skills-table recreation migrations that do NOT include the
 * `_skill_categories_backup` TEMP-table backup/restore pair required to
 * preserve ON DELETE CASCADE child rows (SMI-4919 / SMI-4925).
 *
 * @param {Record<string, string>} migrationsByPath — map of file path →
 *   file contents for every migration to check.
 * @param {{ allowList: string[] }} options — basenames to skip without
 *   flagging (e.g. `['v16-skill-source.ts']` for fix-forward allowlisting).
 * @returns {Array<{file: string, reason: string}>}
 */
export const findUnsafeSkillsRecreateMigrations = (migrationsByPath, { allowList = [] } = {}) => {
  // Matches DROP TABLE [IF EXISTS] skills — word-boundary after `skills` so
  // `DROP TABLE skills_v17` and `DROP TABLE _skill_categories_backup` do NOT
  // match. Case-insensitive, tolerant of extra whitespace.
  const DROP_SKILLS_RE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?skills\b/i

  // Both halves of the backup/restore pair must be present.
  // Half A: CREATE TEMP TABLE _skill_categories_backup (followed by AS SELECT
  //         ... FROM skill_categories — we only require the CREATE TEMP TABLE
  //         prefix; the AS SELECT part is optional in the regex for robustness).
  const BACKUP_CREATE_RE = /CREATE\s+TEMP\s+TABLE\s+_skill_categories_backup\b/i

  // Half B: INSERT INTO skill_categories SELECT * FROM _skill_categories_backup
  const BACKUP_RESTORE_RE =
    /INSERT\s+INTO\s+skill_categories\s+SELECT\s+.*FROM\s+_skill_categories_backup\b/i

  const violations = []

  for (const [filePath, content] of Object.entries(migrationsByPath)) {
    const basename = filePath.split('/').pop() ?? filePath

    // Check if this migration recreates the skills table.
    if (!DROP_SKILLS_RE.test(content)) continue

    // Allow-listed files are skipped without flagging (fix-forward).
    if (allowList.includes(basename)) continue

    // A safe recreate must include BOTH halves of the backup/restore pair.
    const hasBackupCreate = BACKUP_CREATE_RE.test(content)
    const hasBackupRestore = BACKUP_RESTORE_RE.test(content)

    if (hasBackupCreate && hasBackupRestore) continue

    // Determine which halves are missing for the reason string.
    if (!hasBackupCreate && !hasBackupRestore) {
      violations.push({
        file: filePath,
        reason:
          'recreates `skills` table (DROP TABLE skills) but is missing both halves of the ' +
          '_skill_categories_backup TEMP-table guard (CREATE TEMP TABLE + INSERT INTO ... SELECT)',
      })
    } else if (!hasBackupCreate) {
      violations.push({
        file: filePath,
        reason:
          'recreates `skills` table but is missing the backup half: ' +
          '`CREATE TEMP TABLE _skill_categories_backup AS SELECT * FROM skill_categories`',
      })
    } else {
      violations.push({
        file: filePath,
        reason:
          'recreates `skills` table but is missing the restore half: ' +
          '`INSERT INTO skill_categories SELECT * FROM _skill_categories_backup`',
      })
    }
  }

  return violations
}

/**
 * Check pure-JS carve-out invariants on a parsed job list.
 *
 * Invariant A: every job with `needs:` containing `docker-build` must either
 *   invoke `docker run skillsmith-ci:` OR carry the `# audit:carveout-pure-js`
 *   marker comment in its header.
 * Invariant B: every job carrying the carve-out marker must NOT pass
 *   `--only <flag>` (to `npm run audit:standards`) where flag is in the
 *   native-loading deny-list.
 *
 * @param {Array<{name: string, line: number, body: string}>} jobs — output of parseCiYmlJobs.
 * @param {string[]} denyList — native-loading audit-standards --only flags.
 * @returns {{ violationsA: Array, violationsB: Array }}
 */
export const checkCarveOutInvariants = (jobs, denyList) => {
  const violationsA = []
  const violationsB = []
  for (const job of jobs) {
    const needsDockerBuild = /^\s+needs:.*\bdocker-build\b/m.test(job.body)
    const hasCarveOutMarker = /#\s*audit:carveout-pure-js\b/.test(job.body)
    // SMI-4866: collapse shell-continuation backslashes to spaces so a single
    // flat regex can match a multi-line `docker run ... skillsmith-ci:` block.
    // The previous nested-quantifier regex `(?:.*\\\s*\n\s*)*` is catastrophically
    // backtrackable on malformed inputs (CodeQL js/redos #90, #91).
    const bodyCollapsed = job.body.replace(/\\\n\s*/g, ' ')
    const usesDockerRun = /docker run(?:\s+--rm)?(?:\s+--init)?\s+[^\n]*skillsmith-ci:/.test(
      bodyCollapsed
    )
    if (needsDockerBuild && !usesDockerRun && !hasCarveOutMarker) {
      violationsA.push({
        name: job.name,
        line: job.line,
        reason:
          'needs: docker-build but no `docker run skillsmith-ci:` invocation and no carve-out marker',
      })
    }
    if (hasCarveOutMarker) {
      for (const flag of denyList) {
        const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(`audit:standards.*--only\\s+${escapedFlag}\\b`)
        if (re.test(job.body)) {
          violationsB.push({ name: job.name, line: job.line, flag })
        }
      }
    }
  }
  return { violationsA, violationsB }
}

/**
 * Parse a Bash array declaration of the form:
 *
 *   ARRAY_NAME=(
 *     entry-one
 *     entry-two   # optional inline comment
 *   )
 *
 * Returns a Set<string> of the parsed entry names, or null if the array
 * cannot be found (i.e. the closing `)` on its own line is missing, meaning
 * the script format has changed). Tolerates quoted/unquoted entries and
 * inline `#` comments.
 *
 * Token regex accepts [a-z0-9_-] — the underscore is included because Supabase
 * function names may contain underscores even though all current names use
 * hyphens. Without `_`, an underscore-named entry would be silently ignored
 * rather than parsed and later flagged as unregistered.
 *
 * Used by Check 47 (edge-function registration coherence, SMI-4963) to parse
 * NO_VERIFY_JWT_FUNCTIONS / VERIFY_JWT_FUNCTIONS from deploy-edge-functions.sh
 * and ANONYMOUS_FUNCTIONS / AUTHENTICATED_FUNCTIONS / SERVICE_ROLE_FUNCTIONS
 * from validate-edge-functions.sh.
 *
 * @param {string} src - Full file contents of the shell script.
 * @param {string} arrayName - The exact variable name (e.g. 'NO_VERIFY_JWT_FUNCTIONS').
 * @returns {Set<string> | null}
 */
export function parseBashArray(src, arrayName) {
  const re = new RegExp(`^${arrayName}=\\(\\s*\\n([\\s\\S]*?)^\\)\\s*$`, 'm')
  const m = src.match(re)
  if (!m) return null
  const body = m[1]
  const entries = new Set()
  for (const rawLine of body.split('\n')) {
    // Strip inline `# ...` comments and surrounding whitespace.
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    // Each line is one entry: bare-word OR "quoted" OR 'quoted'.
    const tok = line.match(/^["']?([a-z0-9][a-z0-9_-]*)["']?$/i)
    if (tok) entries.add(tok[1])
  }
  return entries
}

/**
 * Parse the @consumers JSDoc tag from a source file's top comment block.
 *
 * The tag declares the in-tree consumers of a shared helper. Format:
 *   * @consumers name-a, name-b, name-c
 *
 * Names are comma-separated, alphabetically sorted, lowercased kebab-case.
 * Names must match /^[a-z0-9][a-z0-9-]*$/ — underscore-prefix is rejected by
 * design (prevents '_shared' from being declared as a consumer; '_shared'
 * is the helper-host, not a consumer).
 *
 * Sort enforcement (sorted === false fails predicate 5): makes
 * append-without-sort merge conflicts deterministic. Two PRs that both
 * add a consumer alphabetically-positioned conflict immediately at the
 * same line range, surfacing the collision rather than producing
 * silently-merging duplicates.
 *
 * Used by audit:standards Check 47 predicate 5 (SMI-5004).
 *
 * @param {string} src - Full file contents (UTF-8).
 * @returns {{ found: boolean, names: string[], sorted: boolean } | null}
 *   - null  → parse-failure (e.g., invalid token like 'Foo_Bar', empty value)
 *   - { found:false, names:[], sorted:true } → tag absent
 *   - { found:true, names, sorted } → tag present
 */
export function parseConsumersTag(src) {
  // Match `@consumers` followed by optional trailing content. The capture
  // group is greedy-but-bounded-to-EOL; allow empty so we can return null
  // on empty-value as a parse failure (degenerate case) rather than
  // mis-classifying it as "tag absent".
  const m = src.match(/^\s*\*\s*@consumers\b[ \t]*(.*?)[ \t]*$/m)
  if (!m) return { found: false, names: [], sorted: true }
  const rawValue = m[1].trim()
  if (!rawValue) return null
  const tokens = rawValue
    .split(/\s*,\s*/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  const validRe = /^[a-z0-9][a-z0-9-]*$/
  for (const tok of tokens) {
    if (!validRe.test(tok)) return null
  }
  const sortedCopy = [...tokens].sort()
  const sorted = tokens.every((tok, i) => tok === sortedCopy[i])
  return { found: true, names: tokens, sorted }
}

// --- Check 49: Convention drift backstop (SMI-5026 M5) -----------------------
//
// Encodes the four "Convention check before novelty" greps from the
// `skill-invoke-telemetry.md` plan (lines 666-674 + 723-730) as static
// invariants that re-run on every PR — not just at plan time.
//
// Per plan template § "Convention check before novelty", generic surveys
// require knowing the plan's `<pattern-prefix>` to grep for, which can't be
// statically discovered. We therefore encode the four telemetry-specific
// invariants explicitly. Adding a future Check 49-style invariant means
// extending this helper, not rewriting the audit loop.

/**
 * Parse a TypeScript discriminated-union of string literals. Tolerates a
 * leading `|` separator (most-common case) and accepts both `'foo'` and
 * `"foo"` quoting. Returns the set of literal members, or null if the type
 * declaration cannot be located.
 *
 * Example matched shape:
 *   export type Foo = | 'a' | 'b' | 'c'
 *
 * @param {string} src - TypeScript source
 * @param {string} typeName - exact exported type alias name
 * @returns {Set<string> | null}
 */
export function parseStringUnionType(src, typeName) {
  // Match `export type <Name> = ...` up to (a) the next blank line, or (b)
  // a newline followed by a top-level declaration keyword. We deliberately
  // omit `$` from the lookahead alternatives because, with the `m` flag, `$`
  // matches every line-end and would terminate the lazy capture after the
  // first literal. Without the `m` flag, `^` would not match the export
  // keyword anchor reliably — so we keep `m` and use the blank-line +
  // keyword-boundary alternatives only.
  const re = new RegExp(
    `^(?:export\\s+)?type\\s+${typeName}\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\n|\\n(?:export|import|interface|type|function|const|let|var|class|namespace)\\b)`,
    'm'
  )
  const m = src.match(re)
  if (!m) return null
  const body = m[1]
  const out = new Set()
  const litRe = /['"]([a-z][a-z0-9_]*)['"]/gi
  let lm
  while ((lm = litRe.exec(body)) !== null) out.add(lm[1])
  return out
}

/**
 * Parse a `const X = [ ... ] as const` TypeScript array-of-string-literals.
 * Tolerates inline comments and trailing commas. Returns the set of entries,
 * or null if the array declaration cannot be located.
 *
 * @param {string} src
 * @param {string} arrayName
 * @returns {Set<string> | null}
 */
export function parseTsLiteralArray(src, arrayName) {
  const re = new RegExp(
    `(?:const|let|var|readonly)\\s+${arrayName}\\s*(?::[^=]*)?=\\s*\\[([\\s\\S]*?)\\]`,
    'm'
  )
  const m = src.match(re)
  if (!m) return null
  const body = m[1]
  const out = new Set()
  // Strip line + block comments before matching, so commented-out entries
  // ('// 'foo', // legacy') don't get counted as members.
  const stripped = body.replace(/\/\/[^\n]*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const litRe = /['"]([a-z][a-z0-9_]*)['"]/gi
  let lm
  while ((lm = litRe.exec(stripped)) !== null) out.add(lm[1])
  return out
}

/**
 * Find definitions (not call sites) of a function or const named `symbol`
 * across the provided source files. A "definition" is one of:
 *   - `function <symbol>(`  (function declaration)
 *   - `export function <symbol>(` / `async function <symbol>(`
 *   - `const <symbol> =` / `let <symbol> =` / `var <symbol> =` followed by
 *     either `function` or an arrow `(...) =>`
 *
 * A call site like `withTelemetry(handler, {...})` is NOT a definition and
 * is intentionally excluded. The canonical `wrap.ts` declaration site is
 * the single source of truth (SMI-5016); any parallel definition signals
 * drift and must be flagged.
 *
 * @param {Record<string, string>} srcByPath
 * @param {string} symbol - bareword identifier (no regex metachars)
 * @returns {{ file: string, line: number, snippet: string }[]}
 */
export function findFunctionDefinitions(srcByPath, symbol) {
  const out = []
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) return out
  // Two anchored patterns:
  //   (a) `function <symbol>` (also matches `export function`/`async function`)
  //   (b) `const|let|var <symbol> = ... function|=>`
  const defRe = new RegExp(
    `^[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s+${symbol}\\b|` +
      `^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${symbol}\\s*(?::[^=]*)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]*)?\\s*=>)`,
    'm'
  )
  for (const [file, src] of Object.entries(srcByPath)) {
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (defRe.test(lines[i])) {
        out.push({ file, line: i + 1, snippet: lines[i].trim() })
      }
    }
  }
  return out
}

/**
 * Returns `true` if the definition at `line` (1-indexed) in `src` is opted out
 * of Check 48c via an `audit:check-48-ack` marker — either on the definition
 * line itself or anywhere in the contiguous comment block immediately preceding
 * it. The upward walk stops at the first blank OR non-comment line, so a distant
 * comment carrying the token cannot reach an unrelated definition.
 *
 * Why preceding-comment-aware (not same-line only, like 48d): a `withTelemetry`
 * signature is frequently multi-line (generics + params), so a trailing same-line
 * marker would fight the formatter. The one legitimate parallel definition
 * (the esbuild-bundled VS Code extension's local wrapper, which cannot import the
 * canonical core HOF) carries its ack on the comment block above the def.
 *
 * A comment line is one whose trimmed form starts with `//`, `*`, or `/*`.
 * Detection is substring (`String.prototype.includes`), matching 48d's existing
 * tradeoff: a def line containing the literal token inside an unrelated string
 * would be falsely suppressed — narrow, and the audit script excludes itself
 * from the survey.
 *
 * @param {string} src - full file contents
 * @param {number} line - 1-indexed definition line
 * @returns {boolean}
 */
export function defHasCheck48Ack(src, line) {
  const lines = src.split('\n')
  const defIdx = line - 1
  if (defIdx < 0 || defIdx >= lines.length) return false
  if (lines[defIdx].includes('audit:check-48-ack')) return true
  for (let i = defIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed === '') break
    const isComment =
      trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
    if (!isComment) break
    if (lines[i].includes('audit:check-48-ack')) return true
  }
  return false
}

/**
 * Find literal `/tmp/skillsmith-` references in production source. Excludes
 * test files (matching `*.test.*`, `*.spec.*`, `__tests__/`, `tests/`,
 * `_tests_/`, `/e2e/`, `fixtures/`) — those legitimately use the prefix as
 * a sandbox path per the test-isolation convention.
 *
 * Per-line opt-out marker `audit:check-48-ack` is honoured: any line
 * containing this token is excluded. The marker is the documented escape
 * hatch for legitimate edge cases (example code in comments, etc) and MUST
 * sit on the same physical line as the violation alongside a rationale.
 *
 * @param {Record<string, string>} srcByPath
 * @returns {{ file: string, line: number, snippet: string }[]}
 */
export function findTmpSkillsmithRefs(srcByPath) {
  const out = []
  const TEST_PATH_RE =
    /(?:\.test\.|\.spec\.|\b__tests__\b|\btests\b|\b_tests_\b|\/e2e\/|fixtures\/)/i
  for (const [file, src] of Object.entries(srcByPath)) {
    if (TEST_PATH_RE.test(file)) continue
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.includes('/tmp/skillsmith-')) continue
      if (line.includes('audit:check-48-ack')) continue
      out.push({ file, line: i + 1, snippet: line.trim() })
    }
  }
  return out
}

/**
 * Compose Check 49 results from raw inputs. Pure — caller does all I/O.
 * Returns a structured result so the audit-standards.mjs runner can render
 * per-sub-check messages with `fail()` / `warn()`.
 *
 * Sub-checks:
 *   48a: SkillsmithEventType union ⊇ {expected event names}    (FAIL)
 *   48b: ALLOWED_EVENTS array     ⊇ {expected event names}    (FAIL)
 *   48c: withTelemetry has exactly ONE definition site         (WARN)
 *   48d: /tmp/skillsmith- absent from prod source              (WARN)
 *
 * Severity rationale: 48a/48b are exact-string set-membership tests against
 * declared sources of truth (no false-positive surface — drift IS the bug).
 * 48c/48d are grep-based heuristics that might over-flag in legitimate
 * edge cases — `warn()` keeps them visible without blocking PRs, matching
 * the false-positive-fatigue guidance in CLAUDE.md governance retros. Both
 * honor an `audit:check-48-ack` opt-out marker: 48d per-line (same line as the
 * reference), 48c on the def line or the comment block immediately above the
 * parallel definition (see defHasCheck48Ack).
 *
 * @param {object} input
 * @param {string} input.posthogSrc - contents of packages/core/src/telemetry/posthog.ts
 * @param {string} input.eventsSrc - contents of supabase/functions/events/index.ts
 * @param {Record<string,string>} input.surveySrcByPath - all .ts files in scope for 48c/48d
 * @param {string[]} input.expectedNewEvents - canonical list (e.g. ['skill_invoke', ...])
 * @param {string} input.canonicalWithTelemetryPath - the ONE allowed definition site
 * @returns {{
 *   eventTypeUnionMissing: string[],
 *   allowedEventsMissing: string[],
 *   eventTypeUnionParseFailed: boolean,
 *   allowedEventsParseFailed: boolean,
 *   parallelWithTelemetryDefs: {file:string,line:number,snippet:string}[],
 *   tmpSkillsmithRefs: {file:string,line:number,snippet:string}[],
 * }}
 */
export function findConventionDrift(input) {
  const { posthogSrc, eventsSrc, surveySrcByPath, expectedNewEvents, canonicalWithTelemetryPath } =
    input

  // 48a: SkillsmithEventType union must list every expectedNewEvents member.
  const union = parseStringUnionType(posthogSrc, 'SkillsmithEventType')
  const eventTypeUnionParseFailed = union === null
  const eventTypeUnionMissing = union ? expectedNewEvents.filter((e) => !union.has(e)) : []

  // 48b: ALLOWED_EVENTS const must include every expectedNewEvents member.
  const allowed = parseTsLiteralArray(eventsSrc, 'ALLOWED_EVENTS')
  const allowedEventsParseFailed = allowed === null
  const allowedEventsMissing = allowed ? expectedNewEvents.filter((e) => !allowed.has(e)) : []

  // 48c: exactly one withTelemetry definition (in canonicalWithTelemetryPath).
  // A parallel definition can opt out via an `audit:check-48-ack` marker on the
  // def line or in the comment block immediately above it (genuinely-justified
  // surfaces, e.g. the esbuild-bundled VS Code extension that cannot import the
  // core HOF). See defHasCheck48Ack.
  const allDefs = findFunctionDefinitions(surveySrcByPath, 'withTelemetry')
  const parallelWithTelemetryDefs = allDefs.filter(
    (d) =>
      d.file !== canonicalWithTelemetryPath &&
      !defHasCheck48Ack(surveySrcByPath[d.file] ?? '', d.line)
  )

  // 48d: /tmp/skillsmith- must not appear in production source.
  const tmpSkillsmithRefs = findTmpSkillsmithRefs(surveySrcByPath)

  return {
    eventTypeUnionMissing,
    allowedEventsMissing,
    eventTypeUnionParseFailed,
    allowedEventsParseFailed,
    parallelWithTelemetryDefs,
    tmpSkillsmithRefs,
  }
}

/**
 * Aliases for publish-* job names whose pre-publish-check output key uses
 * a shorter name than the job's full shortName.
 *
 * SMI-5066: when generalizing Check 48 from core-only to any-package, we
 * discovered that `publish-mcp-server`'s YAML output key is `mcp-exists`
 * (not `mcp-server-exists`) — the bash var `mcp_exists` → key `mcp-exists`.
 * This pre-existing convention drift is documented here rather than
 * normalized (out of SMI-5066 scope).
 *
 * Audit-standards.mjs Check 48 imports this map.
 */
export const PUBLISH_JOB_TO_OUTPUT_ALIAS = Object.freeze({
  'mcp-server': 'mcp',
})

/**
 * Audit publish.yml for the SMI-5060 invariant: every
 * `needs.publish-<pkg>.result == 'skipped'` clause MUST be paired with
 * `pre-publish-check.outputs.<outputKey>-exists == 'true'` (where
 * outputKey = PUBLISH_JOB_TO_OUTPUT_ALIAS[pkg] || pkg) within ±1 line.
 *
 * Background (SMI-5060): when `validate` fails, `publish-<pkg>` auto-skips
 * because its `needs:` failed. GitHub Actions reports
 * `needs.publish-<pkg>.result == 'skipped'` — indistinguishable from the
 * legitimate "package already on npm, nothing to publish" skip. Without
 * the paired exists predicate, downstream publish-* jobs publish broken
 * dependents (orphan-consumer release class of bug).
 *
 * SMI-5066: generalized to any `publish-<pkg>` job (not just publish-core)
 * so the same invariant covers every dependent publish job (e.g. enterprise).
 *
 * @param {string} content - Full publish.yml content (UTF-8).
 * @returns {{
 *   matches: Array<{ lineno: number, line: string, pkg: string, outputKey: string }>,
 *   failures: Array<{ lineno: number, line: string, pkg: string, outputKey: string }>,
 * }} matches is every skipped-clause found. failures is the subset missing
 *    the paired guard within ±1 line.
 */
export function auditPublishYmlDependentGate(content) {
  const lines = content.split('\n')
  const skippedRegex = /needs\.publish-([a-z][a-z0-9-]*)\.result\s*==\s*'skipped'/

  const matches = []
  lines.forEach((line, idx) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) return
    const m = line.match(skippedRegex)
    if (m) {
      const pkg = m[1]
      const outputKey = PUBLISH_JOB_TO_OUTPUT_ALIAS[pkg] || pkg
      matches.push({ lineno: idx + 1, line: trimmed, pkg, outputKey })
    }
  })

  const failures = []
  for (const match of matches) {
    const { lineno, outputKey } = match
    // Window: lines (lineno-1) through (lineno+1) — i.e. matched line ±1.
    // lineno is 1-based; `lines` is 0-indexed, so the slice covers idx-1..idx+1.
    const startIdx = Math.max(0, lineno - 2)
    const endIdx = Math.min(lines.length, lineno + 1)
    const window = lines.slice(startIdx, endIdx).join('\n')
    const expectedGuard = new RegExp(
      `pre-publish-check\\.outputs\\.${outputKey}-exists\\s*==\\s*'true'`
    )
    if (!expectedGuard.test(window)) {
      failures.push(match)
    }
  }

  return { matches, failures }
}

/**
 * Map an `@scope/name` package name to its publish-job short name.
 * `@skillsmith/mcp-server` → `mcp-server`, `@smith-horn/enterprise` →
 * `enterprise`. Mirrors the `<scope>/<shortName>` → `publish-<shortName>`
 * convention used throughout publish.yml.
 *
 * @param {string} name
 * @returns {string}
 */
function shortNameFromPackage(name) {
  const slash = name.indexOf('/')
  return slash === -1 ? name : name.slice(slash + 1)
}

/**
 * SMI-5123: POSITIVE-COVERAGE assertion for publish.yml dependency gating.
 *
 * `auditPublishYmlDependentGate` only checks SOUNDNESS: any
 * `publish-X.result == 'skipped'` clause that EXISTS must carry its paired
 * `X-exists` predicate. It says nothing about gates that are MISSING entirely
 * — exactly the SMI-5123 bug (publish-cli depends on @skillsmith/mcp-server in
 * package.json but had NO gate on publish-mcp-server, so cli could publish a
 * live dangling ref while mcp-server was skipped).
 *
 * This helper derives the REQUIRED gates from ground truth (each publishable
 * package's package.json workspace-sibling deps that are themselves
 * publishable) and asserts that the consumer's publish job both (a) `needs:`
 * the sibling's publish job and (b) carries the SMI-5060 paired predicate
 * (`needs.publish-<sibling>.result == 'skipped' && ...<key>-exists == 'true'`).
 *
 * @param {string} publishYmlContent - Full publish.yml content (UTF-8).
 * @param {Array<{ name: string, json: any }>} pkgJsons - Publishable packages:
 *   each `name` is the npm package name and `json` is its parsed package.json.
 *   Only packages whose `name` appears in this list are treated as "publishable
 *   siblings" worth gating on (so a dep on a non-published workspace lib is not
 *   flagged).
 * @returns {{
 *   required: Array<{ consumer: string, sibling: string, outputKey: string }>,
 *   failures: Array<{ consumer: string, sibling: string, outputKey: string, reason: string }>,
 * }}
 */
export function auditPublishYmlRequiredGates(publishYmlContent, pkgJsons) {
  const lines = publishYmlContent.split('\n')
  const publishableNames = new Set(pkgJsons.map((p) => p.name))

  // Locate each `publish-<short>:` job header line index (top-level job key,
  // i.e. indented exactly 2 spaces under `jobs:`). The job body runs until the
  // next line indented ≤ 2 spaces that is itself a key (another job) — we only
  // need the header index and the next-job index to bound the body window.
  const jobHeaderRegex = /^ {2}([a-z][a-z0-9-]*):\s*$/
  const jobStarts = []
  lines.forEach((line, idx) => {
    const m = line.match(jobHeaderRegex)
    if (m) jobStarts.push({ name: m[1], idx })
  })

  /** Slice the YAML body of job `jobName`, or null if absent. */
  const jobBody = (jobName) => {
    const pos = jobStarts.findIndex((j) => j.name === jobName)
    if (pos === -1) return null
    const start = jobStarts[pos].idx
    const end = pos + 1 < jobStarts.length ? jobStarts[pos + 1].idx : lines.length
    return lines.slice(start, end).join('\n')
  }

  const required = []
  const failures = []

  for (const { name, json } of pkgJsons) {
    const consumerShort = shortNameFromPackage(name)
    const consumerJob = `publish-${consumerShort}`
    const deps = { ...(json && json.dependencies) }

    for (const depName of Object.keys(deps)) {
      if (!publishableNames.has(depName)) continue
      if (depName === name) continue
      const siblingShort = shortNameFromPackage(depName)
      const outputKey = PUBLISH_JOB_TO_OUTPUT_ALIAS[siblingShort] || siblingShort
      required.push({ consumer: consumerShort, sibling: siblingShort, outputKey })

      const body = jobBody(consumerJob)
      if (body == null) {
        failures.push({
          consumer: consumerShort,
          sibling: siblingShort,
          outputKey,
          reason: `publish job '${consumerJob}' not found in publish.yml`,
        })
        continue
      }

      // (a) `needs:` must list the sibling publish job.
      const needsRegex = new RegExp(`needs:[^\\n]*\\bpublish-${siblingShort}\\b`)
      // A list-form `needs:` may span lines; also accept the job appearing on
      // its own bullet/array entry anywhere in the body alongside a `needs:`.
      const hasNeeds =
        needsRegex.test(body) ||
        (/\bneeds:/.test(body) && new RegExp(`\\bpublish-${siblingShort}\\b`).test(body))
      if (!hasNeeds) {
        failures.push({
          consumer: consumerShort,
          sibling: siblingShort,
          outputKey,
          reason: `'${consumerJob}' must list 'publish-${siblingShort}' in its needs:`,
        })
      }

      // (b) the SMI-5060 paired predicate must be present in the job body.
      const successClause = new RegExp(
        `needs\\.publish-${siblingShort}\\.result\\s*==\\s*'success'`
      )
      const skippedPairClause = new RegExp(
        `needs\\.publish-${siblingShort}\\.result\\s*==\\s*'skipped'\\s*&&\\s*` +
          `needs\\.pre-publish-check\\.outputs\\.${outputKey}-exists\\s*==\\s*'true'`
      )
      if (!successClause.test(body) || !skippedPairClause.test(body)) {
        failures.push({
          consumer: consumerShort,
          sibling: siblingShort,
          outputKey,
          reason:
            `'${consumerJob}' if: must gate on publish-${siblingShort}: ` +
            `(needs.publish-${siblingShort}.result == 'success' || ` +
            `(needs.publish-${siblingShort}.result == 'skipped' && ` +
            `needs.pre-publish-check.outputs.${outputKey}-exists == 'true'))`,
        })
      }
    }
  }

  return { required, failures }
}
