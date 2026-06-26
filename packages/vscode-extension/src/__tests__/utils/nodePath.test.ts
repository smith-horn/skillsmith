/**
 * Unit tests for src/utils/nodePath.ts (SMI-5398).
 *
 * Key coverage:
 *  - resolveNvmBin: concrete version → bin dir; symbolic ref → undefined; missing → undefined
 *  - whichOnPath: first X_OK hit; undefined on miss; win32 .cmd/.exe suffixes tried
 *  - buildAugmentedPath: login-shell PATH → node-manager dirs → env PATH, deduped
 *  - Single-flight (P-5): concurrent resolveLoginShellPath / resolveWindowsPath spawn once
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as os from 'node:os'
import * as path from 'node:path'

// ── fs mock ───────────────────────────────────────────────────────────────────
const readFileSyncMock = vi.fn()
const accessSyncMock = vi.fn()
const existsSyncMock = vi.fn()

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: readFileSyncMock,
    accessSync: accessSyncMock,
    existsSync: existsSyncMock,
  }
})

// ── cross-spawn mock ──────────────────────────────────────────────────────────
const spawnMock = vi.fn()
vi.mock('cross-spawn', () => ({ default: spawnMock }))

// ── child process helpers ────────────────────────────────────────────────────
interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  kill: () => void
}

function makeShellChild(output: string): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.stdout = new EventEmitter()
  c.kill = vi.fn()
  queueMicrotask(() => {
    c.stdout.emit('data', Buffer.from(output, 'utf8'))
    c.emit('exit', 0)
  })
  return c
}

function makeHungChild(): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.stdout = new EventEmitter()
  c.kill = vi.fn()
  // never emits exit/error — simulates a hung shell
  return c
}

// ── resolveNvmBin ─────────────────────────────────────────────────────────────
describe('resolveNvmBin', () => {
  beforeEach(() => {
    readFileSyncMock.mockReset()
    vi.resetModules()
  })

  it('returns bin dir for a concrete numeric version ("20")', async () => {
    readFileSyncMock.mockReturnValue('20')
    const { resolveNvmBin } = await import('../../utils/nodePath.js')
    const home = '/home/testuser'
    expect(resolveNvmBin(home)).toBe(path.join(home, '.nvm', 'versions', 'node', 'v20', 'bin'))
  })

  it('returns bin dir for a v-prefixed semver ("v20.19.1")', async () => {
    readFileSyncMock.mockReturnValue('v20.19.1')
    const { resolveNvmBin } = await import('../../utils/nodePath.js')
    const home = '/home/testuser'
    expect(resolveNvmBin(home)).toBe(path.join(home, '.nvm', 'versions', 'node', 'v20.19.1', 'bin'))
  })

  it('returns undefined for a symbolic ref ("lts/iron")', async () => {
    readFileSyncMock.mockReturnValue('lts/iron')
    const { resolveNvmBin } = await import('../../utils/nodePath.js')
    expect(resolveNvmBin('/home/testuser')).toBeUndefined()
  })

  it('returns undefined when the alias file is absent (ENOENT caught)', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const { resolveNvmBin } = await import('../../utils/nodePath.js')
    expect(resolveNvmBin('/home/testuser')).toBeUndefined()
  })
})

// ── whichOnPath ───────────────────────────────────────────────────────────────
describe('whichOnPath', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    accessSyncMock.mockReset()
    readFileSyncMock.mockReset()
    vi.resetModules()
    // Restore platform between tests
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', { ...originalPlatform, configurable: true })
    }
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', { ...originalPlatform, configurable: true })
    }
  })

  it('returns the first executable hit on PATH', async () => {
    accessSyncMock.mockImplementation((p: string) => {
      if (p === '/usr/local/bin/node') return // X_OK — exists
      throw new Error('EACCES')
    })
    const { whichOnPath } = await import('../../utils/nodePath.js')
    expect(whichOnPath('node', '/usr/local/bin' + path.delimiter + '/usr/bin')).toBe(
      '/usr/local/bin/node'
    )
  })

  it('returns undefined when no executable is found on PATH', async () => {
    accessSyncMock.mockImplementation(() => {
      throw new Error('EACCES')
    })
    const { whichOnPath } = await import('../../utils/nodePath.js')
    expect(whichOnPath('node', '/usr/bin' + path.delimiter + '/usr/local/bin')).toBeUndefined()
  })

  it('returns undefined for an empty PATH string', async () => {
    const { whichOnPath } = await import('../../utils/nodePath.js')
    expect(whichOnPath('node', '')).toBeUndefined()
  })

  it('on win32: also tries .cmd and .exe suffixes', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    accessSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('node.cmd')) return // only .cmd variant exists
      throw new Error('EACCES')
    })
    const { whichOnPath } = await import('../../utils/nodePath.js')
    const result = whichOnPath('node', 'C:\\Windows\\system32')
    expect(result).toMatch(/node\.cmd$/)
  })

  it('on non-win32: does NOT try .cmd/.exe suffixes', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    // .cmd variant would succeed, but should not be tried on linux
    accessSyncMock.mockImplementation((p: string) => {
      if (p === '/usr/bin/node') return
      throw new Error('EACCES')
    })
    const { whichOnPath } = await import('../../utils/nodePath.js')
    const result = whichOnPath('node', '/usr/bin')
    expect(result).toBe('/usr/bin/node')
    // Confirm accessSync was never called with a .cmd/.exe path
    const callsWithSuffix = (accessSyncMock.mock.calls as string[][]).filter(
      ([p]) => p?.endsWith('.cmd') || p?.endsWith('.exe')
    )
    expect(callsWithSuffix).toHaveLength(0)
  })
})

// ── buildAugmentedPath (unix) ─────────────────────────────────────────────────
describe('buildAugmentedPath (unix)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    spawnMock.mockReset()
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', { ...originalPlatform, configurable: true })
    }
  })

  it('places login-shell PATH before process.env.PATH', async () => {
    const loginPath = '/opt/custom/bin'
    spawnMock.mockImplementation(() => makeShellChild(loginPath))
    existsSyncMock.mockReturnValue(false) // no node-manager dirs on disk
    const { buildAugmentedPath } = await import('../../utils/nodePath.js')
    const result = await buildAugmentedPath()
    expect(result).toContain(loginPath)
    const customIdx = result.indexOf(loginPath)
    const envPath = process.env['PATH'] ?? ''
    const firstEnvSegment = envPath.split(path.delimiter).find(Boolean) ?? ''
    if (firstEnvSegment) {
      // Login shell dir should appear before the first inherited PATH dir
      expect(customIdx).toBeLessThan(result.indexOf(firstEnvSegment))
    }
  })

  it('includes an existing node-manager dir between login-shell PATH and env PATH', async () => {
    const loginPath = '/opt/custom/bin'
    const voltaDir = path.join(os.homedir(), '.volta', 'bin')
    spawnMock.mockImplementation(() => makeShellChild(loginPath))
    existsSyncMock.mockImplementation((p: string) => p === voltaDir)
    const { buildAugmentedPath } = await import('../../utils/nodePath.js')
    const result = await buildAugmentedPath()
    expect(result).toContain(voltaDir)
    // login-shell dir must precede volta dir
    expect(result.indexOf(loginPath)).toBeLessThan(result.indexOf(voltaDir))
  })

  it('deduplicates a segment present in both login-shell PATH and env PATH', async () => {
    const sharedDir = '/usr/local/bin'
    // Login shell emits a path that overlaps with process.env.PATH
    spawnMock.mockImplementation(() => makeShellChild(sharedDir))
    existsSyncMock.mockReturnValue(false)
    const { buildAugmentedPath } = await import('../../utils/nodePath.js')
    const result = await buildAugmentedPath()
    const segments = result.split(path.delimiter)
    const count = segments.filter((s) => s === sharedDir).length
    expect(count).toBe(1)
  })

  it('fails soft (resolves, no throw) when the login-shell spawn errors', async () => {
    spawnMock.mockImplementation(() => {
      const c = new EventEmitter() as FakeChild
      c.stdout = new EventEmitter()
      c.kill = vi.fn()
      queueMicrotask(() => c.emit('error', new Error('ENOENT')))
      return c
    })
    existsSyncMock.mockReturnValue(false)
    const { buildAugmentedPath } = await import('../../utils/nodePath.js')
    await expect(buildAugmentedPath()).resolves.toBeDefined()
  })
})

// ── resolveLoginShellPath single-flight (P-5) ─────────────────────────────────
describe('resolveLoginShellPath single-flight (P-5)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    spawnMock.mockReset()
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', { ...originalPlatform, configurable: true })
    }
  })

  it('spawns the shell exactly once for N concurrent callers', async () => {
    spawnMock.mockImplementation(() => makeShellChild('/opt/login-bin'))
    const { resolveLoginShellPath } = await import('../../utils/nodePath.js')
    const [r1, r2, r3, r4, r5] = await Promise.all([
      resolveLoginShellPath(),
      resolveLoginShellPath(),
      resolveLoginShellPath(),
      resolveLoginShellPath(),
      resolveLoginShellPath(),
    ])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(r1).toBe('/opt/login-bin')
    expect(r2).toBe('/opt/login-bin')
    expect(r3).toBe('/opt/login-bin')
    expect(r4).toBe('/opt/login-bin')
    expect(r5).toBe('/opt/login-bin')
  })

  it('never spawns on win32 — returns empty string immediately', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const { resolveLoginShellPath } = await import('../../utils/nodePath.js')
    const result = await resolveLoginShellPath()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(result).toBe('')
  })

  it('kills the child and resolves to empty string on 2.5s timeout', async () => {
    vi.useFakeTimers()
    const killFn = vi.fn()
    spawnMock.mockImplementation(() => {
      const c = makeHungChild()
      c.kill = killFn
      return c
    })
    const { resolveLoginShellPath } = await import('../../utils/nodePath.js')
    const pending = resolveLoginShellPath()
    await vi.advanceTimersByTimeAsync(2500)
    const result = await pending
    expect(killFn).toHaveBeenCalledTimes(1)
    expect(result).toBe('')
    vi.useRealTimers()
  })
})

// ── resolveWindowsPath single-flight (P-5) ────────────────────────────────────
describe('resolveWindowsPath single-flight (P-5)', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    vi.resetModules()
  })

  it('spawns PowerShell exactly once for N concurrent callers', async () => {
    const winPath = 'C:\\Windows\\system32;C:\\Program Files\\nodejs'
    spawnMock.mockImplementation(() => makeShellChild(winPath))
    const { resolveWindowsPath } = await import('../../utils/nodePath.js')
    const [r1, r2, r3] = await Promise.all([
      resolveWindowsPath(),
      resolveWindowsPath(),
      resolveWindowsPath(),
    ])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(r1).toBe(winPath)
    expect(r2).toBe(winPath)
    expect(r3).toBe(winPath)
  })

  it('falls back to process.env.PATH when PowerShell spawn errors', async () => {
    spawnMock.mockImplementation(() => {
      const c = new EventEmitter() as FakeChild
      c.stdout = new EventEmitter()
      c.kill = vi.fn()
      queueMicrotask(() => c.emit('error', new Error('ENOENT')))
      return c
    })
    const { resolveWindowsPath } = await import('../../utils/nodePath.js')
    const result = await resolveWindowsPath()
    expect(result).toBe(process.env['PATH'] ?? '')
  })
})
