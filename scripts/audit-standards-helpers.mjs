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
