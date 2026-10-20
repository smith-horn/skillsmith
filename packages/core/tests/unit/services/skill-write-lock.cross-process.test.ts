/**
 * SMI-6531 (A1 step 2): lock 1 across processes. The lock-level halves of
 * T-L6 (a second writer does nothing until the first is out), T-L12 (writers
 * with different HOMEs and state roots never overlap) and T-L14 (a symlinked
 * spelling of the root shares the lock).
 *
 * Child A takes lock 1 and opens a mutation window (a file). Child B, started
 * once A is inside, tries lock 1 with a short wait: it must end `busy` without
 * running its function. After A closes the window and releases, B's second
 * attempt takes the lock and finds the window closed and A's work done.
 *
 * Control ("nolock"): the same two children with no lock at all. B's function
 * then runs while A's window is open, which proves the children can observe an
 * overlap and that the lock is what removes it.
 *
 * The children rendezvous through marker files and import the SOURCE modules.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const childPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'skill-write-lock.child.mjs'
)

interface Attempt {
  ran: boolean
  value?: { windowOpen: boolean; aDone: boolean } | string
  busy?: string
  reason?: string
}
interface ChildOut {
  role: 'A' | 'B'
  mode: string
  result?: Attempt
  first?: Attempt
  second?: Attempt
}

let base: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-xproc-')))
})
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

function spawnChild(
  role: 'A' | 'B',
  root: string,
  markers: string,
  mode: 'lock' | 'nolock',
  home: string
): Promise<ChildOut> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', childPath, role, root, markers, mode],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, USERPROFILE: home },
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`child ${role} exited ${code}:\n${stderr}`))
      resolve(JSON.parse(stdout.trim().split('\n').pop() ?? '') as ChildOut)
    })
  })
}

/** A holds `rootA`; B arrives through `rootB`; each child has its own HOME. */
async function scenario(rootA: string, rootB: string, mode: 'lock' | 'nolock') {
  const markers = path.join(base, 'markers')
  fs.mkdirSync(markers)
  const homeA = path.join(base, 'home-a')
  const homeB = path.join(base, 'home-b')
  fs.mkdirSync(homeA)
  fs.mkdirSync(homeB)
  const [a, b] = await Promise.all([
    spawnChild('A', rootA, markers, mode, homeA),
    spawnChild('B', rootB, markers, mode, homeB),
  ])
  return { a, b }
}

function setup(): { root: string; link: string } {
  const root = path.join(base, 'skills')
  fs.mkdirSync(root)
  const link = path.join(base, 'skills-link')
  fs.symlinkSync(root, link)
  return { root, link }
}

describe('T-L6 / T-L12 (lock level): writers with different HOMEs never overlap', () => {
  it('B ends busy without running while A is inside, then runs only after A is done', async () => {
    const { root } = setup()
    const { a, b } = await scenario(root, root, 'lock')
    expect(a.result).toMatchObject({ ran: true })
    // First attempt: the lock was held, so B waited out its 400 ms and ran NOTHING.
    expect(b.first).toEqual({ ran: false, busy: 'busy', reason: 'held' })
    // Second attempt: B ran, and A's window was already closed and A's work done.
    expect(b.second).toEqual({ ran: true, value: { windowOpen: false, aDone: true } })
    expect(fs.existsSync(path.join(root, '.skillsmith-writes.lock'))).toBe(false)
  }, 60_000)

  it('control: with no lock the same B runs inside A’s window', async () => {
    const { root } = setup()
    const { b } = await scenario(root, root, 'nolock')
    expect(b.first).toEqual({ ran: true, value: { windowOpen: true, aDone: false } })
  }, 60_000)
})

describe('T-L14 (lock level): a symlinked spelling of the root is excluded too', () => {
  it('B through the symlink ends busy while A, through the real path, is inside', async () => {
    const { root, link } = setup()
    const { b } = await scenario(root, link, 'lock')
    expect(b.first).toEqual({ ran: false, busy: 'busy', reason: 'held' })
    expect(b.second).toEqual({ ran: true, value: { windowOpen: false, aDone: true } })
  }, 60_000)

  it('the other way round: A through the symlink, B through the real path', async () => {
    const { root, link } = setup()
    const { b } = await scenario(link, root, 'lock')
    expect(b.first).toEqual({ ran: false, busy: 'busy', reason: 'held' })
    expect(b.second).toEqual({ ran: true, value: { windowOpen: false, aDone: true } })
  }, 60_000)
})
