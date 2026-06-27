/**
 * Unit tests for src/mcp/resolveServerCommand.ts (SMI-5398).
 *
 * Key coverage:
 *  - Absolute + executable command → kind:'absolute' (no PATH probe)
 *  - Absolute but non-executable → falls through to whichOnPath
 *  - Command resolved on augmented PATH → kind:'resolved' with abs path
 *  - Unresolved → kind:'unresolved' + selfHeal (preferred & fallback forms)
 *  - Stable-node rule (F3): nvm versioned hit → alias when present; asdf/volta/mise as-is
 *  - SAFE_SPAWN_CHARS gate: unsafe suggestion path suppressed → selfHeal undefined
 *  - ServerCommandUnresolvedError carries selfHeal on the error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'

// ── hoisted mocks (must precede vi.mock factory bodies that reference them) ───
// Vitest 4.x vi.fn<T>() takes the full function signature as the single type arg.
const { buildAugmentedEnvMock, whichOnPathMock, accessSyncMock, existsSyncMock, realpathSyncMock } =
  vi.hoisted(() => ({
    buildAugmentedEnvMock: vi.fn<() => Promise<NodeJS.ProcessEnv>>(),
    whichOnPathMock: vi.fn<(command: string, pathString: string) => string | undefined>(),
    accessSyncMock: vi.fn(),
    existsSyncMock: vi.fn(),
    realpathSyncMock: vi.fn<(p: string) => string>(),
  }))

// ── module mocks ──────────────────────────────────────────────────────────────
vi.mock('../../utils/nodePath.js', () => ({
  buildAugmentedEnv: buildAugmentedEnvMock,
  whichOnPath: whichOnPathMock,
}))

vi.mock('../../mcp/mcpLog.js', () => ({ logMcp: vi.fn() }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    accessSync: accessSyncMock,
    existsSync: existsSyncMock,
    realpathSync: realpathSyncMock,
  }
})

// Static imports AFTER vi.mock / vi.hoisted declarations
import {
  resolveServerCommand,
  ServerCommandUnresolvedError,
} from '../../mcp/resolveServerCommand.js'

// ── shared test env ───────────────────────────────────────────────────────────
const AUGMENTED_PATH = '/augmented/bin:/usr/local/bin:/usr/bin'
const AUGMENTED_ENV: NodeJS.ProcessEnv = { ...process.env, PATH: AUGMENTED_PATH }

beforeEach(() => {
  buildAugmentedEnvMock.mockReset()
  whichOnPathMock.mockReset()
  accessSyncMock.mockReset()
  existsSyncMock.mockReset()
  realpathSyncMock.mockReset()

  buildAugmentedEnvMock.mockResolvedValue(AUGMENTED_ENV)
  // Default: accessSync throws → not executable (absolute fast-path skipped)
  accessSyncMock.mockImplementation(() => {
    throw new Error('EACCES')
  })
  existsSyncMock.mockReturnValue(false)
  realpathSyncMock.mockImplementation((p: string) => p) // identity by default
})

// ── absolute fast path ────────────────────────────────────────────────────────
describe('absolute + executable command (fast path)', () => {
  it('returns kind:"absolute" without invoking whichOnPath', async () => {
    const cmd = '/usr/local/bin/node'
    accessSyncMock.mockReturnValue(undefined) // X_OK succeeds → isExecutable
    const result = await resolveServerCommand(cmd, ['server.js'])
    expect(result.kind).toBe('absolute')
    if (result.kind === 'absolute') {
      expect(result.command).toBe(cmd)
      expect(result.source).toBe('configured-absolute')
      expect(result.env).toMatchObject({ PATH: AUGMENTED_PATH })
    }
    expect(whichOnPathMock).not.toHaveBeenCalled()
  })

  it('attaches augmented env even on the absolute fast path', async () => {
    accessSyncMock.mockReturnValue(undefined)
    const result = await resolveServerCommand('/abs/node', [])
    expect(result.kind).toBe('absolute')
    if (result.kind === 'absolute') {
      expect(result.env['PATH']).toBe(AUGMENTED_PATH)
    }
  })
})

// ── absolute but non-executable falls through to whichOnPath ─────────────────
describe('absolute but non-executable command', () => {
  it('falls through to whichOnPath when the file is not executable', async () => {
    const absCmd = '/absolute/but/not/executable'
    whichOnPathMock.mockReturnValue('/found/on/path/bin')
    const result = await resolveServerCommand(absCmd, [])
    expect(result.kind).toBe('resolved')
    expect(whichOnPathMock).toHaveBeenCalledWith(absCmd, AUGMENTED_PATH)
  })
})

// ── resolved via PATH ─────────────────────────────────────────────────────────
describe('command resolved on augmented PATH', () => {
  it('returns kind:"resolved" with the absolute path and env', async () => {
    whichOnPathMock.mockImplementation((cmd) => {
      if (cmd === 'npx') return '/usr/local/bin/npx'
      return undefined
    })
    const result = await resolveServerCommand('npx', ['@skillsmith/mcp-server'])
    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.command).toBe('/usr/local/bin/npx')
      expect(result.args).toEqual(['@skillsmith/mcp-server'])
      expect(result.env['PATH']).toBe(AUGMENTED_PATH)
      expect(result.source).toBe('/usr/local/bin')
    }
  })
})

// ── unresolved with self-heal (preferred form: node + skillsmith-mcp) ─────────
describe('unresolved command → selfHeal preferred form', () => {
  it('returns kind:"unresolved" with a node+mcp selfHeal when both are on PATH', async () => {
    const nodeHit = '/usr/local/bin/node'
    const mcpHit = '/usr/local/bin/skillsmith-mcp'
    const mcpEntry = '/usr/local/lib/node_modules/@skillsmith/mcp-server/dist/index.js'
    whichOnPathMock.mockImplementation((cmd) => {
      if (cmd === 'node') return nodeHit
      if (cmd === 'skillsmith-mcp') return mcpHit
      return undefined
    })
    realpathSyncMock.mockImplementation((p) => (p === mcpHit ? mcpEntry : p))

    const result = await resolveServerCommand('npx', ['@skillsmith/mcp-server'])
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.selfHeal).toBeDefined()
      expect(result.selfHeal?.label).toBe('Use detected Node')
      expect(result.selfHeal?.serverArgs).toContain(mcpEntry)
    }
  })
})

// ── unresolved with self-heal (fallback form: npx) ────────────────────────────
describe('unresolved command → selfHeal fallback form (npx)', () => {
  it('falls back to absolute npx when node is not found but npx is', async () => {
    const npxHit = '/usr/local/bin/npx'
    whichOnPathMock.mockImplementation((cmd) => {
      // 'node' and 'skillsmith-mcp' both miss; only npx is found
      if (cmd === 'npx') return npxHit
      return undefined
    })

    const result = await resolveServerCommand('missing-command', [])
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.selfHeal).toBeDefined()
      expect(result.selfHeal?.label).toBe('Use detected npx')
      expect(result.selfHeal?.serverCommand).toBe(npxHit)
      expect(result.selfHeal?.serverArgs).toContain('@skillsmith/mcp-server')
    }
  })
})

// ── SAFE_SPAWN_CHARS gate ─────────────────────────────────────────────────────
describe('SAFE_SPAWN_CHARS gate suppresses unsafe self-heal', () => {
  it('returns selfHeal:undefined when the entry path contains a disallowed character', async () => {
    const nodeHit = '/usr/local/bin/node'
    const mcpHit = '/home/user/bin/skillsmith-mcp'
    // realpathSync returns a path with '!' — outside [a-zA-Z0-9._/@: -]+
    const unsafeEntry = '/home/user/bad!entry/skillsmith-mcp'
    whichOnPathMock.mockImplementation((cmd) => {
      if (cmd === 'node') return nodeHit
      if (cmd === 'skillsmith-mcp') return mcpHit
      return undefined // npx also absent → both forms suppressed
    })
    realpathSyncMock.mockImplementation((p) => (p === mcpHit ? unsafeEntry : p))

    const result = await resolveServerCommand('missing-cmd', [])
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.selfHeal).toBeUndefined()
    }
  })
})

// ── stable-node rule (F3) ─────────────────────────────────────────────────────
describe('stable-node rule (F3)', () => {
  const home = os.homedir()

  it('falls through to the versioned realpath for an nvm hit (nvm has no stable shim)', async () => {
    const nvmVersionedNode = path.join(home, '.nvm', 'versions', 'node', 'v20.19.1', 'bin', 'node')
    const mcpHit = '/usr/local/bin/skillsmith-mcp'
    whichOnPathMock.mockImplementation((cmd) => {
      if (cmd === 'node') return nvmVersionedNode
      if (cmd === 'skillsmith-mcp') return mcpHit
      return undefined
    })
    realpathSyncMock.mockImplementation((p) => p) // identity -> versioned path written as-is

    const result = await resolveServerCommand('missing', [])
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.selfHeal?.serverCommand).toBe(nvmVersionedNode)
    }
  })

  it('writes the asdf shim as-is (version-agnostic shim)', async () => {
    const asdfShim = path.join(home, '.asdf', 'shims', 'node')
    const mcpHit = '/usr/local/bin/skillsmith-mcp'
    whichOnPathMock.mockImplementation((cmd) => {
      if (cmd === 'node') return asdfShim
      if (cmd === 'skillsmith-mcp') return mcpHit
      return undefined
    })
    realpathSyncMock.mockImplementation((p) => p)

    const result = await resolveServerCommand('missing', [])
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.selfHeal?.serverCommand).toBe(asdfShim)
    }
  })

  it('writes the volta shim as-is', async () => {
    const voltaNode = path.join(home, '.volta', 'bin', 'node')
    const mcpHit = '/usr/local/bin/skillsmith-mcp'
    whichOnPathMock.mockImplementation((cmd) => {
      if (cmd === 'node') return voltaNode
      if (cmd === 'skillsmith-mcp') return mcpHit
      return undefined
    })
    realpathSyncMock.mockImplementation((p) => p)

    const result = await resolveServerCommand('missing', [])
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.selfHeal?.serverCommand).toBe(voltaNode)
    }
  })

  it('writes the mise shim as-is', async () => {
    const miseShim = path.join(home, '.local', 'share', 'mise', 'shims', 'node')
    const mcpHit = '/usr/local/bin/skillsmith-mcp'
    whichOnPathMock.mockImplementation((cmd) => {
      if (cmd === 'node') return miseShim
      if (cmd === 'skillsmith-mcp') return mcpHit
      return undefined
    })
    realpathSyncMock.mockImplementation((p) => p)

    const result = await resolveServerCommand('missing', [])
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.selfHeal?.serverCommand).toBe(miseShim)
    }
  })
})

// ── ServerCommandUnresolvedError ──────────────────────────────────────────────
describe('ServerCommandUnresolvedError', () => {
  it('carries the selfHeal suggestion on the error object', () => {
    const selfHeal = {
      serverCommand: '/usr/local/bin/node',
      serverArgs: ['/some/entry.js'],
      label: 'Use detected Node',
    }
    const err = new ServerCommandUnresolvedError('npx', selfHeal)
    expect(err.selfHeal).toBe(selfHeal)
    expect(err.name).toBe('ServerCommandUnresolvedError')
    expect(err.message).toContain('npx')
  })

  it('carries undefined selfHeal when no suggestion is available', () => {
    const err = new ServerCommandUnresolvedError('npx', undefined)
    expect(err.selfHeal).toBeUndefined()
    expect(err instanceof Error).toBe(true)
  })
})
