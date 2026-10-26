#!/usr/bin/env node
/**
 * Helper for audit-standards.mjs Check 79 (SMI-6744 A5.3) and its executable
 * twin, scripts/tests/audit-ruflo-classification.test.ts.
 *
 * Plan: docs/internal/implementation/smi-6744-a53-hooks-intelligence-denies.md
 * (D1 pinned list, D2 table rules A-F). Doc under check:
 * docs/internal/architecture/ruflo-tool-classification.md.
 *
 * Check 79 keeps three surfaces in lockstep: `.claude/settings.json`'s
 * `mcp__ruflo__*` denies (the enforcement surface), the pinned list below, and
 * the classification doc (its one `json` paste block and its full table).
 *
 * The "core" set is every `mcp__ruflo__*` deny that is NOT in Check 75's
 * Wave 4 list (RUFLO_MCP_DENY_ENTRIES, imported, so it stays the one source).
 *
 * Two halves:
 *   - array half: runs everywhere, CI included. Core set == pinned list, in
 *     order; the pinned list and Check 75's list share no name; every input is
 *     parsed fail-closed.
 *   - doc half: runs only where docs/internal exists (CI's quality-checks job
 *     checks out without submodules). Exactly one `json` fence equal to the
 *     pinned list, plus table rules A-F and F2 over `## Full classification table`.
 *     When the doc is absent the half is reported "not checked", never passed.
 *
 * Residual gap (D1): a doc-only edit is caught only when someone next runs
 * audit:standards with the submodule present. Parenthetical text inside Blocked
 * cells is stripped before rule D; rule C reads the whole Allowed cell (parentheticals
 * included), so Allowed prose without backticks is invisible to it. Continuation
 * rows (empty first cell) are not parsed by any rule. Known false positive
 * (SMI-7182): rule C's bare-wildcard form (a short prefix with `*` in an Allowed
 * cell) can over-match denied tools of other families and flag a correct doc.
 */

import { readFileSync, existsSync } from 'node:fs'
import { RUFLO_MCP_DENY_ENTRIES } from './audit-ruflo-mcp-denies-helpers.mjs'

const RUFLO_PREFIX = 'mcp__ruflo__'
const TABLE_HEADING = '## Full classification table'
const BARE_TOKEN = '[a-z0-9_*-]+'
const BLOCKED_LIST_RE = new RegExp('^`' + BARE_TOKEN + '`(?:\\s*,\\s*`' + BARE_TOKEN + '`)*$')
const TOKEN_RE = new RegExp('`(' + BARE_TOKEN + ')`', 'g')
const TABLE_ROW_RE = /^\|\s*`([a-z0-9_-]+_)\*`\s*\|/
const TABLE_HEADER_RE = /^\|\s*Prefix\s*\|/
const TABLE_SEPARATOR_RE = /^\|[\s:|-]*-[\s:|-]*$/
const TABLE_CONTINUATION_RE = /^\|\s*\|/

/**
 * The pinned core deny list (SMI-6744 A5.3): the `mcp__ruflo__*` entries of
 * `.claude/settings.json`'s `permissions.deny` that are not Check 75's Wave 4
 * set, in live order. A deliberate change edits this list, the array and the
 * doc's paste block together.
 */
export const RUFLO_CORE_DENY_ENTRIES = Object.freeze([
  'mcp__ruflo__agentdb_pattern-store',
  'mcp__ruflo__agentdb_pattern-search',
  'mcp__ruflo__agentdb_hierarchical-store',
  'mcp__ruflo__agentdb_hierarchical-recall',
  'mcp__ruflo__agentdb_causal-edge',
  'mcp__ruflo__agentdb_batch',
  'mcp__ruflo__agentdb_context-synthesize',
  'mcp__ruflo__agentdb_semantic-route',
  'mcp__ruflo__agentdb_feedback',
  'mcp__ruflo__agentdb_consolidate',
  'mcp__ruflo__agentdb_causal-edge-delete',
  'mcp__ruflo__agentdb_causal-node-delete',
  'mcp__ruflo__agentdb_graph-pathfinder',
  'mcp__ruflo__agentdb_graph-query',
  'mcp__ruflo__agentdb_hierarchical-delete',
  'mcp__ruflo__hive-mind_memory',
  'mcp__ruflo__hive-mind_broadcast',
  'mcp__ruflo__hive-mind_consensus',
  'mcp__ruflo__hive-mind_spawn',
  'mcp__ruflo__hive-mind_join',
  'mcp__ruflo__hive-mind_init',
  'mcp__ruflo__hive-mind_leave',
  'mcp__ruflo__hive-mind_optimize-memory',
  'mcp__ruflo__hive-mind_shutdown',
  'mcp__ruflo__hooks_intelligence_pattern-store',
  'mcp__ruflo__hooks_intelligence_pattern-search',
  'mcp__ruflo__hooks_intelligence',
  'mcp__ruflo__hooks_intelligence-reset',
  'mcp__ruflo__hooks_intelligence_learn',
  'mcp__ruflo__hooks_intelligence_trajectory-start',
  'mcp__ruflo__hooks_intelligence_trajectory-step',
  'mcp__ruflo__hooks_intelligence_trajectory-end',
  'mcp__ruflo__hooks_intelligence_attention',
  'mcp__ruflo__memory_import',
  'mcp__ruflo__memory_import_claude',
  'mcp__ruflo__memory_migrate',
  'mcp__ruflo__memory_search',
  'mcp__ruflo__memory_search_unified',
  'mcp__ruflo__memory_store',
  'mcp__ruflo__memory_list',
  'mcp__ruflo__embeddings_search',
  'mcp__ruflo__managed_agent_create',
  'mcp__ruflo__managed_agent_events',
  'mcp__ruflo__managed_agent_list',
  'mcp__ruflo__managed_agent_prompt',
  'mcp__ruflo__managed_agent_status',
  'mcp__ruflo__managed_agent_terminate',
  'mcp__ruflo__metaharness_drift_from_history',
  'mcp__ruflo__metaharness_oia_audit',
  'mcp__ruflo__claims_handoff',
  'mcp__ruflo__claims_accept-handoff',
  'mcp__ruflo__hooks_post-task',
  'mcp__ruflo__hooks_model-outcome',
  'mcp__ruflo__hooks_model-route',
])

function parseJson(text, label, findings) {
  try {
    return JSON.parse(text)
  } catch (err) {
    findings.push(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/** Fail-closed extraction of `permissions.deny`; pushes findings and returns null on any defect. */
function extractDeny(parsed, label, findings) {
  const deny = parsed && parsed.permissions && parsed.permissions.deny
  if (!Array.isArray(deny)) {
    findings.push(`${label}: permissions.deny is missing or not an array`)
    return null
  }
  const bad = deny.findIndex((e) => typeof e !== 'string')
  if (bad !== -1) {
    findings.push(`${label}: permissions.deny[${bad}] is not a string`)
    return null
  }
  return deny
}

/** Ordered comparison of `actual` against `pinned`; names every divergence by exact string. */
function compareToPinned(actual, pinned, label, findings) {
  const pinnedSet = new Set(pinned)
  const actualSet = new Set(actual)
  for (const name of actual) {
    if (!pinnedSet.has(name)) findings.push(`${label}-only: "${name}" is not in the pinned list`)
  }
  for (const name of pinned) {
    if (!actualSet.has(name)) findings.push(`pin-only: "${name}" is missing from ${label}`)
  }
  if (actualSet.size !== actual.length) findings.push(`${label} contains a duplicate entry`)
  const same = actual.length === pinned.length && actual.every((n) => pinnedSet.has(n))
  if (same && actualSet.size === actual.length) {
    const i = actual.findIndex((n, k) => n !== pinned[k])
    if (i !== -1) {
      findings.push(
        `${label} order differs from the pinned list at index ${i}: "${actual[i]}" vs "${pinned[i]}"`
      )
    }
  }
}

/** Extract the contents of every ```json fence; returns [{text, closed}]. */
function jsonFences(doc) {
  const fences = []
  let cur = null
  for (const line of doc.split('\n')) {
    if (cur === null) {
      if (/^```json\s*$/.test(line)) cur = []
    } else if (/^```\s*$/.test(line)) {
      fences.push({ text: cur.join('\n'), closed: true })
      cur = null
    } else {
      cur.push(line)
    }
  }
  if (cur !== null) fences.push({ text: cur.join('\n'), closed: false })
  return fences
}

function stripParens(cell) {
  let prev
  let out = cell
  do {
    prev = out
    out = out.replace(/\([^()]*\)/g, '')
  } while (out !== prev)
  return out.trim()
}

function tokensOf(cell) {
  return [...cell.matchAll(TOKEN_RE)].map((m) => m[1])
}

function sectionOf(doc, findings) {
  const lines = doc.split('\n')
  const starts = lines.flatMap((l, i) => (l.trim() === TABLE_HEADING ? [i] : []))
  if (starts.length !== 1) {
    findings.push(`rule F: expected exactly one "${TABLE_HEADING}" heading, found ${starts.length}`)
    return null
  }
  let end = lines.length
  for (let i = starts[0] + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }
  return { lines, start: starts[0], end }
}

function parseRows(section, findings) {
  const rows = []
  let headerSeen = false
  for (let i = section.start + 1; i < section.end; i++) {
    const m = TABLE_ROW_RE.exec(section.lines[i])
    if (!m) {
      const t = section.lines[i].trim()
      // The header is accepted once, as the section's first `|` line; any later
      // header-shaped line could carry names nothing reads, so it is F2.
      const isHeader = !headerSeen && TABLE_HEADER_RE.test(t)
      if (t.startsWith('|')) headerSeen = true
      if (
        t.startsWith('|') &&
        !isHeader &&
        !TABLE_SEPARATOR_RE.test(t) &&
        !TABLE_CONTINUATION_RE.test(t)
      ) {
        findings.push(`rule F2: unparsed table row: ${t.slice(0, 60)}`)
      } else if (t !== '' && !t.startsWith('|') && t.includes('|')) {
        // GFM renders a row without a leading pipe; it must not escape the rules.
        findings.push(`rule F2: table row without a leading pipe: ${t.slice(0, 60)}`)
      }
      continue
    }
    headerSeen = true
    const cells = section.lines[i]
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
    if (cells.length !== 3) {
      findings.push(`table row "${m[1]}*" has ${cells.length} cells, expected 3`)
      continue
    }
    rows.push({ prefix: m[1], allowed: cells[1].trim(), blocked: cells[2].trim() })
  }
  return rows
}

function longestRow(rows, name) {
  let best = null
  for (const r of rows) {
    if (name.startsWith(r.prefix) && (best === null || r.prefix.length > best.prefix.length)) {
      best = r
    }
  }
  return best
}

function blockedGrammar(row, findings) {
  const stripped = stripParens(row.blocked)
  if (stripped !== 'none' && !BLOCKED_LIST_RE.test(stripped)) {
    findings.push(
      `rule D: ${row.prefix}* Blocked cell must be "none" or a comma-separated list of ` +
        `backticked names, got "${row.blocked}"`
    )
    return []
  }
  return stripped === 'none' ? [] : tokensOf(stripped)
}

/** Table rules A-F over the doc against the full set of ruflo denies (core + Wave 4). */
function checkTable(doc, rufloDenies, findings) {
  const section = sectionOf(doc, findings)
  if (section === null) return { rows: 0 }
  // Rule F: a table-shaped row outside the section.
  section.lines.forEach((line, i) => {
    if ((i <= section.start || i >= section.end) && TABLE_ROW_RE.test(line)) {
      findings.push(`rule F: stray table row outside the full table: ${line.slice(0, 60)}`)
    }
  })
  const rows = parseRows(section, findings)
  const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.prefix))
      findings.push(`rule E: prefix ${r.prefix}* appears in more than one row`)
    seen.add(r.prefix)
  }
  const names = rufloDenies.map((d) => d.slice(RUFLO_PREFIX.length))
  const deniedByRow = new Map()
  for (const name of names) {
    const row = longestRow(rows, name)
    if (row === null) {
      findings.push(`rule A: denied tool "${name}" maps to no table row`)
      continue
    }
    const suffix = name.slice(row.prefix.length)
    if (!deniedByRow.has(row)) deniedByRow.set(row, new Set())
    deniedByRow.get(row).add(suffix)
  }
  const nameSet = new Set(names)
  for (const row of rows) {
    const blocked = blockedGrammar(row, findings)
    const denied = deniedByRow.get(row) ?? new Set()
    for (const suffix of denied) {
      if (!blocked.includes(suffix)) {
        findings.push(
          `rule A: denied "${row.prefix}${suffix}" is not in the ${row.prefix}* Blocked cell`
        )
      }
    }
    for (const t of blocked) {
      if (t.includes('*')) {
        findings.push(`rule B: wildcard "${t}" in the ${row.prefix}* Blocked cell`)
      } else if (!nameSet.has(row.prefix + t)) {
        findings.push(`rule B: "${row.prefix}${t}" is in a Blocked cell but is not denied`)
      }
    }
    if (denied.size > 0 && /^all\b/i.test(row.allowed)) {
      findings.push(`rule C: ${row.prefix}* has denials but its Allowed cell starts with "all"`)
    }
    for (const t of tokensOf(row.allowed)) {
      // A token may be a suffix of this row's prefix, or a full tool name, with
      // or without the mcp__ruflo__ prefix; each form is checked.
      const forms = [row.prefix + t, t.startsWith(RUFLO_PREFIX) ? t.slice(RUFLO_PREFIX.length) : t]
      const hit = names.find((n) =>
        forms.some((f) => (f.endsWith('*') ? n.startsWith(f.slice(0, -1)) : n === f))
      )
      if (hit !== undefined) {
        findings.push(`rule C: denied "${hit}" appears in the Allowed cell as "${t}"`)
      }
    }
  }
  return { rows: rows.length }
}

function checkDocHalf(docPath, readFile, pinned, rufloDenies, findings) {
  let doc
  try {
    doc = readFile(docPath)
  } catch (err) {
    findings.push(
      `doc ${docPath} exists but is unreadable: ${err instanceof Error ? err.message : err}`
    )
    return { docCount: null, rows: 0 }
  }
  const fences = jsonFences(doc)
  let docCount = null
  if (fences.length !== 1 || !fences[0].closed) {
    findings.push(`doc must hold exactly one closed json fence, found ${fences.length}`)
  } else {
    const parsed = parseJson(fences[0].text, 'the doc paste block', findings)
    const deny = parsed === undefined ? null : extractDeny(parsed, 'the doc paste block', findings)
    if (deny !== null) {
      docCount = deny.length
      compareToPinned(deny, pinned, 'doc', findings)
    }
  }
  if (rufloDenies === null) {
    findings.push('table rules A-F not evaluated: settings.json deny array unusable')
    return { docCount, rows: 0 }
  }
  return { docCount, rows: checkTable(doc, rufloDenies, findings).rows }
}

/**
 * Check 79: evaluate the array half (always) and the doc half (when the doc exists).
 *
 * @param {{settingsPath: string, docPath: string, readFile?: (p: string) => string,
 *   exists?: (p: string) => boolean, coreEntries?: readonly string[], mcpEntries?: readonly string[]}} options
 * @returns {{findings: string[], coreCount: number|null, pinnedCount: number,
 *   docChecked: boolean, docCount: number|null, rows: number, denyCount: number|null}}
 */
export function evaluateRufloClassification(options) {
  const {
    settingsPath,
    docPath,
    readFile = (p) => readFileSync(p, 'utf8'),
    exists = (p) => existsSync(p),
    coreEntries: pinned = RUFLO_CORE_DENY_ENTRIES,
    mcpEntries = RUFLO_MCP_DENY_ENTRIES,
  } = options
  const findings = []

  for (const name of pinned) {
    if (mcpEntries.includes(name)) {
      findings.push(`ownership: "${name}" is in both the pinned core list and Check 75's list`)
    }
  }

  let coreCount = null
  let rufloDenies = null
  let text
  try {
    text = readFile(settingsPath)
  } catch (err) {
    findings.push(`${settingsPath} is unreadable: ${err instanceof Error ? err.message : err}`)
  }
  const parsed = text === undefined ? undefined : parseJson(text, settingsPath, findings)
  const deny = parsed === undefined ? null : extractDeny(parsed, settingsPath, findings)
  if (deny !== null) {
    rufloDenies = deny.filter((e) => e.startsWith(RUFLO_PREFIX))
    // Uniqueness over the whole ruflo set, before partitioning: Check 75 reads the
    // array as a set, so a duplicated Wave 4 entry would otherwise pass both checks.
    // A duplicated core entry is also reported by compareToPinned; two findings, one cause.
    const seenDeny = new Set()
    for (const e of rufloDenies) {
      if (seenDeny.has(e)) findings.push(`duplicate deny entry "${e}" in ${settingsPath}`)
      seenDeny.add(e)
    }
    const core = rufloDenies.filter((e) => !mcpEntries.includes(e))
    coreCount = core.length
    compareToPinned(core, pinned, 'array', findings)
  }

  const docChecked = exists(docPath)
  let docCount = null
  let rows = 0
  if (docChecked) {
    ;({ docCount, rows } = checkDocHalf(docPath, readFile, pinned, rufloDenies, findings))
  }
  return {
    findings,
    coreCount,
    pinnedCount: pinned.length,
    docChecked,
    docCount,
    rows,
    denyCount: rufloDenies === null ? null : rufloDenies.length,
  }
}

const FIX_79 =
  "Keep `.claude/settings.json`'s mcp__ruflo__ denies, RUFLO_CORE_DENY_ENTRIES " +
  "(scripts/audit-ruflo-classification-helpers.mjs) and the doc's paste block and full table " +
  '(docs/internal/architecture/ruflo-tool-classification.md) in lockstep, in the same order. ' +
  'A deliberate change edits all three together.'

/**
 * @param {ReturnType<typeof evaluateRufloClassification>} result
 * @returns {Array<{severity: 'pass' | 'info' | 'fail', message: string, fix?: string}>}
 */
export function rufloClassificationReportLines(result) {
  const denom =
    `core=${result.coreCount ?? 'unreadable'} pinned=${result.pinnedCount} ` +
    `doc=${result.docChecked ? (result.docCount ?? 'unreadable') : 'not checked'}`
  const lines = result.findings.map((f) => ({
    severity: 'fail',
    message: `Check 79 FINDING: ${f} (${denom})`,
    fix: FIX_79,
  }))
  if (result.findings.length === 0) {
    lines.push({
      severity: 'pass',
      // Without the doc this pass covers the array half only, and says so in the line
      // the audit counts, not just in the info line after it.
      message: result.docChecked
        ? `Check 79: ruflo deny array matches the pinned core list (${denom}); ` +
          `doc block and ${result.rows} table rows agree`
        : `Check 79 (array half only): ruflo deny array matches the pinned core list ` +
          `(${denom}); the doc half was NOT checked`,
    })
  }
  if (!result.docChecked) {
    lines.push({ severity: 'info', message: 'doc half: not checked (docs/internal absent)' })
  }
  return lines
}
