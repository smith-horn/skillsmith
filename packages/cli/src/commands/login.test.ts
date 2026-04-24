// SMI-4402: login command tests — device-code OAuth flow + legacy detection + paste-legacy
// LC-1: JWT auth guard exits 0 when valid credentials exist
// LC-2: device-code success path stores credentials and exits 0
// LC-3: device-code network error on request exits 5
// LC-4: device-code expired exits 4
// LC-5: device-code declined exits 3
// LC-6: slow_down doubles poll interval
// LC-7: legacy key menu — choice 'a' keeps key
// LC-8: legacy key menu — choice 'p' runs paste flow
// LC-9: paste-legacy stores key and exits 0 (+ SMI-4454 echo assertion)
// LC-10: paste-legacy 3 failures exits 1 (+ SMI-4454 echo-per-attempt assertion)
// LC-11: paste-legacy Ctrl+C exits 2
// LC-12: --paste-legacy store failure exits 1 with message
// LC-13: device-code network error during polling exits 5
// LC-14: legacy key menu — choice 'd' runs device flow
// LC-15: SMI-4454 — device-code flow sends client_meta with CLI identity

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// readline.createInterface must be mocked via vi.hoisted + vi.mock — ESM namespace
// objects are not configurable, so vi.spyOn cannot intercept them at runtime.
const { mockCreateInterface } = vi.hoisted(() => ({
  mockCreateInterface: vi.fn(),
}))

vi.mock('readline', () => ({
  default: { createInterface: mockCreateInterface },
  createInterface: mockCreateInterface,
}))

vi.mock('@skillsmith/core', () => ({
  loadCredentials: vi.fn(),
  storeCredentials: vi.fn(),
  getApiKey: vi.fn(),
  getApiBaseUrl: vi.fn().mockReturnValue('https://api.skillsmith.app/functions/v1'),
  storeApiKey: vi.fn(),
  isValidApiKeyFormat: vi.fn(),
}))

vi.mock('@inquirer/prompts', () => ({
  password: vi.fn(),
}))

vi.mock('open', () => ({ default: vi.fn() }))

import { createLoginCommand } from './login.js'
import {
  loadCredentials,
  storeCredentials,
  getApiKey,
  storeApiKey,
  isValidApiKeyFormat,
} from '@skillsmith/core'
import { password } from '@inquirer/prompts'

const mockLoadCredentials = vi.mocked(loadCredentials)
const mockStoreCredentials = vi.mocked(storeCredentials)
const mockGetApiKey = vi.mocked(getApiKey)
const mockStoreApiKey = vi.mocked(storeApiKey)
const mockIsValidApiKeyFormat = vi.mocked(isValidApiKeyFormat)
const mockPassword = vi.mocked(password)

const VALID_KEY = 'sk_live_' + 'a'.repeat(32)
const NOW = Date.now()

async function runCommand(args: string[] = []): Promise<void> {
  const cmd = createLoginCommand()
  await cmd.parseAsync(['node', 'login', ...args])
}

// Simulate a successful device-code exchange
function mockDeviceCodeSuccess(): void {
  let callCount = 0
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if ((url as string).includes('auth-device-code')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            device_code: 'dc_test',
            user_code: 'BCDFGHJK',
            verification_uri: 'https://skillsmith.app/device',
            expires_in: 900,
            interval: 5,
          }),
      })
    }
    // auth-device-token
    callCount++
    if (callCount === 1) {
      return Promise.resolve({ ok: false, status: 428, json: () => Promise.resolve({}) })
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'jwt.access',
          refresh_token: 'jwt.refresh',
          expires_in: 3600,
        }),
    })
  }) as typeof fetch
}

describe('createLoginCommand', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let processExitSpy: ReturnType<typeof vi.spyOn>
  let originalEnv: NodeJS.ProcessEnv
  let originalFetch: typeof fetch

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    originalEnv = { ...process.env }
    originalFetch = global.fetch
    process.env['CI'] = 'true' // suppress browser open by default
    delete process.env['SKILLSMITH_API_KEY']
    mockLoadCredentials.mockResolvedValue(null)
    mockGetApiKey.mockReturnValue(undefined)
    mockStoreCredentials.mockResolvedValue(undefined)
    mockStoreApiKey.mockResolvedValue(undefined)
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        // Clear pending timers so vi.runAllTimersAsync() doesn't fire additional
        // polling iterations after process.exit, which would create unhandled rejections.
        vi.clearAllTimers()
        throw new Error(`process.exit(${code ?? 0})`)
      })
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env = originalEnv
    global.fetch = originalFetch
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    processExitSpy.mockRestore()
  })

  it('has correct name and --paste-legacy option', () => {
    const cmd = createLoginCommand()
    expect(cmd.name()).toBe('login')
    // cmd.opts() before parsing excludes boolean flags without defaults;
    // check the option definition array directly.
    const hasPasteLegacy = cmd.options.some((o: { long?: string }) => o.long === '--paste-legacy')
    expect(hasPasteLegacy).toBe(true)
  })

  it('LC-1: exits 0 when valid JWT credentials already exist', async () => {
    mockLoadCredentials.mockResolvedValue({
      accessToken: 'jwt.access',
      refreshToken: 'jwt.refresh',
      expiresAt: NOW + 3_600_000,
      version: 2,
    })

    await expect(runCommand()).rejects.toThrow('process.exit(0)')

    const output = consoleLogSpy.mock.calls.flat().join('\n')
    expect(output).toContain('Already authenticated')
    expect(output).toContain('skillsmith logout')
  })

  describe('device-code flow', () => {
    it('LC-2: success path stores credentials and exits 0', async () => {
      mockDeviceCodeSuccess()

      const run = runCommand()
      // Suppress unhandledRejection: run rejects inside runAllTimersAsync before
      // expect(run).rejects can attach a handler. The noop catch prevents the
      // Node.js unhandled-rejection warning without consuming the rejection.
      run.catch(() => {})
      await vi.runAllTimersAsync()

      await expect(run).rejects.toThrow('process.exit(0)')

      expect(mockStoreCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'jwt.access',
          refreshToken: 'jwt.refresh',
          version: 2,
        })
      )
      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Logged in successfully')
      // SMI-4447: post-login hint closes the "did it work?" gap that drove users
      // to visit /account/cli-token just to confirm the session worked.
      expect(output).toContain('Try it: skillsmith skills list')
    })

    it('LC-3: network error on device-code request exits 5', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as typeof fetch

      await expect(runCommand()).rejects.toThrow('process.exit(5)')
    })

    it('LC-4: expired token exits 4', async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if ((url as string).includes('auth-device-code')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                device_code: 'dc_exp',
                user_code: 'BCDFGHJK',
                verification_uri: 'https://skillsmith.app/device',
                expires_in: 900,
                interval: 5,
              }),
          })
        }
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: 'expired_token' }),
        })
      }) as typeof fetch

      const run = runCommand()
      run.catch(() => {})
      await vi.runAllTimersAsync()
      await expect(run).rejects.toThrow('process.exit(4)')
    })

    it('LC-5: declined exits 3', async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if ((url as string).includes('auth-device-code')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                device_code: 'dc_dec',
                user_code: 'BCDFGHJK',
                verification_uri: 'https://skillsmith.app/device',
                expires_in: 900,
                interval: 5,
              }),
          })
        }
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: 'authorization_declined' }),
        })
      }) as typeof fetch

      const run = runCommand()
      run.catch(() => {})
      await vi.runAllTimersAsync()
      await expect(run).rejects.toThrow('process.exit(3)')
    })

    it('LC-6: slow_down response doubles poll interval', async () => {
      let tokenCallCount = 0
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if ((url as string).includes('auth-device-code')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                device_code: 'dc_slow',
                user_code: 'BCDFGHJK',
                verification_uri: 'https://skillsmith.app/device',
                expires_in: 900,
                interval: 5,
              }),
          })
        }
        tokenCallCount++
        if (tokenCallCount === 1) {
          return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) })
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ access_token: 'j.a', refresh_token: 'j.r', expires_in: 3600 }),
        })
      }) as typeof fetch

      const run = runCommand()
      run.catch(() => {})
      await vi.runAllTimersAsync()
      await expect(run).rejects.toThrow('process.exit(0)')
      expect(tokenCallCount).toBe(2)
    })

    it('LC-13: network error during token polling exits 5', async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if ((url as string).includes('auth-device-code')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                device_code: 'dc_neterr',
                user_code: 'BCDFGHJK',
                verification_uri: 'https://skillsmith.app/device',
                expires_in: 900,
                interval: 5,
              }),
          })
        }
        // auth-device-token throws network error
        return Promise.reject(new Error('ECONNRESET'))
      }) as typeof fetch

      const run = runCommand()
      run.catch(() => {})
      await vi.runAllTimersAsync()
      await expect(run).rejects.toThrow('process.exit(5)')
    })
  })

  describe('legacy key menu', () => {
    beforeEach(() => {
      mockGetApiKey.mockReturnValue('sk_live_' + 'x'.repeat(32))
    })

    it('LC-7: choice a keeps existing key and exits 0', async () => {
      mockCreateInterface.mockReturnValue({
        once: (_event: string, cb: (line: string) => void) => {
          cb('a')
          return {}
        },
        close: vi.fn(),
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Keeping existing key')
      expect(mockStoreCredentials).not.toHaveBeenCalled()
    })

    it('LC-8: choice p runs paste flow', async () => {
      mockCreateInterface.mockReturnValue({
        once: (_event: string, cb: (line: string) => void) => {
          cb('p')
          return {}
        },
        close: vi.fn(),
      })

      mockIsValidApiKeyFormat.mockReturnValue(true)
      mockPassword.mockResolvedValue(VALID_KEY)

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      expect(mockStoreApiKey).toHaveBeenCalledWith(VALID_KEY)
    })

    it('LC-14: choice d runs device-code flow', async () => {
      mockCreateInterface.mockReturnValue({
        once: (_event: string, cb: (line: string) => void) => {
          cb('d')
          return {}
        },
        close: vi.fn(),
      })

      mockDeviceCodeSuccess()

      const run = runCommand()
      run.catch(() => {})
      await vi.runAllTimersAsync()
      await expect(run).rejects.toThrow('process.exit(0)')

      expect(mockStoreCredentials).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }))
    })
  })

  describe('paste-legacy flow', () => {
    it('LC-9: --paste-legacy stores key and exits 0', async () => {
      mockIsValidApiKeyFormat.mockReturnValue(true)
      mockPassword.mockResolvedValue(VALID_KEY)

      await expect(runCommand(['--paste-legacy'])).rejects.toThrow('process.exit(0)')

      expect(mockStoreApiKey).toHaveBeenCalledWith(VALID_KEY)
      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Logged in successfully')
      // SMI-4454: post-paste echo gives a ground-truth signal when the mask
      // bullet is stripped by the terminal (Claude Code's embedded PTY, etc).
      expect(output).toMatch(/Received \d+ characters — validating…/)
      // And the mask option is forwarded to the prompt so terminals that DO
      // render it use the denser ASCII mark instead of the invisible default.
      expect(mockPassword).toHaveBeenCalledWith(expect.objectContaining({ mask: '*' }))
    })

    it('LC-10: 3 format failures exits 1', async () => {
      mockIsValidApiKeyFormat.mockReturnValue(false)
      mockPassword.mockResolvedValue('bad')

      await expect(runCommand(['--paste-legacy'])).rejects.toThrow('process.exit(1)')

      expect(mockPassword).toHaveBeenCalledTimes(3)
      expect(mockStoreApiKey).not.toHaveBeenCalled()
      const err = consoleErrorSpy.mock.calls.flat().join('\n')
      expect(err).toContain('Too many invalid attempts')
      // SMI-4454: echo fires before each validation error — one per attempt.
      const output = consoleLogSpy.mock.calls.flat().join('\n')
      const echoMatches = output.match(/Received \d+ characters — validating…/g) ?? []
      expect(echoMatches.length).toBeGreaterThanOrEqual(3)
    })

    it('LC-11: Ctrl+C exits 2', async () => {
      const exitErr = Object.assign(new Error('prompt closed'), { name: 'ExitPromptError' })
      mockPassword.mockRejectedValue(exitErr)

      await expect(runCommand(['--paste-legacy'])).rejects.toThrow('process.exit(2)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Cancelled')
    })

    it('LC-12: store failure exits 1 with message', async () => {
      mockIsValidApiKeyFormat.mockReturnValue(true)
      mockPassword.mockResolvedValue(VALID_KEY)
      mockStoreApiKey.mockRejectedValue(new Error('EACCES'))

      await expect(runCommand(['--paste-legacy'])).rejects.toThrow('process.exit(1)')

      const err = consoleErrorSpy.mock.calls.flat().join('\n')
      expect(err).toContain('Failed to store credentials')
      expect(err).toContain('EACCES')
    })
  })

  describe('SMI-4454: client_meta transport', () => {
    it('LC-15: device-code flow sends client_meta with CLI identity', async () => {
      const fetchSpy = vi.fn().mockImplementation((url: string) => {
        if ((url as string).includes('auth-device-code')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                device_code: 'dc_meta',
                user_code: 'BCDFGHJK',
                verification_uri: 'https://skillsmith.app/device',
                expires_in: 900,
                interval: 5,
              }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'jwt.access',
              refresh_token: 'jwt.refresh',
              expires_in: 3600,
            }),
        })
      })
      global.fetch = fetchSpy as typeof fetch

      const run = runCommand()
      run.catch(() => {})
      await vi.runAllTimersAsync()
      await expect(run).rejects.toThrow('process.exit(0)')

      const deviceCodeCall = fetchSpy.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('auth-device-code')
      )
      expect(deviceCodeCall).toBeDefined()
      const init = deviceCodeCall?.[1] as { body?: string } | undefined
      const parsed = JSON.parse(init?.body ?? '{}') as {
        client_type?: string
        client_meta?: Record<string, unknown>
      }

      expect(parsed.client_type).toBe('cli')
      expect(parsed.client_meta).toBeDefined()
      const meta = parsed.client_meta ?? {}

      for (const key of ['cli_version', 'node_version', 'platform', 'arch', 'hostname']) {
        expect(meta, `missing ${key}`).toHaveProperty(key)
        expect(typeof meta[key]).toBe('string')
        expect((meta[key] as string).length).toBeGreaterThan(0)
      }

      // node_version is live process.version ('vX.Y.Z'); platform/arch match live.
      expect(meta['node_version']).toMatch(/^v\d/)
      expect(meta['platform']).toBe(process.platform)
      expect(meta['arch']).toBe(process.arch)
    })
  })
})
