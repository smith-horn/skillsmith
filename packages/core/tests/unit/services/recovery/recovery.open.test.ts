/**
 * SMI-6531 (A1 step 6a-ii): T-J14's file-open boundaries. Doctor is killed
 * between a file's open and its first write, at every file it opens for
 * writing through `fs.promises.open` (sidecar temps, the sidecar rewrite's
 * temp, the manifest temp, the journal), then the same action runs again.
 *
 * The boundaries are generated from the opens an uninterrupted run makes (a
 * pass-through spy records each write-intent open), and each is killed by
 * making that handle's first `write`/`appendFile` throw: the file exists,
 * empty, as a kill there leaves it. The manifest temp's own catch removes it
 * (a throw is not a SIGKILL), so for that open the case also plants the empty
 * temp a real kill would leave, and requires the rerun to leave it untouched.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashOf, makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import { keepTree, s0, s1, s2, s3, un1, un2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, areaNames, auditLines, done, entryOf, keptTrees } from './recovery.act.helpers.js'

useTmpCleanup()

const promises = fs.promises
const realOpen = promises.open.bind(promises)

afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

const writes = (flags: unknown): boolean =>
  typeof flags === 'string'
    ? /[wax+]/.test(flags)
    : typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0

/** Spies on `fs.promises.open`: records write-intent opens; the `kill`-th one's first write throws. */
function spyOpens(kill: number | null): string[] {
  const opened: string[] = []
  vi.spyOn(promises, 'open').mockImplementation((async (
    p: fs.PathLike,
    flags?: unknown,
    mode?: unknown
  ) => {
    const fh = await realOpen(p, flags as fs.OpenMode, mode as fs.Mode)
    // Lock files and their reclaim claims are the lock protocol's, not doctor's files.
    if (!writes(flags) || /\.lock(\.reclaim)?$/.test(String(p))) return fh
    opened.push(String(p))
    if (kill !== null && opened.length === kill) {
      const boom = async (): Promise<never> => {
        throw new Error(`killed after opening ${String(p)}`)
      }
      Object.assign(fh, { write: boom, appendFile: boom, writeFile: boom })
    }
    return fh
  }) as typeof promises.open)
  syncBuiltinESMExports()
  return opened
}

function endState(st: State) {
  return {
    skill: hashOf(st.fx.realDir),
    entry: entryOf(st.fx),
    kept: keptTrees(st.fx),
    area: areaNames(st.fx),
    opDir: fs.existsSync(st.opDir),
    audit: auditLines(st.fx, st.opId),
  }
}

/** S3 with O's keep at P1 and O edited: the resume opens the rewrite's temp. */
async function p1Changed(fx: ReturnType<typeof makeFixture>): Promise<State> {
  const st = await s3(fx)
  keepTree(st, 'old', 'backup', { move: false })
  fs.writeFileSync(path.join(st.opDir, 'old', 'SKILL.md'), '# O edited\n')
  return st
}

type Build = (fx: ReturnType<typeof makeFixture>) => Promise<State>
const ROWS: Array<[string, Build, 'apply' | 'undo']> = [
  ['S0', s0, 'apply'],
  ['S1', s1, 'apply'],
  ['S1', s1, 'undo'],
  ['S2', s2, 'apply'],
  ['S2', s2, 'undo'],
  ['S3', s3, 'apply'],
  ['UN1', un1, 'apply'],
  ['UN2', un2, 'apply'],
  ['S3 P1 rewrite', p1Changed, 'apply'],
]

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })
const seen = new Set<string>()

describe('T-J14: killed between a file open and its first write, the same command resumes', () => {
  for (const [name, build, action] of ROWS) {
    it(`${name} --${action}: every write-intent open`, async () => {
      const ref = await build(file())
      const opened = spyOpens(null)
      await done(ref, action)
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      const want = endState(ref)
      expect(opened.length).toBeGreaterThan(0)
      for (let n = 1; n <= opened.length; n++) {
        const kind = classify(opened[n - 1]!)
        seen.add(kind)
        const st = await build(file())
        const live = spyOpens(n)
        const first = await act(st, action)
        vi.restoreAllMocks()
        syncBuiltinESMExports()
        expect(first.result.status, `${kind} #${n}`).toBe('stopped')
        const left = live[n - 1]!
        let planted: string | null = null
        if (kind === 'manifest-temp') {
          // A SIGKILL here leaves the empty temp the write's own catch removed.
          expect(fs.existsSync(left)).toBe(false)
          fs.writeFileSync(left, '')
          planted = left
        } else {
          expect(fs.statSync(left).size, `${kind} #${n} left empty`).toBe(0)
        }
        const again = await act(st, action)
        expect(
          again.result.status,
          `${kind} #${n}: ${JSON.stringify(again.result).slice(0, 300)}`
        ).toBe('done')
        expect(endState(st), `${kind} #${n}`).toEqual(want)
        if (planted !== null) expect(fs.statSync(planted).size).toBe(0)
      }
    })
  }

  it('the boundaries reached include every kind of file doctor opens for writing', () => {
    expect([...seen].sort()).toEqual(['journal', 'manifest-temp', 'sidecar-temp'])
  })
})

/** What kind of file an open created. */
function classify(p: string): string {
  if (p.endsWith('.json.tmp')) return 'sidecar-temp'
  if (path.basename(p).startsWith('manifest.json.tmp.')) return 'manifest-temp'
  if (p.endsWith('journal.jsonl')) return 'journal'
  return `other:${p}`
}
