#!/usr/bin/env node
/**
 * Helper for audit-standards.mjs Check 74 (SMI-6744 Wave 4 / A4.6) and its
 * executable twin, scripts/tests/audit-ruflo-host-paths.test.ts.
 *
 * Design: docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md
 * § 1(b) Layer R (the 50-entry Bash deny set), § 6 rows 9, 13, 14.
 *
 * Check 74 is the tripwire for two of Wave 4's five closure layers:
 *   (a) Layer R -- every one of the 50 Bash deny entries the design's
 *       adversarial command census requires is present in
 *       `.claude/settings.json`'s `permissions.deny` (exact, ` *` and `@*`
 *       forms only -- no `:*` duplicates; fact 1 of the permission-rule
 *       semantics record documents `:*` as equivalent to ` *`, so shipping
 *       both would be redundant, not additive).
 *   (b) Layer X -- `ruflo` is gone from the host `node_modules` tree
 *       (Checkpoint 4 row 5's devDependency removal). This is a *tree*
 *       predicate, not the lockfile-graph reachability computation the
 *       design's § 1(b) Layer X section performs -- the design is explicit
 *       that the lockfile claim and the tree predicate are different checks.
 *
 * Asserts PRESENCE of a fixed literal set in `permissions.deny`, not absence
 * of an allow -- deny beats allow at any scope (permission-rule semantics
 * record, fact 2), so asserting the allow's absence would be asserting
 * something the closure does not actually depend on.
 *
 * Cannot see host-global or user-scope state: `audit:standards` runs in CI
 * and in a dev container, neither of which has a `~/.nvm` prefix or the
 * owner's own `~/.claude/settings.json`. Asserting the global
 * `npm uninstall -g ruflo` (Layer G) or the user-scope allow's removal here
 * would be a wrong-subject check -- vacuously green in the very
 * environments that run it (CLAUDE.md § "Measure, don't reason"; design
 * doc § 6 row 14). That gap is intentional and is A4.7's owner-transcript
 * job, not this check's.
 *
 * Check 75 (MCP deny entries) and Check 74's hook-entry tripwire split into
 * their own files, audit-ruflo-mcp-denies-helpers.mjs and
 * audit-ruflo-host-guard-hooks-helpers.mjs (SMI-6744 Wave 4 M-6 governance
 * round, to keep this file under the 500-line policy once its own Layer-X
 * arm grew a second tree assertion and a `.bin` symlink judge) -- both are
 * re-exported below so every existing import of this file keeps working
 * unchanged.
 */

import {
  readFileSync,
  existsSync as defaultExistsSync,
  lstatSync as defaultLstatSync,
  readlinkSync as defaultReadlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  evaluateLayerXBinSymlinks,
  LAYER_X_BIN_NAMES,
} from './audit-ruflo-host-paths-layerx-helpers.mjs'
export {
  RUFLO_MCP_DENY_ENTRIES,
  evaluateRufloMcpDenies,
  rufloMcpDeniesReportLines,
} from './audit-ruflo-mcp-denies-helpers.mjs'
export {
  EXPECTED_GUARD_COMMAND,
  evaluateRufloHostGuardHooks,
  rufloHostGuardHooksReportLines,
} from './audit-ruflo-host-guard-hooks-helpers.mjs'

/**
 * The 50-entry Bash deny set (design doc § 1(b) Layer R, queen-corrected
 * 2026-09-27, `@*` twins added by the M-4 governance round: every entry is
 * either an exact argument-less form or a `*`-terminated prefix a real
 * census spelling begins with -- no bare un-terminated path fragments, and
 * every one of the seven package-runner forms other than `npx` -- which
 * accept `pkg@version` and fetch straight from the registry, a spelling
 * Layer X's devDependency removal does not reach -- carries all three of
 * its exact, ` *` and `@*` twins).
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
  'Bash(npm exec ruflo@*)',
  'Bash(npm exec -- ruflo)',
  'Bash(npm exec -- ruflo *)',
  'Bash(npm exec -- ruflo@*)',
  'Bash(npm x ruflo)',
  'Bash(npm x ruflo *)',
  'Bash(npm x ruflo@*)',
  'Bash(npm x -- ruflo)',
  'Bash(npm x -- ruflo *)',
  'Bash(npm x -- ruflo@*)',
  'Bash(pnpm dlx ruflo)',
  'Bash(pnpm dlx ruflo *)',
  'Bash(pnpm dlx ruflo@*)',
  'Bash(yarn dlx ruflo)',
  'Bash(yarn dlx ruflo *)',
  'Bash(yarn dlx ruflo@*)',
  'Bash(bunx ruflo)',
  'Bash(bunx ruflo *)',
  'Bash(bunx ruflo@*)',
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
 * Check 74's out-of-reach note (design § 6 row 14), split into the two
 * shapes the check's own assertions actually need (SMI-6744 Wave 4 L-12
 * governance finding: a single note applied to both the deny-entry lines
 * and the tree-assertion lines, but the two assertions have different blind
 * spots -- the deny-entry lines never touch a filesystem tree at all, and
 * the tree lines never touch the owner's personal settings file).
 */

/** For the deny-entry (Layer R / Layer G) assertions. */
const DENY_ENTRIES_OUT_OF_REACH_NOTE =
  'The nvm global prefix (Layer G -- `npm uninstall -g ruflo`) and the user-scope ' +
  "~/.claude/settings.json are out of this check's reach (they belong to A4.7's owner " +
  'transcript, not audit:standards -- CI and the dev container have neither a `~/.nvm` ' +
  "prefix nor the owner's own user-scope settings file, so asserting either here would be " +
  'vacuously green).'

/** For the `node_modules/ruflo` and `node_modules/@claude-flow/cli` tree assertions. */
const TREE_OUT_OF_REACH_NOTE =
  'A tree assertion at this path cannot see the five `~/.npm/_npx` cache trees (Layer P) or ' +
  "the nvm global prefix (Layer G) -- those are host-global state out of this check's reach " +
  "(they belong to A4.7's owner transcript, not audit:standards). These three local-tree " +
  'arms (the two tree-presence checks above and the bin-symlink scan below) are also green ' +
  'by construction under `npm ci` (CI) and can only fail on a host whose `node_modules` ' +
  'predates the lockfile -- so a green CI line here is not evidence about any developer host.'

function readDenyArray(settingsPath, readFile) {
  const parsed = JSON.parse(readFile(settingsPath))
  const deny = parsed && parsed.permissions && Array.isArray(parsed.permissions.deny)
  return deny ? parsed.permissions.deny : []
}

/**
 * Check 74: evaluate (a) presence of every RUFLO_BASH_DENY_ENTRIES literal
 * in settingsPath's `permissions.deny`, (b) absence of `<root>/
 * node_modules/ruflo` on the host tree, (c) absence of `<root>/
 * node_modules/@claude-flow/cli` (SMI-6744 Wave 4 M-6: the package `ruflo`
 * re-exports, which can survive a partial removal that already dropped the
 * top-level `ruflo` directory), and (d) no stale ruflo/@claude-flow
 * `node_modules/.bin/{ruflo,claude-flow,claude-flow-mcp,cli}` symlink.
 *
 * @param {{
 *   settingsPath: string,
 *   root: string,
 *   readFile?: (path: string) => string,
 *   existsSync?: (path: string) => boolean,
 *   lstatSync?: (path: string) => import('node:fs').Stats,
 *   readlinkSync?: (path: string) => string,
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
    lstatSync = defaultLstatSync,
    readlinkSync = defaultReadlinkSync,
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

  const cliTreePath = join(root, 'node_modules', '@claude-flow', 'cli')
  const cliTreePresent = existsSync(cliTreePath)

  const binEntries = evaluateLayerXBinSymlinks(root, { lstatSync, readlinkSync })

  return {
    status: 'evaluated',
    settingsPath,
    denyCount: denyArray.length,
    requiredCount: entries.length,
    missingBashEntries,
    treePath,
    treePresent,
    cliTreePath,
    cliTreePresent,
    binEntries,
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
        `(${denomA}). ${DENY_ENTRIES_OUT_OF_REACH_NOTE}`,
      fix: FIX_MISSING_BASH_ENTRY,
    })
  }
  if (verdict.missingBashEntries.length === 0) {
    lines.push({
      severity: 'pass',
      message:
        `Check 74: all ${verdict.requiredCount} SMI-6744 Wave 4 Bash deny entries are present ` +
        `in ${verdict.settingsPath} permissions.deny (${denomA}). ${DENY_ENTRIES_OUT_OF_REACH_NOTE}`,
    })
  }

  if (verdict.treePresent) {
    lines.push({
      severity: 'fail',
      message:
        `Check 74 FINDING: ${verdict.treePath} is present — the SMI-6744 Wave 4 host-tree ` +
        `removal (Checkpoint 4 row 5) has not landed on this host. ${TREE_OUT_OF_REACH_NOTE}`,
      fix: FIX_TREE_PRESENT,
    })
  } else {
    lines.push({
      severity: 'pass',
      message: `Check 74: ${verdict.treePath} is absent. ${TREE_OUT_OF_REACH_NOTE}`,
    })
  }

  if (verdict.cliTreePresent) {
    lines.push({
      severity: 'fail',
      message:
        `Check 74 FINDING: ${verdict.cliTreePath} is present — the SMI-6744 Wave 4 host-tree ` +
        `removal (Checkpoint 4 row 5) has not fully landed on this host (ruflo re-exports ` +
        `@claude-flow/cli, so this tree can survive a partial or manually-patched removal ` +
        `even when node_modules/ruflo itself is gone). ${TREE_OUT_OF_REACH_NOTE}`,
      fix: FIX_TREE_PRESENT,
    })
  } else {
    lines.push({
      severity: 'pass',
      message: `Check 74: ${verdict.cliTreePath} is absent. ${TREE_OUT_OF_REACH_NOTE}`,
    })
  }

  const binFindings = (verdict.binEntries || []).filter((b) => b.finding)
  for (const b of binFindings) {
    const reason = b.dangling
      ? 'it is a dangling symlink (its target does not resolve)'
      : `its target "${b.target}" resolves into a ruflo/@claude-flow directory`
    lines.push({
      severity: 'fail',
      message:
        `Check 74 FINDING: ${b.binPath} is a stale bin symlink -- ${reason}. A clean ` +
        `SMI-6744 Wave 4 host-tree removal (Checkpoint 4 row 5) leaves no entry here. ` +
        TREE_OUT_OF_REACH_NOTE,
      fix: FIX_TREE_PRESENT,
    })
  }
  if (binFindings.length === 0) {
    lines.push({
      severity: 'pass',
      message:
        `Check 74: none of the ${LAYER_X_BIN_NAMES.length} checked node_modules/.bin entries ` +
        `(${LAYER_X_BIN_NAMES.join(', ')}) is a stale ruflo/@claude-flow symlink. ` +
        TREE_OUT_OF_REACH_NOTE,
    })
  }

  return lines
}
