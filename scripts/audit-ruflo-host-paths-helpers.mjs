#!/usr/bin/env node
/**
 * Helper for audit-standards.mjs Checks 74 and 75 (SMI-6744 Wave 4 / A4.6)
 * and their executable twin, scripts/tests/audit-ruflo-host-paths.test.ts.
 *
 * Design: docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md
 * § 1(b) Layer R (the 43-entry Bash deny set), § 6 rows 9, 13, 14.
 *
 * Check 74 is the tripwire for two of Wave 4's five closure layers:
 *   (a) Layer R -- every one of the 43 Bash deny entries the design's
 *       adversarial command census requires is present in
 *       `.claude/settings.json`'s `permissions.deny` (exact and ` *` forms
 *       only -- no `:*` duplicates; fact 1 of the permission-rule semantics
 *       record documents `:*` as equivalent to ` *`, so shipping both would
 *       be redundant, not additive).
 *   (b) Layer X -- `ruflo` is gone from the host `node_modules` tree
 *       (Checkpoint 4 row 5's devDependency removal). This is a *tree*
 *       predicate, not the lockfile-graph reachability computation the
 *       design's § 1(b) Layer X section performs -- the design is explicit
 *       that the lockfile claim and the tree predicate are different checks.
 *
 * Check 75 is the tripwire for the MCP half of the census (§ 6 row 13):
 * `mcp__ruflo__terminal_execute` / `agent_execute` / `wasm_agent_tool` (an
 * arbitrary shell/agent/wasm surface inside the restricted service
 * container -- store-bounded and ptrace-bounded but not the MCP response's
 * own tool-deny boundary) plus decision 2.5's `github_*` / `browser_*`
 * families (network_mode: none breaks both regardless, but a stray
 * `permissions.allow` entry would otherwise reach them).
 *
 * Both checks assert PRESENCE of a fixed literal set in `permissions.deny`,
 * not absence of an allow -- deny beats allow at any scope (permission-rule
 * semantics record, fact 2), so asserting the allow's absence would be
 * asserting something the closure does not actually depend on.
 *
 * Neither check can see host-global or user-scope state: `audit:standards`
 * runs in CI and in a dev container, neither of which has a `~/.nvm` prefix
 * or the owner's own `~/.claude/settings.json`. Asserting the global
 * `npm uninstall -g ruflo` (Layer G) or the user-scope allow's removal here
 * would be a wrong-subject check -- vacuously green in the very
 * environments that run it (CLAUDE.md § "Measure, don't reason"; design
 * doc § 6 row 14). That gap is intentional and is A4.7's owner-transcript
 * job, not this check's.
 */

import { readFileSync, existsSync as defaultExistsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The 43-entry Bash deny set (design doc § 1(b) Layer R, queen-corrected
 * 2026-09-27: every entry is either an exact argument-less form or a
 * `*`-terminated prefix a real census spelling begins with -- no bare
 * un-terminated path fragments, and every package-runner form carries both
 * its exact and its ` *` twin).
 */
export const RUFLO_BASH_DENY_ENTRIES = Object.freeze([
  'Bash(npx ruflo)',
  'Bash(npx ruflo *)',
  'Bash(npx ruflo@*)',
  'Bash(npx -y ruflo)',
  'Bash(npx -y ruflo *)',
  'Bash(npx -y ruflo@*)',
  'Bash(npx --yes ruflo)',
  'Bash(npx --yes ruflo *)',
  'Bash(npx --yes ruflo@*)',
  'Bash(npx claude-flow)',
  'Bash(npx claude-flow *)',
  'Bash(npx claude-flow@*)',
  'Bash(npx @claude-flow/cli)',
  'Bash(npx @claude-flow/cli *)',
  'Bash(npx @claude-flow/cli@*)',
  'Bash(npm exec ruflo)',
  'Bash(npm exec ruflo *)',
  'Bash(npm exec -- ruflo)',
  'Bash(npm exec -- ruflo *)',
  'Bash(npm x ruflo)',
  'Bash(npm x ruflo *)',
  'Bash(npm x -- ruflo)',
  'Bash(npm x -- ruflo *)',
  'Bash(pnpm dlx ruflo)',
  'Bash(pnpm dlx ruflo *)',
  'Bash(yarn dlx ruflo)',
  'Bash(yarn dlx ruflo *)',
  'Bash(bunx ruflo)',
  'Bash(bunx ruflo *)',
  'Bash(node node_modules/ruflo/*)',
  'Bash(node ./node_modules/ruflo/*)',
  'Bash(node node_modules/@claude-flow/cli/*)',
  'Bash(node ./node_modules/@claude-flow/cli/*)',
  'Bash(node node_modules/.bin/ruflo)',
  'Bash(node node_modules/.bin/ruflo *)',
  'Bash(node node_modules/.bin/claude-flow)',
  'Bash(node node_modules/.bin/claude-flow *)',
  'Bash(node_modules/.bin/ruflo)',
  'Bash(node_modules/.bin/ruflo *)',
  'Bash(./node_modules/.bin/ruflo)',
  'Bash(./node_modules/.bin/ruflo *)',
  'Bash(ruflo)',
  'Bash(ruflo *)',
])

/**
 * The 37-entry MCP deny set (design doc § 6 rows 13 and decision 2.5): the
 * three in-container command surfaces (`terminal_execute`, `agent_execute`,
 * `wasm_agent_tool`), five `github_*` tools, and 29 `browser_*` tools --
 * measured live against the served `@claude-flow/cli@3.42.4` build (390
 * tool names is the denominator).
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

/** Both checks' out-of-reach note (Check 74 only -- design doc § 6 row 14). */
const OUT_OF_REACH_NOTE =
  'The nvm global prefix and the user-scope ~/.claude/settings.json are out of this ' +
  "check's reach (they belong to A4.7's owner transcript, not audit:standards -- " +
  "CI and the dev container have neither a `~/.nvm` prefix nor the owner's own " +
  'user-scope settings file, so asserting either here would be vacuously green).'

function readDenyArray(settingsPath, readFile) {
  const parsed = JSON.parse(readFile(settingsPath))
  const deny = parsed && parsed.permissions && Array.isArray(parsed.permissions.deny)
  return deny ? parsed.permissions.deny : []
}

/**
 * Check 74: evaluate (a) presence of every RUFLO_BASH_DENY_ENTRIES literal
 * in settingsPath's `permissions.deny`, and (b) absence of `<root>/
 * node_modules/ruflo` on the host tree.
 *
 * @param {{
 *   settingsPath: string,
 *   root: string,
 *   readFile?: (path: string) => string,
 *   existsSync?: (path: string) => boolean,
 *   entries?: readonly string[],
 * }} options
 * @returns {object} a verdict for rufloHostPathsReportLines()
 */
export function evaluateRufloHostPaths(options) {
  const {
    settingsPath,
    root,
    readFile = (p) => readFileSync(p, 'utf8'),
    existsSync = defaultExistsSync,
    entries = RUFLO_BASH_DENY_ENTRIES,
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
  const missingBashEntries = entries.filter((e) => !denySet.has(e))

  const treePath = join(root, 'node_modules', 'ruflo')
  const treePresent = existsSync(treePath)

  return {
    status: 'evaluated',
    settingsPath,
    denyCount: denyArray.length,
    requiredCount: entries.length,
    missingBashEntries,
    treePath,
    treePresent,
  }
}

const FIX_NOT_EVALUATED = (path) =>
  `Could not read/parse ${path} as JSON, so Check 74 could not evaluate. Confirm the file exists and is valid JSON.`

const FIX_MISSING_BASH_ENTRY =
  "Add the missing entry to `.claude/settings.json`'s `permissions.deny` array verbatim " +
  '(SMI-6744 Wave 4, design doc § 1(b) Layer R). Do not add a `:*` duplicate -- `:*` and ` *` ' +
  'are documented equivalent, so both forms would be redundant, not additive.'

const FIX_TREE_PRESENT =
  'Remove the root `ruflo` devDependency (SMI-6744 Checkpoint 4 row 5) and run the SMI-6614 ' +
  'refresh sequence from the main checkout. This is a host-state, deps-tier change requiring ' +
  'owner consent -- it is not made by this check.'

/**
 * @param {ReturnType<typeof evaluateRufloHostPaths>} verdict
 * @returns {Array<{severity: 'pass' | 'warn' | 'fail', message: string, fix?: string}>}
 */
export function rufloHostPathsReportLines(verdict) {
  if (verdict.status === 'not_evaluated') {
    return [
      {
        severity: 'fail',
        message: `Check 74 NOT-EVALUATED — ${verdict.reason}`,
        fix: FIX_NOT_EVALUATED(verdict.settingsPath),
      },
    ]
  }

  const lines = []
  const denomA = `${verdict.requiredCount} required, ${verdict.denyCount} present in permissions.deny`

  for (const entry of verdict.missingBashEntries) {
    lines.push({
      severity: 'fail',
      message:
        `Check 74 FINDING: ${verdict.settingsPath} permissions.deny is missing "${entry}" ` +
        `(${denomA}). ${OUT_OF_REACH_NOTE}`,
      fix: FIX_MISSING_BASH_ENTRY,
    })
  }
  if (verdict.missingBashEntries.length === 0) {
    lines.push({
      severity: 'pass',
      message:
        `Check 74: all ${verdict.requiredCount} SMI-6744 Wave 4 Bash deny entries are present ` +
        `in ${verdict.settingsPath} permissions.deny (${denomA}). ${OUT_OF_REACH_NOTE}`,
    })
  }

  if (verdict.treePresent) {
    lines.push({
      severity: 'fail',
      message:
        `Check 74 FINDING: ${verdict.treePath} is present — the SMI-6744 Wave 4 host-tree ` +
        `removal (Checkpoint 4 row 5) has not landed on this host. ${OUT_OF_REACH_NOTE}`,
      fix: FIX_TREE_PRESENT,
    })
  } else {
    lines.push({
      severity: 'pass',
      message: `Check 74: ${verdict.treePath} is absent. ${OUT_OF_REACH_NOTE}`,
    })
  }

  return lines
}

/** Check 74's hook-entry tripwire out-of-reach note (SMI-6744 A4.6). */
const HOOK_DETECTION_NOT_PREVENTION_NOTE =
  'Detection, never prevention (design doc § 8 item 13): a session with Edit access can still ' +
  'remove this hook entry -- this check only means the removal is caught, not that it is blocked.'

/**
 * Does one hooks.PreToolUse entry match the given matcher and carry a
 * command-type hook whose `command` string contains both substrings? Type
 * + exact invocation-shape check, not a bare whole-file substring match --
 * same structural pattern as `env-read-guard.test.ts`'s own registration
 * pin -- so a hook silently replaced by a functionally inert command that
 * merely retains the text (e.g. in a comment) still fails this.
 */
function hasHookEntry(preToolUse, matcher, mustIncludeAll) {
  return preToolUse.some(
    (entry) =>
      entry?.matcher === matcher &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(
        (hook) =>
          hook?.type === 'command' &&
          typeof hook.command === 'string' &&
          mustIncludeAll.every((s) => hook.command.includes(s))
      )
  )
}

/**
 * Check 74's hook-entry tripwire (SMI-6744 A4.6, plan
 * docs/internal/implementation/smi-6744-ruflo-host-guard.md § "What
 * Changes" item 4): asserts `scripts/ruflo-host-guard.mjs` is registered
 * on BOTH its `PreToolUse` matchers -- the `Bash` matcher (alongside
 * `env-read-guard.mjs`) and the `^mcp__ruflo__hooks_session-start$`
 * matcher. Purely additive to Check 74's existing deny-array + host-tree
 * assertions above; this is detection of a silent removal, never
 * prevention of one.
 * @param {{settingsPath: string, readFile?: (path: string) => string}} options
 */
export function evaluateRufloHostGuardHooks(options) {
  const { settingsPath, readFile = (p) => readFileSync(p, 'utf8') } = options

  let parsed
  try {
    parsed = JSON.parse(readFile(settingsPath))
  } catch (err) {
    return {
      status: 'not_evaluated',
      settingsPath,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  const preToolUse = Array.isArray(parsed?.hooks?.PreToolUse) ? parsed.hooks.PreToolUse : []
  const mustInclude = ['node', 'scripts/ruflo-host-guard.mjs']

  return {
    status: 'evaluated',
    settingsPath,
    hasBashEntry: hasHookEntry(preToolUse, 'Bash', mustInclude),
    hasSessionStartEntry: hasHookEntry(
      preToolUse,
      '^mcp__ruflo__hooks_session-start$',
      mustInclude
    ),
  }
}

const FIX_MISSING_HOOK_ENTRY = (matcher) =>
  `Add a { "type": "command", "timeout": 5, "command": "node \\"$CLAUDE_PROJECT_DIR/scripts/ruflo-host-guard.mjs\\"" } ` +
  `hook to the "${matcher}" entry in .claude/settings.json's hooks.PreToolUse array (SMI-6744 Wave 4, ` +
  'design doc § "What Changes" item 3).'

/**
 * @param {ReturnType<typeof evaluateRufloHostGuardHooks>} verdict
 * @returns {Array<{severity: 'pass' | 'warn' | 'fail', message: string, fix?: string}>}
 */
export function rufloHostGuardHooksReportLines(verdict) {
  if (verdict.status === 'not_evaluated') {
    return [
      {
        severity: 'fail',
        message: `Check 74 NOT-EVALUATED (hook-entry tripwire) — ${verdict.reason}`,
        fix: FIX_NOT_EVALUATED(verdict.settingsPath),
      },
    ]
  }

  const lines = []
  if (!verdict.hasBashEntry) {
    lines.push({
      severity: 'fail',
      message:
        `Check 74 FINDING: ${verdict.settingsPath} hooks.PreToolUse is missing the "Bash" ` +
        `matcher entry invoking scripts/ruflo-host-guard.mjs. ${HOOK_DETECTION_NOT_PREVENTION_NOTE}`,
      fix: FIX_MISSING_HOOK_ENTRY('Bash'),
    })
  }
  if (!verdict.hasSessionStartEntry) {
    lines.push({
      severity: 'fail',
      message:
        `Check 74 FINDING: ${verdict.settingsPath} hooks.PreToolUse is missing the ` +
        '"^mcp__ruflo__hooks_session-start$" matcher entry invoking scripts/ruflo-host-guard.mjs. ' +
        HOOK_DETECTION_NOT_PREVENTION_NOTE,
      fix: FIX_MISSING_HOOK_ENTRY('^mcp__ruflo__hooks_session-start$'),
    })
  }
  if (lines.length === 0) {
    lines.push({
      severity: 'pass',
      message:
        `Check 74: both scripts/ruflo-host-guard.mjs PreToolUse hook entries (matchers "Bash" ` +
        `and "^mcp__ruflo__hooks_session-start$") are present in ${verdict.settingsPath}. ` +
        HOOK_DETECTION_NOT_PREVENTION_NOTE,
    })
  }
  return lines
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
