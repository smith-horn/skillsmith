/**
 * SMI-6771 — three-way test of the shared probe-path classifier (present /
 * absent / unreachable) and its `requirePresence` gate helper.
 *
 * The 'present' and 'absent' arms exercise `probePath` in-process against a
 * real fixture -- no privilege games needed, since both are ordinary
 * `ENOENT`-or-not outcomes any uid can produce.
 *
 * The 'unreachable' arm cannot be produced in-process as root: POSIX
 * `stat()` needs search (x) permission on the path's PREFIX, and root
 * bypasses that check entirely (CAP_DAC_OVERRIDE), so an in-process probe
 * under uid 0 against a child of a mode-000 directory returns 'present',
 * never 'unreachable' -- this dev container and CI both run as root
 * (confirmed via `process.getuid()`). To observe a real EACCES this test
 * drops privileges via `spawnSync`'s `uid`/`gid` options (65534 = nobody)
 * and re-derives the SAME ENOENT-vs-other classification inline, as a
 * `node -e` one-liner (the dropped-privilege child can't import this file's
 * own ESM module without a loader, and the classification itself is two
 * lines). A uid-0 in-process probe against the mode-000 child returning
 * 'present' is asserted FIRST, as a harness sanity check: if a future
 * runner is ever non-root, that assertion fails by naming the observed uid
 * rather than silently exercising the wrong arm below it.
 *
 * `probePath`'s own ENOENT-vs-other branch is additionally pinned directly,
 * with an injected fake `stat` that throws a manufactured error -- this
 * covers the EACCES branch deterministically on every machine, root or not,
 * without depending on the OS actually producing one.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { probePath, requirePresence } from './probe-path.js'

function withTempDir(prefix: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('probePath (SMI-6771)', () => {
  it('present: a real, freshly-staged file', () => {
    withTempDir('probe-path-present-', (dir) => {
      const file = join(dir, 'staged.txt')
      writeFileSync(file, 'x')
      expect(probePath(file)).toBe('present')
    })
  })

  it('absent: a path that was never created', () => {
    withTempDir('probe-path-absent-', (dir) => {
      expect(probePath(join(dir, 'never-created.txt'))).toBe('absent')
    })
  })

  it('unreachable: a child of a mode-000 directory, observed under a dropped-privilege probe', () => {
    withTempDir('probe-path-unreachable-', (dir) => {
      const blocked = join(dir, 'blocked')
      mkdirSync(blocked)
      const target = join(blocked, 'child.txt')
      writeFileSync(target, 'x')

      try {
        chmodSync(blocked, 0o000)
        const isRoot = process.getuid?.() === 0

        if (isRoot) {
          // Harness sanity check, not a claim about probePath's own
          // correctness: root bypasses the directory-traversal permission
          // bit entirely, so this in-process probe MUST see 'present'. If
          // it ever doesn't, this test's own root assumption -- not
          // probePath -- is what broke, and this assertion names that.
          expect(probePath(target), `process.getuid()=${process.getuid?.()}`).toBe('present')
        }

        const classify =
          "const fs=require('fs');" +
          'try{fs.statSync(process.argv[1]);console.log("present")}' +
          'catch(e){console.log(e&&e.code==="ENOENT"?"absent":"unreachable")}'
        const result = spawnSync(
          process.execPath,
          ['-e', classify, target],
          isRoot ? { uid: 65534, gid: 65534, encoding: 'utf8' } : { encoding: 'utf8' }
        )
        expect(result.status, result.stderr ?? '(no stderr)').toBe(0)
        expect(result.stdout.trim()).toBe('unreachable')

        if (!isRoot) {
          // A non-root harness observes the same EACCES in-process, so
          // probePath itself can be asserted directly here too.
          expect(probePath(target)).toBe('unreachable')
        }
      } finally {
        chmodSync(blocked, 0o755)
      }
    })
  })

  describe('ENOENT-vs-other classification, direct (injectable stat, root-independent)', () => {
    it('ENOENT -> absent', () => {
      const err = Object.assign(new Error('nope'), { code: 'ENOENT' })
      expect(
        probePath('/does/not/matter', () => {
          throw err
        })
      ).toBe('absent')
    })

    it('EACCES -> unreachable', () => {
      const err = Object.assign(new Error('nope'), { code: 'EACCES' })
      expect(
        probePath('/does/not/matter', () => {
          throw err
        })
      ).toBe('unreachable')
    })

    it('ENOTDIR -> unreachable', () => {
      const err = Object.assign(new Error('nope'), { code: 'ENOTDIR' })
      expect(
        probePath('/does/not/matter', () => {
          throw err
        })
      ).toBe('unreachable')
    })

    it('a thrown value with no .code -> unreachable, never silently absent', () => {
      expect(
        probePath('/does/not/matter', () => {
          throw new Error('weird, no code')
        })
      ).toBe('unreachable')
    })

    it('stat succeeding -> present', () => {
      expect(probePath('/does/not/matter', () => ({}))).toBe('present')
    })
  })
})

describe('requirePresence (SMI-6771)', () => {
  it("'present' -> true", () => {
    expect(requirePresence('present', 'x')).toBe(true)
  })

  it("'absent' -> false (the legitimate skip case)", () => {
    expect(requirePresence('absent', 'x')).toBe(false)
  })

  it("'unreachable' -> throws, naming the caller's label", () => {
    expect(() => requirePresence('unreachable', 'my-gate-under-test')).toThrow(/my-gate-under-test/)
  })
})

// Confirms the harness's own root assumption is live, independent of the
// 'unreachable' test above -- kept as a separate top-level check so a CI
// runner that ever changes this loudly reports which arm it affects instead
// of the 'unreachable' test failing with no context.
describe('harness assumption: this process runs as root (SMI-6771)', () => {
  it('process.getuid() is 0, or this file documents why not', () => {
    const uid = process.getuid?.()
    expect(uid, 'process.getuid() -- expected 0 in this dev container and CI').toBe(0)
  })

  it('uid 65534 (nobody) is resolvable for the dropped-privilege spawn above', () => {
    // getent is not present on every minimal image; fall back to a direct
    // spawnSync probe of the uid itself, which is what the test above
    // actually depends on.
    const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      uid: 65534,
      gid: 65534,
    })
    expect(result.status, result.stderr?.toString() ?? '(no stderr)').toBe(0)
  })
})

// Sanity: `node -e` itself is reachable via execFileSync the same way the
// dropped-privilege spawnSync path above invokes it, ruling out "the
// classify script never even ran" as a silent explanation for a passing
// 'unreachable' assertion.
describe('classify script harness sanity (SMI-6771)', () => {
  it('the inline classify script reports "present" for an ordinary reachable file', () => {
    withTempDir('probe-path-classify-sanity-', (dir) => {
      const file = join(dir, 'ok.txt')
      writeFileSync(file, 'x')
      const out = execFileSync(
        process.execPath,
        [
          '-e',
          "const fs=require('fs');try{fs.statSync(process.argv[1]);console.log('present')}" +
            "catch(e){console.log(e&&e.code==='ENOENT'?'absent':'unreachable')}",
          file,
        ],
        { encoding: 'utf8' }
      )
      expect(out.trim()).toBe('present')
    })
  })
})
