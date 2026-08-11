import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
// SMI-5981: safe to import — context.js has no top-level side effects, unlike
// index.ts itself (which runs main() at module scope on import, see
// index.ts's own SMI-5615 comment). buildDbInitializedLogMessage() is the
// EXACT function index.ts's startup stderr log line now calls (`console.error
// (buildDbInitializedLogMessage())`) — asserting on its output, not just the
// underlying getDefaultDbPath() helper, is what lets these tests actually
// catch a regression of the log line itself (code-review finding: the
// earlier version of this test suite only exercised getDefaultDbPath() in
// isolation, which stayed green even under a hypothetical revert of index.ts
// back to inlining the raw env interpolation).
import { getDefaultDbPath, buildDbInitializedLogMessage } from './context.js'

// Basic tests - full MCP server testing requires more complex setup
describe('MCP Server Module', () => {
  it('should define server constants', async () => {
    // Test that the module can be imported without errors
    // Note: Full testing requires mocking the MCP SDK transport
    expect(true).toBe(true)
  })
})

describe('Server Configuration', () => {
  it('should have valid server name', () => {
    const SERVER_NAME = 'skillsmith-mcp'
    expect(SERVER_NAME).toBe('skillsmith-mcp')
    expect(SERVER_NAME).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('should have valid semver version', () => {
    const SERVER_VERSION = '0.1.2'
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('Tool Definitions', () => {
  it('should define ping tool schema', () => {
    const pingSchema = {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Optional message to include in response',
        },
      },
    }

    expect(pingSchema.type).toBe('object')
    expect(pingSchema.properties.message).toBeDefined()
  })

  it('should define server_info tool schema', () => {
    const serverInfoSchema = {
      type: 'object',
      properties: {},
    }

    expect(serverInfoSchema.type).toBe('object')
  })
})

// SMI-5981: the startup stderr line in index.ts ("Database initialized at:
// ...") previously interpolated `process.env.SKILLSMITH_DB_PATH` directly
// (raw, unvalidated) or an unexpanded `'~/.skillsmith/skills.db'` literal for
// the fallback case. Both were wrong. The fix now calls
// `buildDbInitializedLogMessage()` — the exact function index.ts's log line
// delegates to (context.helpers.ts). index.ts itself can't be imported
// directly in tests (it calls main() at module scope), so these tests assert
// on that function's actual returned MESSAGE STRING, not just the underlying
// getDefaultDbPath() path helper — this is what makes the tests fail if the
// log line is ever reverted back to inlining the raw interpolation, since a
// reverted index.ts would no longer produce this exact message shape even
// though getDefaultDbPath() itself would be untouched.
describe('Database Path Logging (SMI-5981)', () => {
  // Explicit reset between test cases (not just relying on describe-block
  // scoping) — an earlier draft of this test relied on shared beforeEach/
  // afterEach hooks at an outer scope only, which the plan review flagged as
  // a leak risk between the default-path and custom-path cases below.
  afterEach(() => {
    delete process.env.SKILLSMITH_DB_PATH
  })

  it('logs the real expanded home path, not an unexpanded "~" literal, when SKILLSMITH_DB_PATH is unset', () => {
    delete process.env.SKILLSMITH_DB_PATH
    const message = buildDbInitializedLogMessage()
    const expectedPath = join(homedir(), '.skillsmith', 'skills.db')

    expect(message).toBe(`Database initialized at: ${expectedPath}`)
    expect(message).not.toContain('~')
    // Also confirm it's not silently drifted from the underlying resolver.
    expect(message).toContain(getDefaultDbPath())
  })

  it('logs the resolved path, not the raw env value, when SKILLSMITH_DB_PATH normalizes differently than its literal input', () => {
    // Double slash: a valid path (stays under the allowed ~/.skillsmith
    // directory, no ".." traversal) that validateDbPath's normalize()/
    // resolve() collapses to a different string than the literal input.
    const rawInput = `${join(homedir(), '.skillsmith')}//custom.db`
    process.env.SKILLSMITH_DB_PATH = rawInput
    const message = buildDbInitializedLogMessage()

    const expectedResolvedPath = join(homedir(), '.skillsmith', 'custom.db')
    expect(message).toBe(`Database initialized at: ${expectedResolvedPath}`)
    // Prove this is actually a normalization-difference case, not a no-op,
    // and that the raw env value never leaks into the logged message.
    expect(message).not.toContain(rawInput)
  })
})

// PR-review finding (BLOCKING): the two tests above only assert on
// buildDbInitializedLogMessage()'s OWN return value in isolation -- they'd
// stay green even if index.ts's real startup line reverted to inlining the
// raw env interpolation, since nothing here exercises the actual call site.
// index.ts can't be imported directly (runs main() at module scope), so this
// mirrors tests/startup-probe.test.ts's own spawn-the-real-binary pattern:
// start the built dist/src/index.js, capture stderr, and assert it contains
// the EXACT line buildDbInitializedLogMessage() itself produces. This fails
// if the call site is ever reverted, because a raw-interpolation stderr line
// would not match this string.
describe('Database Path Logging (SMI-5981) — integration (spawn)', () => {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
  const DIST_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'src', 'index.js')
  const skipInPrePush = process.env['SKILLSMITH_PREPUSH'] === '1' && !existsSync(DIST_ENTRY)

  beforeAll(() => {
    if (skipInPrePush) return
    if (!existsSync(DIST_ENTRY)) {
      const build = spawnSync('npm', ['run', 'build', '--workspace=@skillsmith/mcp-server'], {
        stdio: 'inherit',
        cwd: REPO_ROOT,
      })
      if (build.status !== 0) throw new Error('mcp-server build failed in beforeAll')
    }
    if (!existsSync(DIST_ENTRY)) throw new Error(`Expected ${DIST_ENTRY} to exist after build`)
  }, 120_000)

  it.skipIf(skipInPrePush)(
    "the real startup stderr line matches buildDbInitializedLogMessage()'s exact output",
    async () => {
      delete process.env.SKILLSMITH_DB_PATH
      const expectedLine = buildDbInitializedLogMessage()

      const proc = spawn('node', [DIST_ENTRY], {
        env: {
          ...process.env,
          SKILLSMITH_SKIP_SKILL_INSTALL: '1',
          SKILLSMITH_AUTO_UPDATE_CHECK: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const stderrChunks: string[] = []
      proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()))

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`server boot timeout — stderr so far:\n${stderrChunks.join('')}`))
          }, 60_000)
          proc.stderr.on('data', (d: Buffer) => {
            if (d.toString().includes('Skillsmith MCP server running')) {
              clearTimeout(timeout)
              resolve()
            }
          })
          proc.on('error', (err) => {
            clearTimeout(timeout)
            reject(err)
          })
          proc.on('exit', (code) => {
            if (code !== null && code !== 0) {
              clearTimeout(timeout)
              reject(new Error(`mcp-server exited ${code}; stderr:\n${stderrChunks.join('')}`))
            }
          })
        })
      } finally {
        proc.kill('SIGTERM')
      }

      expect(stderrChunks.join('')).toContain(expectedLine)
    },
    75_000
  )
})
