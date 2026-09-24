/**
 * @fileoverview Tests for update-target-reason.ts (SMI-6532 A2, §4.4 of
 *   docs/internal/implementation/update-safety-and-source-resolution.md).
 *
 *   Member-count reconciliation (task brief cross-check): the brief's own
 *   pre-computed figure was "§4.3's table yields 22 reasons; §4.5's group
 *   table lists 22 of them across seven groups, with `backup-dir` appearing
 *   only as a count." Independently deriving this from the spec text:
 *
 *   - §4.3's table rows (0a-16), excluding row 1 ("not listed", explicitly
 *     not a member per the task brief), yield 21 distinct reason strings —
 *     `manifest-unreadable`, `recovery-record-unreadable`, `backup-dir`,
 *     `recovery-pending`, `untracked`, `manifest-key-conflict`,
 *     `git-managed`, `local`, `illegal-provenance`, `unverified`, `pinned`,
 *     `policy-never`, `policy-manual`, `identity-mismatch`, `fetch-failed`,
 *     `scan-rejected`, `unsupported-entry`, `no-baseline`, `local-edits`,
 *     `up-to-date`, `eligible`.
 *   - §4.2's preamble ("Metadata errors ... give `probe-failed`. A read or
 *     hash error ... gives `unreadable`") and §4.3's own preamble ("A probe
 *     error at any row ends classification there, with `probe-failed` or
 *     `unreadable`") add two more: `probe-failed`, `unreadable`.
 *   - 21 + 2 = 23 total addressable `UpdateTargetReason` values.
 *   - Cross-checking against §4.5's group table independently: counting the
 *     reasons listed across its seven group rows (Will update: 1, Needs your
 *     attention: 8, Yours left alone: 2, Git clones: 1, Blocked: 3, Could not
 *     check: 6, Up to date: 1) gives exactly 22 — and every one of those 22
 *     strings is also in the 23-item list above. The 23rd, `backup-dir`, is
 *     the one §4.5 explicitly says "appears only as a count" and is absent
 *     from every group row — which is consistent with, not contradictory to,
 *     it still being an `UpdateTargetReason` member (§4.3 row 2 names it with
 *     its own Reason-column value).
 *
 *   So both tables agree the FULL set is 23 members (22 grouped + 1
 *   count-only). The brief's "22 reasons" for §4.3 only reconciles with this
 *   file's 23 if "the table" is read as excluding `backup-dir` from its own
 *   row count — which contradicts `backup-dir` being an explicit Reason-column
 *   value at row 2 of that same table. That inconsistency in the brief's own
 *   phrasing is the flagged finding: this file ships with 23 members (the
 *   reading that keeps `backup-dir` counted once as a real reason, matching
 *   its own explicit table row), not 22, and `UPDATE_TARGET_REASONS.length`
 *   below is asserted against the literal `23`, not against the brief's
 *   number, so a future edit that silently drops back to 22 (e.g. by
 *   mis-reading `backup-dir` as ungrouped-therefore-absent) fails loudly here.
 *
 * @module @skillsmith/core/services/update-target-reason.test
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'

import {
  BACKUP_DIR_GROUP,
  REASON_GROUP,
  remediationFor,
  UPDATE_RESULT_CODES,
  UPDATE_TARGET_REASONS,
  type UpdateRemediation,
  type UpdateResultCode,
  type UpdateTargetGroup,
  type UpdateTargetReason,
} from './update-target-reason.js'

// UpdateRemediation kind exhaustiveness (§4.4's 9 + set-policy, SMI-6532): a
// Record<kind, true> compiles only when every kind is present exactly once,
// so this proves the key set IS complete, not just that these keys resolve.
const ALL_REMEDIATION_KINDS: Record<UpdateRemediation['kind'], true> = {
  'git-pull': true,
  reconcile: true,
  unpin: true,
  'set-policy': true,
  'fix-permissions': true,
  'audit-sources': true,
  'move-aside': true,
  doctor: true,
  retry: true,
  none: true,
}
it('has exactly 10 remediation kinds (9 from §4.4 plus set-policy, SMI-6532)', () => {
  expect(Object.keys(ALL_REMEDIATION_KINDS).length).toBe(10)
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─────────────────────────────────────────────────────────────────────────────
// Member counts and duplicate detection
// ─────────────────────────────────────────────────────────────────────────────

describe('UPDATE_TARGET_REASONS (§4.3 + §4.2/§4.3 preamble)', () => {
  it('has exactly 23 members (literal count, per this file header derivation)', () => {
    expect(UPDATE_TARGET_REASONS.length).toBe(23)
  })

  it('has no duplicate entries', () => {
    expect(new Set(UPDATE_TARGET_REASONS).size).toBe(UPDATE_TARGET_REASONS.length)
  })

  it('matches the exact expected member set, not just a count', () => {
    const expected: readonly UpdateTargetReason[] = [
      'manifest-unreadable',
      'recovery-record-unreadable',
      'backup-dir',
      'recovery-pending',
      'untracked',
      'manifest-key-conflict',
      'git-managed',
      'local',
      'illegal-provenance',
      'unverified',
      'pinned',
      'policy-never',
      'policy-manual',
      'identity-mismatch',
      'fetch-failed',
      'scan-rejected',
      'unsupported-entry',
      'no-baseline',
      'local-edits',
      'up-to-date',
      'eligible',
      'probe-failed',
      'unreadable',
    ]
    expect([...UPDATE_TARGET_REASONS].sort()).toEqual([...expected].sort())
  })

  it('does not include "not listed" (§4.3 row 1 is explicitly not a member)', () => {
    expect(UPDATE_TARGET_REASONS).not.toContain('not listed')
  })
})

describe('UPDATE_RESULT_CODES (§4.4 literal enumeration)', () => {
  it('has exactly 15 members', () => {
    expect(UPDATE_RESULT_CODES.length).toBe(15)
  })

  it('has no duplicate entries', () => {
    expect(new Set(UPDATE_RESULT_CODES).size).toBe(UPDATE_RESULT_CODES.length)
  })

  it('matches the exact expected member set, not just a count', () => {
    const expected: readonly UpdateResultCode[] = [
      'updated',
      'changed-since-plan',
      'busy',
      'target-changed',
      'root-changed',
      'staging-unsafe',
      'staging-collision',
      'backup-unsafe',
      'recovery-pending',
      'recovery-record-unreadable',
      'recovery-conflict',
      'recovery-identity-changed',
      'recovery-ambiguous',
      'recovery-moved',
      'write-failed',
    ]
    expect([...UPDATE_RESULT_CODES].sort()).toEqual([...expected].sort())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// REASON_GROUP (§4.5's group table)
// ─────────────────────────────────────────────────────────────────────────────

describe('REASON_GROUP (§4.5)', () => {
  it('assigns exactly one group to every one of the 23 reasons', () => {
    expect(Object.keys(REASON_GROUP).length).toBe(23)
  })

  it('matches §4.5s printed group table reason-by-reason, including the backup-dir sentinel', () => {
    const expected: Record<UpdateTargetReason, string> = {
      eligible: 'will-update',
      unverified: 'needs-attention',
      'identity-mismatch': 'needs-attention',
      'manifest-key-conflict': 'needs-attention',
      'illegal-provenance': 'needs-attention',
      'no-baseline': 'needs-attention',
      'local-edits': 'needs-attention',
      'unsupported-entry': 'needs-attention',
      'recovery-pending': 'needs-attention',
      local: 'yours-left-alone',
      untracked: 'yours-left-alone',
      'git-managed': 'git-clones',
      pinned: 'blocked',
      'policy-never': 'blocked',
      'policy-manual': 'blocked',
      'probe-failed': 'could-not-check',
      unreadable: 'could-not-check',
      'fetch-failed': 'could-not-check',
      'scan-rejected': 'could-not-check',
      'manifest-unreadable': 'could-not-check',
      'recovery-record-unreadable': 'could-not-check',
      'up-to-date': 'up-to-date',
      'backup-dir': BACKUP_DIR_GROUP,
    }
    for (const reason of UPDATE_TARGET_REASONS) {
      expect(REASON_GROUP[reason]).toBe(expected[reason])
    }
  })

  const groupMembership: Record<
    Exclude<UpdateTargetGroup, never>,
    readonly UpdateTargetReason[]
  > = {
    'will-update': ['eligible'],
    'needs-attention': [
      'unverified',
      'identity-mismatch',
      'manifest-key-conflict',
      'illegal-provenance',
      'no-baseline',
      'local-edits',
      'unsupported-entry',
      'recovery-pending',
    ],
    'yours-left-alone': ['local', 'untracked'],
    'git-clones': ['git-managed'],
    blocked: ['pinned', 'policy-never', 'policy-manual'],
    'could-not-check': [
      'probe-failed',
      'unreadable',
      'fetch-failed',
      'scan-rejected',
      'manifest-unreadable',
      'recovery-record-unreadable',
    ],
    'up-to-date': ['up-to-date'],
  }

  for (const [group, expectedMembers] of Object.entries(groupMembership)) {
    it(`"${group}" contains exactly its §4.5 members and no others (SMI-6407 duplicate-entry guard)`, () => {
      const actualMembers = UPDATE_TARGET_REASONS.filter((r) => REASON_GROUP[r] === group)
      expect([...actualMembers].sort()).toEqual([...expectedMembers].sort())
    })
  }

  it('maps backup-dir to the documented sentinel, never to a real print group', () => {
    expect(REASON_GROUP['backup-dir']).toBe(BACKUP_DIR_GROUP)
    expect(REASON_GROUP['backup-dir']).not.toBe('will-update')
    expect(REASON_GROUP['backup-dir']).not.toBe('needs-attention')
    expect(REASON_GROUP['backup-dir']).not.toBe('yours-left-alone')
    expect(REASON_GROUP['backup-dir']).not.toBe('git-clones')
    expect(REASON_GROUP['backup-dir']).not.toBe('blocked')
    expect(REASON_GROUP['backup-dir']).not.toBe('could-not-check')
    expect(REASON_GROUP['backup-dir']).not.toBe('up-to-date')
  })

  it('the seven real print groups plus the backup-dir sentinel account for all 23 reasons, with no overlap', () => {
    const grouped = new Set(Object.values(REASON_GROUP))
    // 7 real groups + 1 sentinel = 8 distinct values used across 23 reasons.
    expect(grouped.size).toBe(8)
    const totalAcrossGroups = Object.values(groupMembership).reduce((n, arr) => n + arr.length, 0)
    expect(totalAcrossGroups + 1 /* backup-dir */).toBe(23)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// remediationFor — every reason and every result code, kind-by-kind
// ─────────────────────────────────────────────────────────────────────────────

// Remediation choices (§4.4 names the 9 kinds; it does not spell out a
// reason-by-reason or code-by-code table, so each choice below is the
// closest semantic match between the §4.3/§4.4 prose for that member and one
// of the 9 available kinds). Documented here so a reader can see the
// reasoning without re-deriving it from update-target-reason.ts's own
// comments:
//   - I/O failures (manifest-unreadable, recovery-record-unreadable,
//     probe-failed, unreadable, recovery-record-unreadable [result],
//     write-failed) -> fix-permissions, since §4.2/§4.4 both say these carry
//     a sanitized/full {path, errno}.
//   - backup-dir, untracked, local, local-edits, up-to-date, eligible,
//     updated -> none: terminal non-error states or a deliberate choice.
//   - policy-never, policy-manual -> set-policy{dirName, manifestKey,
//     current}: owner decision SMI-6532 (see UpdateRemediation's own doc
//     comment) — unlike `none` (the prior mapping), this gives §4.5's
//     groups a next step, matching the structurally identical `pinned`.
//   - recovery-pending (both), recovery-conflict, recovery-ambiguous ->
//     doctor{command:'recovery'}, the §3.9 workflow; conflict/ambiguous use
//     action 'quarantine' since an automatic apply/undo would be a guess.
//   - manifest-key-conflict, identity-mismatch, recovery-identity-changed ->
//     reconcile{action:'verify'}: §4.3's own UD22 text says remediation
//     "names the owning key".
//   - recovery-moved -> reconcile{action:'relink'}: the target moved, so the
//     manifest key needs relinking to the new location.
//   - git-managed -> git-pull: git clones are pulled, never overwritten.
//   - illegal-provenance, unverified, scan-rejected, no-baseline ->
//     audit-sources: all four need a human to look at where content actually
//     came from before anything automated is safe.
//   - pinned -> unpin: the direct action exists for exactly this.
//   - fetch-failed, changed-since-plan, busy, target-changed, root-changed ->
//     retry: transient/stale-plan shapes where re-running is the next step.
//   - unsupported-entry, staging-unsafe, staging-collision, backup-unsafe ->
//     move-aside: each names a directory that blocks the write until moved.
const EXPECTED_REASON_KIND: Record<UpdateTargetReason, UpdateRemediation['kind']> = {
  'manifest-unreadable': 'fix-permissions',
  'recovery-record-unreadable': 'fix-permissions',
  'backup-dir': 'none',
  'recovery-pending': 'doctor',
  untracked: 'none',
  'manifest-key-conflict': 'reconcile',
  'git-managed': 'git-pull',
  local: 'none',
  'illegal-provenance': 'audit-sources',
  unverified: 'audit-sources',
  pinned: 'unpin',
  'policy-never': 'set-policy',
  'policy-manual': 'set-policy',
  'identity-mismatch': 'reconcile',
  'fetch-failed': 'retry',
  'scan-rejected': 'audit-sources',
  'unsupported-entry': 'move-aside',
  'no-baseline': 'audit-sources',
  'local-edits': 'none',
  'up-to-date': 'none',
  eligible: 'none',
  'probe-failed': 'fix-permissions',
  unreadable: 'fix-permissions',
}

const EXPECTED_RESULT_KIND: Record<UpdateResultCode, UpdateRemediation['kind']> = {
  updated: 'none',
  'changed-since-plan': 'retry',
  busy: 'retry',
  'target-changed': 'retry',
  'root-changed': 'retry',
  'staging-unsafe': 'move-aside',
  'staging-collision': 'move-aside',
  'backup-unsafe': 'move-aside',
  'recovery-pending': 'doctor',
  'recovery-record-unreadable': 'fix-permissions',
  'recovery-conflict': 'doctor',
  'recovery-identity-changed': 'reconcile',
  'recovery-ambiguous': 'doctor',
  'recovery-moved': 'reconcile',
  'write-failed': 'fix-permissions',
}

describe('remediationFor — reasons', () => {
  it('has a distinct expectation registered for every one of the 23 reasons (no fixture shrinkage)', () => {
    expect(Object.keys(EXPECTED_REASON_KIND).length).toBe(23)
    expect(Object.keys(EXPECTED_REASON_KIND).length).toBe(UPDATE_TARGET_REASONS.length)
  })

  for (const reason of UPDATE_TARGET_REASONS) {
    it(`reason '${reason}' resolves to kind '${EXPECTED_REASON_KIND[reason]}'`, () => {
      const result = remediationFor({ kind: 'reason', reason })
      expect(result).toBeDefined()
      expect(result.kind).toBe(EXPECTED_REASON_KIND[reason])
    })
  }

  it('fix-permissions carries the path/errno passed in context', () => {
    const result = remediationFor(
      { kind: 'reason', reason: 'unreadable' },
      { path: '/skills/foo/SKILL.md', errno: 'EACCES' }
    )
    expect(result).toEqual({
      kind: 'fix-permissions',
      path: '/skills/foo/SKILL.md',
      errno: 'EACCES',
    })
  })

  it('git-pull carries the repoRoot passed in context', () => {
    const result = remediationFor(
      { kind: 'reason', reason: 'git-managed' },
      { repoRoot: '/skills/foo' }
    )
    expect(result).toEqual({ kind: 'git-pull', repoRoot: '/skills/foo' })
  })

  it('reconcile carries action "verify" and the manifestKey for manifest-key-conflict', () => {
    const result = remediationFor(
      { kind: 'reason', reason: 'manifest-key-conflict' },
      { manifestKey: 'foo::agents' }
    )
    expect(result).toEqual({ kind: 'reconcile', action: 'verify', manifestKey: 'foo::agents' })
  })

  it('unpin carries the dirName for pinned', () => {
    const result = remediationFor({ kind: 'reason', reason: 'pinned' }, { dirName: 'foo' })
    expect(result).toEqual({ kind: 'unpin', dirName: 'foo' })
  })

  it('move-aside carries the dir for unsupported-entry', () => {
    const result = remediationFor(
      { kind: 'reason', reason: 'unsupported-entry' },
      { dir: '/skills/foo' }
    )
    expect(result).toEqual({ kind: 'move-aside', dir: '/skills/foo' })
  })

  it('set-policy carries dirName, manifestKey and current for policy-never/policy-manual', () => {
    const never = remediationFor(
      { kind: 'reason', reason: 'policy-never' },
      { dirName: 'foo', manifestKey: 'foo::agents' }
    )
    expect(never).toEqual({
      kind: 'set-policy',
      dirName: 'foo',
      manifestKey: 'foo::agents',
      current: 'never',
    })

    const manual = remediationFor(
      { kind: 'reason', reason: 'policy-manual' },
      { dirName: 'bar', manifestKey: 'bar::claude' }
    )
    expect(manual).toEqual({
      kind: 'set-policy',
      dirName: 'bar',
      manifestKey: 'bar::claude',
      current: 'manual',
    })
  })
})

describe('remediationFor — result codes', () => {
  it('has a distinct expectation registered for every one of the 15 result codes (no fixture shrinkage)', () => {
    expect(Object.keys(EXPECTED_RESULT_KIND).length).toBe(15)
    expect(Object.keys(EXPECTED_RESULT_KIND).length).toBe(UPDATE_RESULT_CODES.length)
  })

  for (const code of UPDATE_RESULT_CODES) {
    it(`result '${code}' resolves to kind '${EXPECTED_RESULT_KIND[code]}'`, () => {
      const result = remediationFor({ kind: 'result', result: code })
      expect(result).toBeDefined()
      expect(result.kind).toBe(EXPECTED_RESULT_KIND[code])
    })
  }

  it('write-failed carries the errno so ENOSPC names the full device (§4.4)', () => {
    const result = remediationFor(
      { kind: 'result', result: 'write-failed' },
      { path: '/skills/foo/SKILL.md', errno: 'ENOSPC' }
    )
    expect(result).toEqual({
      kind: 'fix-permissions',
      path: '/skills/foo/SKILL.md',
      errno: 'ENOSPC',
    })
  })

  it('recovery-moved carries action "relink" and the manifestKey', () => {
    const result = remediationFor(
      { kind: 'result', result: 'recovery-moved' },
      { manifestKey: 'foo::claude' }
    )
    expect(result).toEqual({ kind: 'reconcile', action: 'relink', manifestKey: 'foo::claude' })
  })
})

describe('remediationFor — reason/result string overlap (recovery-pending, recovery-record-unreadable)', () => {
  it('resolves recovery-pending correctly whether tagged as a reason or a result', () => {
    const asReason = remediationFor({ kind: 'reason', reason: 'recovery-pending' })
    const asResult = remediationFor({ kind: 'result', result: 'recovery-pending' })
    expect(asReason.kind).toBe('doctor')
    expect(asResult.kind).toBe('doctor')
  })

  it('resolves recovery-record-unreadable correctly whether tagged as a reason or a result', () => {
    const asReason = remediationFor({ kind: 'reason', reason: 'recovery-record-unreadable' })
    const asResult = remediationFor({ kind: 'result', result: 'recovery-record-unreadable' })
    expect(asReason.kind).toBe('fix-permissions')
    expect(asResult.kind).toBe('fix-permissions')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// VS Code parity (§4.4: "VS Code imports nothing from @skillsmith/core
// today, so it keeps a copy of the two unions; a parity test compares the
// member lists.")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract `export const <exportName> = [...] as const`'s string-literal
 * elements, via the TypeScript AST rather than a quoted-string regex
 * (SMI-6841 finding 7). A regex over the raw text between the array's `[`
 * and its first `]` (the prior implementation) reads a commented-out
 * member's quoted string the same as a live one, because both are just
 * matching bytes to a regex that has no notion of "this is a comment" —
 * measured: `// 'beta',` inside the array body was silently INCLUDED in
 * the mirrored member list. `ts.createSourceFile` tokenizes comments as
 * trivia, never as part of the AST it hands back, so an
 * `ArrayLiteralExpression`'s `.elements` can only ever contain nodes that
 * are actually live code — a commented-out entry was never in that array
 * to begin with, structurally, not merely filtered out after the fact.
 * See the "parser — blind-spot controls" describe block below for the six
 * permanent cases (an unmutated positive control, plus deletion, reordering,
 * comment-out, and the namespace-nesting refusal/acceptance pair) that pin
 * this against regressing back to a text-matching or whole-tree-walking
 * approach. Module scope, not inside a `describe`, so both
 * this file's real-file parity tests AND that synthetic-fixture describe
 * block can call it directly.
 */
function extractArrayLiteral(source: string, exportName: string, fileName = 'source.ts'): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS
  )

  // TOP-LEVEL STATEMENTS ONLY -- deliberately not `ts.forEachChild` (SMI-6841
  // round 4). The `export` keyword means two different things depending on
  // where it sits: at the top level of a module it makes the binding reachable
  // by an importer, but inside `namespace Hidden { export const X = [...] }` or
  // `declare module '...' { ... }` it only makes X visible on that namespace
  // object, and no importer of this FILE can reach it. A recursive walk found
  // both and reported them identically, so the parity check verified the
  // members were WRITTEN somewhere in the mirror file while proving nothing
  // about whether they were EXPORTED from it -- a subject broader than the
  // thing it names, the same shape as every other finding on this branch.
  // `sourceFile.statements` is exactly the module's own top level, so a nested
  // declaration is now structurally out of reach rather than filtered out
  // afterwards. Pinned by the `namespace`-nesting control below.
  let found: string[] | undefined
  for (const node of sourceFile.statements) {
    if (found !== undefined) break
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName || !decl.initializer) {
          continue
        }
        // `export const X = [...] as const` wraps the array literal in an
        // AsExpression -- unwrap it before checking for the array itself,
        // rather than requiring callers' source to omit `as const`.
        const init = ts.isAsExpression(decl.initializer)
          ? decl.initializer.expression
          : decl.initializer
        if (!ts.isArrayLiteralExpression(init)) continue
        found = init.elements.map((el, i) => {
          if (!ts.isStringLiteral(el)) {
            throw new Error(
              `manifestReader.ts "${exportName}" element ${i} is not a plain string literal -- ` +
                'mirror parser only understands a flat array of quoted strings'
            )
          }
          return el.text
        })
      }
    }
  }

  if (found === undefined) {
    throw new Error(
      `manifestReader.ts has no "export const ${exportName} = [...]" array -- mirror missing or renamed`
    )
  }
  return found
}

function readMirroredArray(exportName: string): string[] {
  const filePath = path.join(__dirname, '../../../vscode-extension/src/services/manifestReader.ts')
  const source = readFileSync(filePath, 'utf-8')
  return extractArrayLiteral(source, exportName, filePath)
}

describe('VS Code manifestReader.ts mirror parity (T-R4, member-list scope)', () => {
  // Confirms independently (not "took the spec's word for it") that VS Code
  // really does not import @skillsmith/core: if it did, a real cross-package
  // import would be the right parity mechanism instead of this source-text
  // extraction, and this test's own premise would be wrong.
  it('the VS Code extension package.json has no @skillsmith/core dependency', () => {
    const pkgPath = path.join(__dirname, '../../../vscode-extension/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['@skillsmith/core']).toBeUndefined()
    expect(pkg.devDependencies?.['@skillsmith/core']).toBeUndefined()
  })

  it('UPDATE_TARGET_REASONS: VS Code mirror has the exact same member list as core, in the same order', () => {
    const mirrored = readMirroredArray('UPDATE_TARGET_REASONS')
    expect(mirrored).toEqual([...UPDATE_TARGET_REASONS])
  })

  it('UPDATE_RESULT_CODES: VS Code mirror has the exact same member list as core, in the same order', () => {
    const mirrored = readMirroredArray('UPDATE_RESULT_CODES')
    expect(mirrored).toEqual([...UPDATE_RESULT_CODES])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extractArrayLiteral — parser blind-spot controls (SMI-6841 finding 7)
// ─────────────────────────────────────────────────────────────────────────────
//
// Six permanent cases against small, synthetic source snippets (never the
// real manifestReader.ts, so these never depend on that file's own current
// contents) pinning the AST-based parser against the exact blind spots the
// prior implementations had, plus a positive control proving the parser
// isn't simply incapable of matching anything. All six were run for real
// (not merely reasoned about) before being written down here.
//
// The last two are the pair that pins the top-level-only scan: a `namespace`
// member the parser must REFUSE, and a plain top-level export it must still
// accept. Either alone is satisfiable by a broken parser -- a parser that
// matched nothing would pass the refusal case, and the recursive one this
// replaced passed the acceptance case. Together they discriminate.
describe('extractArrayLiteral — parser blind-spot controls (SMI-6841 finding 7)', () => {
  const baseline = "export const SAMPLE = [\n  'alpha',\n  'beta',\n  'gamma',\n] as const\n"

  it('positive control: an ordinary, unmutated array parses to its exact members, in order', () => {
    expect(extractArrayLiteral(baseline, 'SAMPLE')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('deleted member: a removed entry is reflected as a shorter array, not silently padded back to three', () => {
    const deleted = "export const SAMPLE = [\n  'alpha',\n  'gamma',\n] as const\n"
    expect(extractArrayLiteral(deleted, 'SAMPLE')).toEqual(['alpha', 'gamma'])
    expect(extractArrayLiteral(deleted, 'SAMPLE')).not.toEqual(['alpha', 'beta', 'gamma'])
  })

  it('swapped members: a reordered pair is reflected in the returned order, not silently re-sorted back', () => {
    const swapped = "export const SAMPLE = [\n  'beta',\n  'alpha',\n  'gamma',\n] as const\n"
    expect(extractArrayLiteral(swapped, 'SAMPLE')).toEqual(['beta', 'alpha', 'gamma'])
    expect(extractArrayLiteral(swapped, 'SAMPLE')).not.toEqual(['alpha', 'beta', 'gamma'])
  })

  it("commented-out member: a member wrapped in a line comment is NOT returned -- the exact defect the prior quoted-string regex had (it matched the comment's own quotes)", () => {
    const commented = "export const SAMPLE = [\n  'alpha',\n  // 'beta',\n  'gamma',\n] as const\n"
    expect(extractArrayLiteral(commented, 'SAMPLE')).toEqual(['alpha', 'gamma'])
    expect(extractArrayLiteral(commented, 'SAMPLE')).not.toContain('beta')
  })

  it('namespace-nested member: an `export` inside `namespace` is REFUSED, because no importer of the file can reach it', () => {
    // The recursive `ts.forEachChild` walk this replaced accepted this and
    // returned ['alpha', 'beta', 'gamma'], so the parity check would have
    // passed on a mirror file that exported nothing at all. `export` inside a
    // namespace is visibility on the namespace object, not a module export.
    const nested = `namespace Hidden {\n  export const SAMPLE = [\n    'alpha',\n    'beta',\n    'gamma',\n  ] as const\n}\n`
    expect(() => extractArrayLiteral(nested, 'SAMPLE')).toThrow(/mirror missing or renamed/)
  })

  it('top-level member alongside a namespace: the real top-level export is still found, so the refusal above is not simply "matches nothing"', () => {
    const mixed = `namespace Hidden {\n  export const SAMPLE = [\n    'wrong',\n  ] as const\n}\n\n${baseline}`
    expect(extractArrayLiteral(mixed, 'SAMPLE')).toEqual(['alpha', 'beta', 'gamma'])
  })
})
