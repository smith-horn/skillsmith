#!/usr/bin/env node
/**
 * Helper for audit-standards.mjs Check 72 (SMI-6654) and its executable twin,
 * scripts/tests/audit-container-npm-gate.test.ts.
 *
 * ADR-158 Decision 3 makes scripts/lib/node-modules-mount-gate.sh the only
 * sanctioned gate for a node_modules mutation inside a dev container. This
 * check enforces it statically over every tracked text file (R1), in two arms:
 *
 *   Arm A -- a container launcher followed by an npm mutation verb is a
 *   FINDING unless it matches one of two structurally safe shapes (R5):
 *     (a) the verb sits inside ONE `sh -c` / `bash -c` script given to the
 *         launcher, joined to an exact gate invocation by an unbroken `&&`
 *         chain, with no `||` or `|` earlier in the same and-or list;
 *     (b) the script is exactly regen-lockfile.sh's saved-rc form.
 *   Everything else is a finding. A textual "the gate appears nearby" rule was
 *   shown unsafe in plan review round 1 (an echoed gate, a gate run in the
 *   container with the verb in the HOST shell), so this is a shape allowlist.
 *
 *   Arm B -- a mount-table probe (a `mountpoint` or `findmnt` call) whose
 *   target is a node_modules path is a FINDING: it follows symlinks and
 *   accepts host binds, which is how SMI-6516 let npm write the host tree
 *   through a detached volume. A probe of any other path is a permanent, allowlistable WARN.
 *
 * Plan: docs/internal/implementation/smi-6654-container-npm-mount-gate-check.md
 *
 * The pure text-analysis layer (classifyUnit, logicalUnits, probeMounts,
 * scanText and their private helpers) lives in the sibling
 * scripts/audit-container-npm-gate-parse-helpers.mjs (SMI-6654 500-line
 * split) and is re-exported below so every existing importer keeps working
 * unchanged.
 *
 * This file is scanned by Check 72 like any other tracked file (no
 * self-exemption), so its comments and strings are worded so that no launcher
 * precedes an npm verb on one line.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  classifyUnit,
  logicalUnits,
  probeMounts,
  scanText,
} from './audit-container-npm-gate-parse-helpers.mjs'

export { classifyUnit, logicalUnits, probeMounts, scanText }

/** Date-only ISO string, so it parses as UTC midnight: enforcement begins 2026-10-05T00:00:00Z. */
export const CHECK_72_SHADOW_END_DATE = '2026-10-05'

/**
 * R6 / D-4. Flip to true only in a PR that pastes the passing § U-1 experiment
 * output. Until then a `--package-lock-only` install is neither a pass nor a
 * fail: it reports `WARN [lock-only-unverified]`.
 */
export const LOCK_ONLY_EXEMPTION_VERIFIED = false

/**
 * `${file}:${trimmed first line of the unit}` -> justification (Check 66 shape).
 * An entry that no longer matches a current finding or mount-probe warn is
 * itself reported, so a stale grant cannot silently mask a future regression.
 * Deliberately empty (D-2): prohibitions and comments are reworded, not exempted.
 */
export const CONTAINER_NPM_GATE_ALLOWLIST_JUSTIFICATIONS = Object.freeze({})

const EXCLUDED_DIR_RE = /(^|\/)(tests?|__tests__|fixtures?)\//
const EXCLUDED_FILE_RE = /\.(test|spec)\.[a-z]+$/
const MD_RE = /\.mdx?$/i
const GIT_DISCOVERY_ENV_RE =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/

/** R1: `git ls-files` at the repo root (no submodule recursion), with modes so gitlinks are exact. */
function listTrackedEntries(repoRoot) {
  // An inherited GIT_DIR or GIT_INDEX_FILE (git hooks set them) would make
  // `git -C <root>` read another repository or a temporary index.
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (GIT_DISCOVERY_ENV_RE.test(k)) delete env[k]
  }
  // CI's Test (root) container checks the repo out under a different UID than
  // the process running git, so git refuses with "detected dubious ownership"
  // (PR #2857 CI). Trust exactly the repo being audited, from command-line
  // (protected) config. `core.fsmonitor=false` is required alongside it:
  // measured, `ls-files` runs a repo-configured fsmonitor hook once the repo is
  // trusted, and this read must never execute repo-controlled code.
  let trustedRoot = resolve(repoRoot)
  try {
    trustedRoot = realpathSync(trustedRoot)
  } catch {
    // Unresolvable root: git reports the real error below.
  }
  let out
  try {
    out = execFileSync(
      'git',
      [
        '-c',
        `safe.directory=${trustedRoot}`,
        '-c',
        'core.fsmonitor=false',
        '-C',
        repoRoot,
        'ls-files',
        '-z',
        '--stage',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      }
    )
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim().split('\n')[0] : ''
    const detail = stderr || (err instanceof Error ? err.message : String(err)).split('\n')[0]
    throw new Error(`\`git -C ${repoRoot} ls-files\` failed (${detail})`)
  }
  const seen = new Map()
  for (const rec of out.split('\0')) {
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    const path = rec.slice(tab + 1)
    if (!seen.has(path)) seen.set(path, rec.slice(0, rec.indexOf(' ')))
  }
  return [...seen].map(([path, mode]) => ({ path, mode }))
}

/**
 * Three-way verdict (Check 69 model): `evaluated`, or `not_evaluated` when the
 * tracked set cannot be enumerated -- `fail` under CI, `warn` locally, never a pass.
 * `now` is injected so tests never flip on the calendar.
 */
export function evaluateContainerNpmGate(repoRoot, options = {}) {
  const {
    isCI = false,
    now = new Date(),
    allowlist = CONTAINER_NPM_GATE_ALLOWLIST_JUSTIFICATIONS,
    lockOnlyExemptionVerified = LOCK_ONLY_EXEMPTION_VERIFIED,
  } = options
  const inShadow = now < new Date(CHECK_72_SHADOW_END_DATE)
  let entries
  try {
    entries = listTrackedEntries(repoRoot)
  } catch (err) {
    return {
      status: 'not_evaluated',
      reason: err instanceof Error ? err.message : String(err),
      severity: isCI ? 'fail' : 'warn',
      inShadow,
    }
  }
  const counts = {
    listed: entries.length,
    scanned: 0,
    tests: 0,
    binary: 0,
    gitlink: 0,
    symlink: 0,
    unreadable: 0,
    safe: 0,
    safeRc: 0,
    lockOnly: 0,
    allowlisted: 0,
    joinedUnits: 0,
  }
  const findings = []
  const lockOnly = []
  const mountProbeWarns = []
  const seenKeys = new Set()
  const keep = (list, item) => {
    const key = `${item.file}:${item.lineText}`
    if (Object.prototype.hasOwnProperty.call(allowlist, key)) {
      counts.allowlisted++
      seenKeys.add(key)
    } else list.push(item)
  }
  for (const { path, mode } of entries) {
    if (mode === '160000') {
      counts.gitlink++
      continue
    }
    // A tracked symlink's blob is its target path, not the target's content.
    if (mode === '120000') {
      counts.symlink++
      continue
    }
    let buf
    try {
      buf = readFileSync(join(repoRoot, path))
    } catch {
      counts.unreadable++
      continue
    }
    if (buf.includes(0)) {
      counts.binary++
      continue
    }
    if (EXCLUDED_DIR_RE.test(path) || EXCLUDED_FILE_RE.test(path)) {
      counts.tests++
      continue
    }
    counts.scanned++
    const r = scanText(buf.toString('utf8'), MD_RE.test(path))
    counts.joinedUnits += r.joinedUnits
    for (const u of r.unresolved) {
      keep(findings, {
        arm: 'A',
        tag: 'split-unresolved',
        file: path,
        line: u.line,
        lineText: u.lineText,
        text: '',
      })
    }
    for (const v of r.verbs) {
      const item = { file: path, line: v.line, lineText: v.lineText, text: v.text }
      if (v.verdict === 'safe') counts.safe++
      else if (v.verdict === 'safe-rc') counts.safeRc++
      else if (v.verdict === 'lock-only-unverified') {
        counts.lockOnly++
        lockOnly.push(item)
      } else keep(findings, { arm: 'A', tag: v.verdict, ...item })
    }
    for (const p of r.probes) {
      const item = { file: path, line: p.line, lineText: p.lineText, text: p.text }
      if (p.severity === 'block') keep(findings, { arm: 'B', tag: 'node_modules-probe', ...item })
      else keep(mountProbeWarns, item)
    }
  }
  const staleAllowlistKeys = Object.keys(allowlist).filter((k) => !seenKeys.has(k))
  return {
    status: 'evaluated',
    inShadow,
    lockOnlyExemptionVerified,
    counts,
    findings,
    lockOnly,
    mountProbeWarns,
    staleAllowlistKeys,
  }
}

const FIX_NOT_EVALUATED_CI =
  'A CI runner always has a working git, so this is a real breakage. Check that the checkout step ran and the working tree is a git repository.'
const FIX_NOT_EVALUATED_LOCAL =
  'Expected inside a worktree dev container, where /app/.git names an unmounted host path (SMI-6524). Run the audit on the HOST to evaluate Check 72.'
const FIX_ARM_A =
  'Run the mutation inside ONE container shell, joined to the gate by an unbroken && chain -- ' +
  "docker exec -w /app <container> sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm install' " +
  '(ADR-158 Decision 3). Prose or comments that only name the command must be reworded so no launcher precedes the verb.'
const FIX_SPLIT =
  'A launcher command could not be assembled before EOF (unclosed quote, continuation or heredoc). Write the gated command on one line.'
const FIX_ARM_B =
  'Do not infer a node_modules volume from the mount table (SMI-6516): it follows symlinks and accepts host binds. Use scripts/lib/node-modules-mount-gate.sh.'
const FIX_LOCK_ONLY =
  'Pending § U-1 of the SMI-6654 plan. If the experiment fails, rewrite this line to safe shape (a) (D-4(b)).'
const FIX_MOUNT_WARN =
  'A mount-table probe is an inference, not a direct test of the property (warn only). Allowlist it with a reason if it is correct.'
const FIX_STALE =
  'Remove the stale entry from CONTAINER_NPM_GATE_ALLOWLIST_JUSTIFICATIONS: an unused grant masks a future regression.'

/** Turn a verdict into the exact report lines (F-7 prefixes). `severity` names the audit's reporter. */
export function containerNpmGateReportLines(verdict) {
  if (verdict.status === 'not_evaluated') {
    return [
      {
        severity: verdict.severity,
        message: `Check 72 NOT-EVALUATED — could not enumerate tracked files, so nothing was scanned: ${verdict.reason}`,
        fix: verdict.severity === 'fail' ? FIX_NOT_EVALUATED_CI : FIX_NOT_EVALUATED_LOCAL,
      },
    ]
  }
  const { counts: c, inShadow } = verdict
  const findingSeverity = inShadow ? 'warn' : 'fail'
  const shadowSuffix = inShadow
    ? ` [shadow mode through ${CHECK_72_SHADOW_END_DATE} — advisory only]`
    : ''
  const denominators =
    `scanned=${c.scanned} safe=${c.safe + c.safeRc} lockOnly=${c.lockOnly} allowlisted=${c.allowlisted} ` +
    `excluded(tests/binary/gitlink)=${c.tests}/${c.binary}/${c.gitlink} symlink=${c.symlink} unreadable=${c.unreadable} ` +
    `safeShapes(a/b)=${c.safe}/${c.safeRc} joinedUnits=${c.joinedUnits} listed=${c.listed}`
  const lines = []
  for (const f of verdict.findings) {
    const what =
      f.tag === 'split-unresolved' ? 'launcher command never closes' : `\`${f.text}\` (${f.tag})`
    lines.push({
      severity: findingSeverity,
      message: `Check 72 FINDING [${f.arm}:${f.tag}] ${f.file}:${f.line} — ${what} {${denominators}}${shadowSuffix}`,
      fix: f.arm === 'B' ? FIX_ARM_B : f.tag === 'split-unresolved' ? FIX_SPLIT : FIX_ARM_A,
    })
  }
  for (const key of verdict.staleAllowlistKeys) {
    lines.push({
      severity: findingSeverity,
      message: `Check 72 FINDING [allowlist:stale] '${key}' — no current finding or warn matches this key {${denominators}}${shadowSuffix}`,
      fix: FIX_STALE,
    })
  }
  if (lines.length === 0) {
    lines.push({ severity: 'pass', message: `Check 72: clean — ${denominators}${shadowSuffix}` })
  }
  if (!verdict.lockOnlyExemptionVerified) {
    for (const l of verdict.lockOnly) {
      lines.push({
        severity: 'warn',
        message: `Check 72 WARN [lock-only-unverified] ${l.file}:${l.line} — \`${l.text} --package-lock-only\` is exempt only once U-1 is verified`,
        fix: FIX_LOCK_ONLY,
      })
    }
  }
  for (const w of verdict.mountProbeWarns) {
    lines.push({
      severity: 'warn',
      message: `Check 72 WARN [B:mount-probe] ${w.file}:${w.line} — \`${w.text}\``,
      fix: FIX_MOUNT_WARN,
    })
  }
  return lines
}

/**
 * F-4: what the live-repo twin must do. A failed enumeration fails under CI or
 * with a real `.git` directory; only a local container whose `.git` gitfile
 * names a missing target (SMI-6524) may skip.
 * @returns {'run' | 'fail' | 'skip'}
 */
export function liveScanDisposition({
  isCI,
  gitIsDirectory,
  inDocker,
  gitfileTargetMissing,
  enumerationOk,
}) {
  if (enumerationOk) return 'run'
  if (isCI || gitIsDirectory) return 'fail'
  if (inDocker && gitfileTargetMissing) return 'skip'
  return 'fail'
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
  } catch {
    return false
  }
}

if (isMainModule()) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const verdict = evaluateContainerNpmGate(repoRoot, {
    isCI: Boolean(process.env.CI),
    now: new Date(),
  })
  const lines = containerNpmGateReportLines(verdict)
  const mark = { pass: '✓', warn: '⚠', fail: '✗' }
  for (const l of lines) {
    console.log(`${mark[l.severity]} ${l.message}`)
    if (l.fix) console.log(`  Fix: ${l.fix}`)
  }
  process.exit(lines.some((l) => l.severity === 'fail') ? 1 : 0)
}
