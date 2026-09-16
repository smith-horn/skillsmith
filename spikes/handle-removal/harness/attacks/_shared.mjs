// Shared fixture/attack helpers for the C0 control's A3-A6 and N1 cells.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  rmSync,
  renameSync,
  symlinkSync,
  linkSync,
} from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

/**
 * (dev, ino, birthtimeNs) for a path, or null if it doesn't exist. bigint
 * precision throughout, matching c0-walk.mjs's own identity source -- a
 * float birthtimeMs comparison here would be a weaker instrument than the
 * mechanism actually being tested.
 */
export function statId(absPath) {
  try {
    const st = lstatSync(absPath, { bigint: true })
    return { dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs }
  } catch {
    return null
  }
}

/** Writes a flat map of {relPath: content} under `dir`, creating parents. */
export function writeFileTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
}

/**
 * Builds the standard fixture shape used by A3-A6: a tree root containing an
 * inert sibling directory (so the walk has more than one child, matching
 * "replaced dir as first entry" -- the target sorts first) and a `target`
 * directory that the attack will swap out.
 *
 *   <treeRoot>/
 *     target/        <- the directory an attack swaps
 *       orig-f1
 *     zzz-sibling/
 *       f1
 *
 * Returns absolute paths and the target's pre-swap identity.
 */
export function buildSwapFixture(root) {
  const treeRoot = path.join(root, 'tree')
  writeFileTree(treeRoot, {
    'target/orig-f1': 'original-content-f1',
    'zzz-sibling/f1': 'sibling-content',
  })
  const targetAbs = path.join(treeRoot, 'target')
  return { treeRoot, targetAbs, targetRelFromRoot: 'target' }
}

/**
 * Deletes `targetAbs` and immediately recreates it with fresh "replacement"
 * (would-be-user) content, as fast as fully-synchronous Node calls allow --
 * this is what the plan calls "same-tick": no scheduling gap, just the
 * fastest sequence of syscalls this process can issue. Returns whether the
 * OS reused the directory's (dev, ino) -- and, incidentally, whether it also
 * reused/collided the birthtime, which is the E47 phenomenon the UD25 gate
 * exists to catch.
 */
export function swapDirectorySameTick(targetAbs, replacementFiles) {
  const before = statId(targetAbs)
  rmSync(targetAbs, { recursive: true, force: true })
  mkdirSync(targetAbs)
  writeFileTree(targetAbs, replacementFiles)
  const after = statId(targetAbs)
  const reuseObserved = !!(before && after && before.dev === after.dev && before.ino === after.ino)
  const birthtimeReused = !!(
    before &&
    after &&
    before.birthtimeNs === after.birthtimeNs &&
    before.birthtimeNs != null
  )
  return { reuseObserved, birthtimeReused, before, after }
}

/**
 * Renames `targetAbs` aside (simulating "renamed aside and replaced" -- A3),
 * then creates a fresh replacement directory at the original path with new
 * content. Unlike swapDirectorySameTick, this does not delete first, so it
 * does not depend on inode reuse at all -- a plain identity check should
 * already catch it.
 */
export function renameAsideAndReplace(targetAbs, replacementFiles) {
  const asideName = `${targetAbs}.aside-${crypto.randomBytes(4).toString('hex')}`
  renameSync(targetAbs, asideName)
  mkdirSync(targetAbs)
  writeFileTree(targetAbs, replacementFiles)
  return { asideName }
}

/**
 * Verifies that every file in `expectedFiles` (relPath -> expected content,
 * relative to `dir`) is still present unchanged. Returns the §9 userFiles
 * shape: {checked, lost, changed}.
 */
export function verifyReplacementIntact(dir, expectedFiles) {
  let lost = 0
  let changed = 0
  const checked = Object.keys(expectedFiles).length
  for (const [rel, expected] of Object.entries(expectedFiles)) {
    const abs = path.join(dir, rel)
    if (!existsSync(abs)) {
      lost += 1
      continue
    }
    const actual = readFileSync(abs, 'utf8')
    if (actual !== expected) {
      changed += 1
    }
  }
  return { checked, lost, changed }
}

export function randomToken() {
  return crypto.randomBytes(6).toString('hex')
}

/**
 * Same-tick delete+recreate for a single FILE (not a directory) -- A7's
 * substitution technique. Returns the same reuse-observation shape as
 * swapDirectorySameTick, applied to a leaf file.
 */
export function swapFileSameTick(fileAbs, newContent) {
  const before = statId(fileAbs)
  rmSync(fileAbs, { force: true })
  writeFileSync(fileAbs, newContent, 'utf8')
  const after = statId(fileAbs)
  const reuseObserved = !!(before && after && before.dev === after.dev && before.ino === after.ino)
  return { reuseObserved, before, after }
}

/**
 * Fixture for A8 (symlink swaps): a real directory outside the tree (so
 * "outside bytes lost" is checkable), a `target` dir the walk will descend
 * into, and a `link` entry that is itself a symlink to an outside file. Also
 * builds a sibling so the walk has more than one child.
 *
 *   <root>/
 *     outside/outside-marker.txt   <- never inside the tree
 *     tree/
 *       target/orig-f1
 *       link -> ../../outside/outside-marker.txt
 *       zzz-sibling/f1
 */
export function buildSymlinkFixture(root) {
  const outsideDir = path.join(root, 'outside')
  mkdirSync(outsideDir, { recursive: true })
  const outsideMarker = path.join(outsideDir, 'outside-marker.txt')
  writeFileSync(outsideMarker, 'outside-content', 'utf8')

  const treeRoot = path.join(root, 'tree')
  writeFileTree(treeRoot, {
    'target/orig-f1': 'original-content-f1',
    'zzz-sibling/f1': 'sibling-content',
  })
  const linkAbs = path.join(treeRoot, 'link')
  symlinkSync(outsideMarker, linkAbs)

  return {
    treeRoot,
    targetAbs: path.join(treeRoot, 'target'),
    linkAbs,
    outsideDir,
    outsideMarker,
  }
}

/**
 * Fixture for A10(b)/A11: a real file outside the tree, hard-linked from
 * inside the tree. unlink(2) removes one name, not the underlying inode's
 * data while any other link exists -- the property both attacks check.
 */
export function buildHardlinkFixture(root) {
  const outsideDir = path.join(root, 'outside')
  mkdirSync(outsideDir, { recursive: true })
  const outsideFile = path.join(outsideDir, 'shared-data.txt')
  writeFileSync(outsideFile, 'shared-outside-content', 'utf8')

  const treeRoot = path.join(root, 'tree')
  writeFileTree(treeRoot, {
    'target/orig-f1': 'original-content-f1',
    'zzz-sibling/f1': 'sibling-content',
  })
  const hardlinkAbs = path.join(treeRoot, 'target', 'hardlinked-file')
  linkSync(outsideFile, hardlinkAbs)

  return { treeRoot, targetAbs: path.join(treeRoot, 'target'), outsideFile, hardlinkAbs }
}

/**
 * Verifies a single outside path (file or dir tree) is unchanged: exists,
 * and for a file, its content matches. Returns the same {checked, lost,
 * changed} shape as verifyReplacementIntact so it composes with the same
 * classifier.
 */
export function verifyOutsideIntact(outsidePath, expectedContent) {
  if (!existsSync(outsidePath)) return { checked: 1, lost: 1, changed: 0 }
  if (expectedContent === undefined) return { checked: 1, lost: 0, changed: 0 }
  const actual = readFileSync(outsidePath, 'utf8')
  return { checked: 1, lost: 0, changed: actual === expectedContent ? 0 : 1 }
}

/**
 * Wraps a loaded native shim's statAt so every call's returned key set is
 * recorded -- the direct, runtime check behind A9's "no timestamp field
 * read" assertion (statAt's own C implementation never copies a time field
 * into the JS-facing result; this confirms that at the actual call site
 * rather than trusting the source read). Returns {restore, keysSeen}: a
 * Set that accumulates every key name observed across every call for the
 * duration this wrapper is installed.
 */
export function wrapStatAtFieldLog(shim) {
  const original = shim.statAt
  const keysSeen = new Set()
  shim.statAt = (...args) => {
    const result = original(...args)
    for (const k of Object.keys(result)) keysSeen.add(k)
    return result
  }
  return {
    keysSeen,
    restore() {
      shim.statAt = original
    },
  }
}

const TIME_FIELD_PATTERN = /time|mtime|atime|ctime|birthtime|crtime/i

/** True if any key in `keysSeen` looks like a timestamp field. */
export function anyTimeFieldSeen(keysSeen) {
  return [...keysSeen].some((k) => TIME_FIELD_PATTERN.test(k))
}

/**
 * A9(a) "clock stub": monkeypatches node:fs's lstatSync/statSync (the same
 * shared module object c0-walk.mjs itself imports -- Node's module cache is
 * process-wide, so reassigning a method here is visible there too) so that
 * exactly one path reports a caller-supplied birthtimeNs instead of its real
 * one, for the duration of `fn()`. This only affects C0 (which reads
 * fs.lstatSync directly); VR's native shim issues raw syscalls in C and is
 * structurally unreachable by this -- which is itself the point of running
 * this same helper against both and observing the difference.
 *
 * @param {import('node:fs')} fsModule
 * @param {string} stubbedPath - exact absolute path to intercept
 * @param {bigint} fakeBirthtimeNs
 * @param {() => any} fn
 */
export function withStubbedBirthtime(fsModule, stubbedPath, fakeBirthtimeNs, fn) {
  const origLstatSync = fsModule.lstatSync
  const wrap = (orig) =>
    function stubbedStat(p, opts) {
      const real = orig(p, opts)
      if (path.resolve(String(p)) !== path.resolve(stubbedPath)) return real
      // Only fabricate the field under test; every other field stays real so
      // this can't accidentally mask an unrelated identity mismatch.
      const proxy = new Proxy(real, {
        get(target, prop) {
          if (prop === 'birthtimeNs') return fakeBirthtimeNs
          return target[prop]
        },
      })
      return proxy
    }
  fsModule.lstatSync = wrap(origLstatSync)
  try {
    return fn()
  } finally {
    fsModule.lstatSync = origLstatSync
  }
}

/**
 * Wraps a loaded native shim's `fnName` so the very next call matching
 * `matchFn(args)` returns `{errno: injectedErrno}` instead of executing --
 * A12's real-cause requirement doesn't apply to the injected error itself
 * (the plan calls for a "stubbed shim/fs" here explicitly), but everything
 * downstream of the injection (the walk's stop-rule handling, what's left on
 * disk) is exercised for real. Fires at most once, then transparently
 * delegates. Restores the original method when `restore()` is called.
 */
export function injectErrnoOnce(shim, fnName, matchFn, injectedErrno) {
  const original = shim[fnName]
  let fired = false
  shim[fnName] = (...args) => {
    if (!fired && matchFn(args)) {
      fired = true
      return { errno: injectedErrno }
    }
    return original(...args)
  }
  return {
    get fired() {
      return fired
    },
    restore() {
      shim[fnName] = original
    },
  }
}

/**
 * Like injectErrnoOnce, but wraps SEVERAL shim methods sharing one "fired"
 * flag -- whichever of them is actually called first for the matching entry
 * gets intercepted, and the rest stay real. Needed because V0/V1's first
 * touch on an entry is unlinkAt, while V2's is renameAtNoReplace (into
 * quarantine) -- the plan's "EACCES at an unlink" needs to land at each
 * variant's OWN structurally-first removal syscall for a fair, uniform test
 * across all three, not just literally on the one V0/V1 happen to use.
 */
export function injectErrnoOnceAcrossFns(shim, fnNames, matchFn, injectedErrno) {
  const originals = new Map(fnNames.map((n) => [n, shim[n]]))
  let fired = false
  for (const fnName of fnNames) {
    const original = originals.get(fnName)
    shim[fnName] = (...args) => {
      if (!fired && matchFn(fnName, args)) {
        fired = true
        return { errno: injectedErrno }
      }
      return original(...args)
    }
  }
  return {
    get fired() {
      return fired
    },
    restore() {
      for (const [fnName, original] of originals) shim[fnName] = original
    },
  }
}

/**
 * C0's analogue of injectErrnoOnce: monkeypatches a node:fs function (e.g.
 * rmdirSync, unlinkSync -- the same shared module object c0-walk.mjs itself
 * imports, per the module-cache reasoning in withStubbedBirthtime) so the
 * next call matching `matchFn(args)` throws a real Error carrying `.code`,
 * instead of executing. A12's "stubbed shim/fs" is explicit plan language --
 * the injected error itself doesn't need a real cause, only the walk's
 * handling of it does.
 */
export function injectFsErrnoOnce(fsModule, fnName, matchFn, code) {
  const original = fsModule[fnName]
  let fired = false
  fsModule[fnName] = (...args) => {
    if (!fired && matchFn(args)) {
      fired = true
      throw Object.assign(new Error(code), { code })
    }
    return original(...args)
  }
  return {
    get fired() {
      return fired
    },
    restore() {
      fsModule[fnName] = original
    },
  }
}

/**
 * A13's real concurrent racer: spawns a genuinely separate Node process
 * (child_process.spawn, not a hook) that attempts ONE randomly-chosen
 * mutation (A3/A5/A7/A8-shaped) against `targetAbs` after a small randomized
 * delay, racing the caller's own removal with no synchronization at all
 * beyond a single startup rendezvous -- "none (real concurrency)" per the
 * plan; the rendezvous exists only to make the race actually competitive
 * (see below), not to coordinate the mutation's timing relative to the
 * walk. The child tolerates its target already being gone (ENOENT) since
 * the parent's walk may win the race outright; that is an expected,
 * not-a-bug outcome of real concurrency, and is recorded in the returned
 * promise's result rather than treated as a spawn failure.
 *
 * MEASURED, not assumed: a first draft with no rendezvous raced a fresh
 * Node process's own startup (fork+exec+module init, several ms) against a
 * synchronous in-process walk over a 2-file fixture (well under 1ms) --
 * 20/20 runs measured the racer losing every time (ENOENT), which is not a
 * real test of concurrent mutation, only of process-spawn latency. The
 * caller now blocks synchronously (a tight fs.existsSync poll, not a timer)
 * until the child writes a marker file confirming it is alive and about to
 * enter its OWN busy-wait, before calling its own synchronous removal --
 * this keeps the actual race (the child's 0-2ms jitter vs. the walk's own
 * duration) the deciding factor, not Node's process-startup cost.
 *
 * @param {string} targetAbs - absolute path to the directory to race against
 * @param {string} readyMarkerPath - a path the child touches the instant it
 *   is alive, before its jittered busy-wait -- the caller must synchronously
 *   wait for this file to exist before starting its own removal.
 * @returns {{wait: () => void, result: Promise<{applied:string|null, error:string|null}>}}
 */
export function spawnConcurrentRacer(targetAbs, readyMarkerPath) {
  // The `now()` timestamps below are `process.hrtime.bigint()` in
  // milliseconds: the SYSTEM monotonic clock (CLOCK_MONOTONIC on Linux,
  // mach time on macOS), whose origin is the boot, not this process. That is
  // what makes them comparable with the parent's own timestamps and lets
  // a13-vr.mjs place a landed mutation before, during or after the guard pass
  // instead of inferring it.
  //
  // `performance.timeOrigin + performance.now()` was tried first and is
  // WRONG for this: timeOrigin is calibrated per process, so a child measured
  // its own marker write AFTER the parent observed the file -- 8 of 8 runs on
  // the first smoke test, an impossible ordering, which is exactly what the
  // parent's clockSkewCheckMs assertion exists to catch. Do not switch back.
  const script = `
    const fs = require('node:fs');
    const now = () => Number(process.hrtime.bigint()) / 1e6;
    const target = process.argv[1];
    const delayMs = Number(process.argv[2]);
    const mutation = process.argv[3];
    const readyMarker = process.argv[4];
    // Timestamped BEFORE the write, not after: the parent's tight poll can
    // see the file the instant writeFileSync returns, which is microseconds
    // BEFORE a now() placed on the next line would run -- that ordering made
    // the parent's clockSkewCheckMs look negative in 22 of 23 smoke runs and
    // was read as a clock-comparability failure when it was a placement bug.
    // Taken here, markerWrittenAt <= markerObservedAt holds by construction,
    // so a negative value really does mean the clocks disagree.
    const markerWrittenAt = now();
    fs.writeFileSync(readyMarker, '1');
    const start = Date.now();
    while (Date.now() - start < delayMs) { /* busy-wait: real jitter, no timer overhead */ }
    const mutationStartedAt = now();
    try {
      let writtenContent = null;
      let writtenPath = null;
      if (mutation === 'a5') {
        writtenContent = 'racer-replacement-' + Date.now() + '-' + Math.random();
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target);
        writtenPath = target + '/orig-f1';
        fs.writeFileSync(writtenPath, writtenContent);
      } else if (mutation === 'a3') {
        writtenContent = 'racer-replacement-' + Date.now() + '-' + Math.random();
        const aside = target + '.aside-' + Math.random().toString(16).slice(2);
        fs.renameSync(target, aside);
        fs.mkdirSync(target);
        writtenPath = target + '/orig-f1';
        fs.writeFileSync(writtenPath, writtenContent);
      } else if (mutation === 'a7') {
        writtenContent = 'racer-substitute-' + Date.now() + '-' + Math.random();
        writtenPath = target + '/orig-f1';
        fs.rmSync(writtenPath, { force: true });
        fs.writeFileSync(writtenPath, writtenContent);
      } else if (mutation === 'a8') {
        fs.rmSync(target, { recursive: true, force: true });
        fs.symlinkSync('/tmp', target);
        writtenPath = target;
      }
      process.stdout.write(
        JSON.stringify({
          applied: mutation, error: null, writtenPath, writtenContent,
          markerWrittenAt, mutationStartedAt, landedAt: now(), delayMs,
        })
      );
    } catch (err) {
      process.stdout.write(JSON.stringify({
        applied: null, error: err.code || String(err),
        markerWrittenAt, mutationStartedAt, landedAt: now(), delayMs,
      }));
    }
  `
  const mutations = ['a3', 'a5', 'a7', 'a8']
  const mutation = mutations[Math.floor(Math.random() * mutations.length)]
  const delayMs = Math.floor(Math.random() * 3)
  const child = spawn(
    process.execPath,
    ['-e', script, '--', targetAbs, String(delayMs), mutation, readyMarkerPath],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  let out = ''
  const result = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('close', () => {
      try {
        resolve(JSON.parse(out))
      } catch {
        resolve({ applied: null, error: 'child-output-unparseable' })
      }
    })
    child.on('error', (err) => resolve({ applied: null, error: err.message }))
  })
  return {
    /**
     * Blocks synchronously (tight poll, not a timer) until the child confirms
     * it is alive. Returns the moment the marker was OBSERVED, on the parent's
     * own clock -- the caller pairs it with the child's `markerWrittenAt` to
     * check the two processes' clocks agree before trusting any cross-process
     * ordering derived from them.
     */
    wait(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (!existsSync(readyMarkerPath) && Date.now() < deadline) {
        /* tight poll -- deliberately not a timer, to not yield the event loop */
      }
      return Number(process.hrtime.bigint()) / 1e6
    },
    result,
  }
}
