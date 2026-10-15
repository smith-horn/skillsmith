// SMI-7123 Wave 5: the SOURCE MUTANTS (WALKER_MUTANTS, MUTATIONS), split out of
// w5-mutants.mjs for the file-length limit and moved verbatim; re-exported from it.
// Plain data: each mutant is exact text edits that w5-variant.mjs materializes.

// ---------------------------------------------------------------------------
// SOURCE MUTANTS of prune.walk.mjs / prune.mjs (applied by w5-variant.mjs).
// ---------------------------------------------------------------------------

// The walker family (w5-variant.mjs WALKER_FAMILY): each edit names the module its
// text lives in; `file` on the mutant is the child entry, always prune.walk.mjs.
const W = 'prune.walk.mjs'
const SHARED = 'prune.walk.shared.mjs'
const VERIFY = 'prune.walk.verify.mjs'
const DELETE = 'prune.walk.delete.mjs'
const SIDECAR_BYTES_CMP = {
  file: VERIFY,
  find: 'if (rs.ino !== sidecar.ino || !rs.bytes.equals(sidecar.bytes)) {',
  replace:
    'if (rs.ino !== sidecar.ino || BigInt(rs.bytes.length) !== BigInt(sidecar.bytes.length)) {',
}
const SIDECAR_UNLINK_BY_INO = {
  file: DELETE,
  find: "    if (sc) deleteLeaf('sidecar.json', SIDECAR_KEY, sc, sIdentity)",
  replace:
    "    if (sc) { const s0 = fs.lstatSync('sidecar.json', { bigint: true }); " +
    "if (s0.ino !== sc.ino || s0.size !== sc.size) throw stop('changed-during-delete', 'sidecar'); " +
    "fs.unlinkSync('sidecar.json'); deleted += 1 }",
}
const MISPLACE_RESULT = {
  file: DELETE,
  find: '      misplaced: [{ path: abs, originalRel, cause }],',
  replace: '      misplaced: null,',
}
const MISPLACE_REVERT = {
  file: DELETE,
  find: "  const misplaced = (r, originalRel, curWant) => {\n    let cause = 'cwd-covered'",
  replace:
    "  const misplaced = (r, originalRel, curWant) => {\n    if (originalRel !== SIDECAR_KEY) { try { fs.renameSync(r, originalRel.split('/').pop()) } catch { /* */ } }\n    let cause = 'cwd-covered'",
}

export const WALKER_MUTANTS = {
  'sidecar-same-inode-rewrite': {
    name: 'sidecar-same-inode-rewrite',
    file: W,
    edits: [SIDECAR_BYTES_CMP, SIDECAR_UNLINK_BY_INO],
  },
  'mkdir-eexist-ok': {
    name: 'mkdir-eexist-ok',
    file: W,
    edits: [
      {
        find: "    } catch (err) {\n      return out({ status: 'kept', reason: 'staging-unusable', detail: `mkdir ${S}: ${err.code}` })",
        replace:
          "    } catch (err) {\n      if (err.code !== 'EEXIST') return out({ status: 'kept', reason: 'staging-unusable', detail: `mkdir ${S}: ${err.code}` })",
      },
      // prettier puts the ternary's `? \`mode` on the next line; match the condition only.
      { find: ': (sd.mode & 0o077n) !== 0n', replace: ': false' },
    ],
  },
  'stage-fallback-rm': {
    name: 'stage-fallback-rm',
    file: W,
    edits: [
      {
        find: '      // Our own intent only, by inode and exact bytes (Sol c1 finding 2).\n',
        replace:
          '      fs.rmSync(job.copyPath, { recursive: true, force: true })\n      // Our own intent only, by inode and exact bytes (Sol c1 finding 2).\n',
      },
    ],
  },
  'walk-no-meta-check': {
    name: 'walk-no-meta-check',
    file: W,
    edits: [
      {
        // prettier's one-condition-per-line form of sameLeafPost
        file: SHARED,
        find: '  w.type === typeOf(s) &&\n  w.mode === s.mode &&\n  w.size === s.size &&\n  w.mtimeNs === s.mtimeNs',
        replace: '  w.type === typeOf(s)',
      },
      {
        file: SHARED,
        find: 'const sameLeafPre = (w, s) => sameLeafPost(w, s) && w.ctimeNs === s.ctimeNs',
        replace: 'const sameLeafPre = (w, s) => sameLeafPost(w, s)',
      },
    ],
  },
  'walk-delete-unknown': {
    name: 'walk-delete-unknown',
    file: W,
    edits: [
      {
        file: DELETE,
        find: "      if (!want)\n        throw stop('entry-added-during-delete', `${crel} was not in the verified inventory`)",
        replace: '      if (!want) { fs.rmSync(n, { recursive: true, force: true }); continue }',
      },
    ],
  },
  'misplace-silent': {
    name: 'misplace-silent',
    file: W,
    edits: [
      {
        file: DELETE,
        find: 'throw misplaced(r, crel, curWant)',
        replace: "throw stop('changed-during-delete', crel)",
        all: true,
      },
    ],
  },
  'misplace-revert': { name: 'misplace-revert', file: W, edits: [MISPLACE_REVERT] },
  // Sol c2 finding 1: a NAMED-import alias of rmSync never goes through the fs
  // default object, so the interposer never records it and the trace check
  // cannot see it. Only the static fs boundary check can reject it.
  'alias-rmsync': {
    name: 'alias-rmsync',
    file: W,
    edits: [
      {
        find: "import fs from 'node:fs'\n",
        replace: "import fs from 'node:fs'\nimport { rmSync as erase } from 'node:fs'\n",
      },
      {
        find: '    fs.rmdirSync(job.opDir)',
        replace: '    erase(job.opDir, { recursive: true, force: true })',
      },
    ],
  },
  // Sol c1 finding 3: P4g's empty-op-dir rmdir becomes a recursive, forced delete,
  // which erases anything else in the op dir. The trace check must FAIL it.
  'opdir-rmsync': {
    name: 'opdir-rmsync',
    file: W,
    edits: [
      {
        find: '    fs.rmdirSync(job.opDir)',
        replace: '    fs.rmSync(job.opDir, { recursive: true, force: true })',
      },
    ],
  },
}

/** M1-M8 (design §7): mutations for behaviour that cannot be red first. */
export const MUTATIONS = {
  M1: {
    name: 'M1',
    file: W,
    test: 'T14',
    edits: [
      {
        file: DELETE,
        find: '      process.chdir(r)\n      segs.push(r)\n      cwdIs(want, crel)\n',
        replace: '      process.chdir(r)\n      segs.push(r)\n',
      },
    ],
  },
  M2: {
    name: 'M2',
    file: W,
    test: 'T13-by-name',
    edits: [
      {
        file: DELETE,
        find: '    try {\n      fs.unlinkSync(r)\n    } catch (err) {',
        replace: '    try {\n      fs.unlinkSync(n)\n    } catch (err) {',
      },
    ],
  },
  M3: {
    name: 'M3',
    file: W,
    test: 'clean-run',
    edits: [
      {
        file: DELETE,
        find: 'if (!sameLeafPost(want, fs.lstatSync(r, { bigint: true }))) throw misplaced',
        replace: 'if (!sameLeafPre(want, fs.lstatSync(r, { bigint: true }))) throw misplaced',
      },
    ],
  },
  M4: {
    name: 'M4',
    file: 'prune.mjs',
    test: 'guard',
    // The walk in the parent process. Since PR-17 the walk is module-private and
    // the deletion walk checks it runs under the walker entry, so the mutant must
    // re-export the walk and drop both entry checks, as an in-process regression
    // would have to.
    edits: [
      {
        file: W,
        find: 'function stageVerifyDelete(job) {',
        replace: 'export function stageVerifyDelete(job) {',
      },
      {
        file: W,
        find: "  if (!IS_ENTRY || process.env.SKILLSMITH_PRUNE_WALKER !== '1') {",
        replace: "  if (process.env.SKILLSMITH_PRUNE_WALKER !== '1') {",
      },
      {
        file: DELETE,
        find: "  if (!IN_WALKER_CHILD || process.env.SKILLSMITH_PRUNE_WALKER !== '1') {",
        replace: "  if (process.env.SKILLSMITH_PRUNE_WALKER !== '1') {",
      },
      {
        find: "import { encodeJob } from './prune.job.mjs'",
        replace:
          "import { encodeJob } from './prune.job.mjs'\nimport { stageVerifyDelete as inProc } from './prune.walk.mjs'",
      },
      {
        find: '  const args = [...(walker.execArgv ?? []), walker.path ?? DEFAULT_WALKER]',
        replace:
          "  if (!walker.path) { process.env.SKILLSMITH_PRUNE_WALKER = '1'; return JSON.parse(JSON.stringify(inProc(job), (k, v) => (typeof v === 'bigint' ? String(v) : v))) }\n  const args = [...(walker.execArgv ?? []), walker.path ?? DEFAULT_WALKER]",
      },
    ],
  },
  M5: {
    name: 'M5',
    file: W,
    test: 'P1-pre-verify (linux bind)',
    edits: [
      {
        file: VERIFY,
        find: "  const mi = mountFinding(leafPath)\n  if (mi !== null) return no('mount-in-staging', mi)\n",
        replace: '',
      },
    ],
  },
  M6: { name: 'M6', file: W, test: 'T10', edits: [SIDECAR_BYTES_CMP] },
  M7: { name: 'M7', file: W, test: 'T15', edits: [MISPLACE_RESULT] },
  M8: { name: 'M8', file: W, test: 'P9-trace', edits: [MISPLACE_REVERT] },
}
