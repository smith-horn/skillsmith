#!/usr/bin/env node
/**
 * Helper for audit-standards.mjs Check 75 (SMI-6744 Wave 4 / A4.6) and its
 * executable twin, scripts/tests/audit-ruflo-host-paths.test.ts.
 *
 * Split out of audit-ruflo-host-paths-helpers.mjs (SMI-6744 Wave 4 M-6
 * governance round) to keep that file under the 500-line policy
 * (scripts/file-length-policy.mjs) once its own Check 74 grew a second tree
 * assertion and a `.bin` symlink judge -- Check 75 is a fully independent
 * MCP-deny-entry check that never touches a filesystem tree, so it splits
 * cleanly.
 *
 * Design: docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md
 * § 6 rows 13 and decision 2.5.
 *
 * Check 75 is the tripwire for the MCP half of the census (§ 6 row 13):
 * `mcp__ruflo__terminal_execute` / `agent_execute` / `wasm_agent_tool` (an
 * arbitrary shell/agent/wasm surface inside the restricted service
 * container -- egress-bounded by the network namespace, but NOT
 * store-bounded and NOT ptrace-bounded: uid 0, a private PID namespace, and
 * no Yama mean the surface can read and write the whole shared store and can
 * ptrace the server itself, design § 2 / § 6 row 13) plus decision 2.5's
 * `github_*` / `browser_*` families (network_mode: none breaks both
 * regardless, but a stray `permissions.allow` entry would otherwise reach
 * them).
 *
 * Asserts PRESENCE of a fixed literal set in `permissions.deny`, not absence
 * of an allow -- deny beats allow at any scope (permission-rule semantics
 * record, fact 2), so asserting the allow's absence would be asserting
 * something the closure does not actually depend on.
 */

import { readFileSync } from 'node:fs'

/**
 * The 37-entry MCP deny set (design doc § 6 rows 13 and decision 2.5): the
 * three in-container command surfaces (`terminal_execute`, `agent_execute`,
 * `wasm_agent_tool`), five `github_*` tools, and 29 `browser_*` tools --
 * measured live against the served `@claude-flow/cli@3.42.4` build. See
 * SMI-6744 A4.4 § 10 for the measurement (the tool-count denominator is a
 * factual claim that rots as the served build changes -- CLAUDE.md's
 * "durable rules instruct, they don't describe" -- so it is cited here, not
 * restated).
 */
export const RUFLO_MCP_DENY_ENTRIES = Object.freeze([
  'mcp__ruflo__terminal_execute',
  'mcp__ruflo__agent_execute',
  'mcp__ruflo__wasm_agent_tool',
  'mcp__ruflo__github_issue_track',
  'mcp__ruflo__github_metrics',
  'mcp__ruflo__github_pr_manage',
  'mcp__ruflo__github_repo_analyze',
  'mcp__ruflo__github_workflow',
  'mcp__ruflo__browser_act',
  'mcp__ruflo__browser_back',
  'mcp__ruflo__browser_check',
  'mcp__ruflo__browser_click',
  'mcp__ruflo__browser_close',
  'mcp__ruflo__browser_cookie_use',
  'mcp__ruflo__browser_eval',
  'mcp__ruflo__browser_fill',
  'mcp__ruflo__browser_forward',
  'mcp__ruflo__browser_get-text',
  'mcp__ruflo__browser_get-title',
  'mcp__ruflo__browser_get-url',
  'mcp__ruflo__browser_get-value',
  'mcp__ruflo__browser_hover',
  'mcp__ruflo__browser_open',
  'mcp__ruflo__browser_press',
  'mcp__ruflo__browser_reload',
  'mcp__ruflo__browser_screenshot',
  'mcp__ruflo__browser_scroll',
  'mcp__ruflo__browser_select',
  'mcp__ruflo__browser_session-list',
  'mcp__ruflo__browser_session_end',
  'mcp__ruflo__browser_session_record',
  'mcp__ruflo__browser_session_replay',
  'mcp__ruflo__browser_snapshot',
  'mcp__ruflo__browser_template_apply',
  'mcp__ruflo__browser_type',
  'mcp__ruflo__browser_uncheck',
  'mcp__ruflo__browser_wait',
])

function readDenyArray(settingsPath, readFile) {
  const parsed = JSON.parse(readFile(settingsPath))
  const deny = parsed && parsed.permissions && Array.isArray(parsed.permissions.deny)
  return deny ? parsed.permissions.deny : []
}

/**
 * Check 75: evaluate presence of every RUFLO_MCP_DENY_ENTRIES literal in
 * settingsPath's `permissions.deny`.
 *
 * @param {{settingsPath: string, readFile?: (path: string) => string, entries?: readonly string[]}} options
 * @returns {object} a verdict for rufloMcpDeniesReportLines()
 */
export function evaluateRufloMcpDenies(options) {
  const {
    settingsPath,
    readFile = (p) => readFileSync(p, 'utf8'),
    entries = RUFLO_MCP_DENY_ENTRIES,
  } = options

  let denyArray
  try {
    denyArray = readDenyArray(settingsPath, readFile)
  } catch (err) {
    return {
      status: 'not_evaluated',
      settingsPath,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  const denySet = new Set(denyArray)
  const missingMcpEntries = entries.filter((e) => !denySet.has(e))

  return {
    status: 'evaluated',
    settingsPath,
    denyCount: denyArray.length,
    requiredCount: entries.length,
    missingMcpEntries,
  }
}

const FIX_NOT_EVALUATED_75 = (path) =>
  `Could not read/parse ${path} as JSON, so Check 75 could not evaluate. Confirm the file exists and is valid JSON.`

const FIX_MISSING_MCP_ENTRY =
  "Add the missing entry to `.claude/settings.json`'s `permissions.deny` array verbatim " +
  '(SMI-6744 Wave 4 decision 2.5 / Checkpoint 4 row 13). No parameter-level MCP deny exists -- ' +
  'the exact tool name is the only enforceable form.'

/**
 * @param {ReturnType<typeof evaluateRufloMcpDenies>} verdict
 * @returns {Array<{severity: 'pass' | 'warn' | 'fail', message: string, fix?: string}>}
 */
export function rufloMcpDeniesReportLines(verdict) {
  if (verdict.status === 'not_evaluated') {
    return [
      {
        severity: 'fail',
        message: `Check 75 NOT-EVALUATED — ${verdict.reason}`,
        fix: FIX_NOT_EVALUATED_75(verdict.settingsPath),
      },
    ]
  }

  const denom = `${verdict.requiredCount} required, ${verdict.denyCount} present in permissions.deny`

  if (verdict.missingMcpEntries.length === 0) {
    return [
      {
        severity: 'pass',
        message:
          `Check 75: all ${verdict.requiredCount} SMI-6744 Wave 4 MCP deny entries are present ` +
          `in ${verdict.settingsPath} permissions.deny (${denom})`,
      },
    ]
  }

  return verdict.missingMcpEntries.map((entry) => ({
    severity: 'fail',
    message: `Check 75 FINDING: ${verdict.settingsPath} permissions.deny is missing "${entry}" (${denom})`,
    fix: FIX_MISSING_MCP_ENTRY,
  }))
}
