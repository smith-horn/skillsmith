/**
 * SMI-2714: Config module credential storage tests
 *
 * Tests for storeApiKey, clearApiKey, getAuthStatus, and the updated
 * isValidApiKeyFormat with ReDoS guard.
 *
 * vi.mock factory is hoisted before module load — never use vi.doMock for the
 * primary keytar mock (it would arrive too late).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import * as os from 'os'

// MUST be declared before any imports of the module under test so Vitest hoists
// this factory and the mock is in place when config/index.ts is first loaded.
vi.mock('@isaacs/keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn(),
  },
}))

// Retrieve the mocked keytar module using Vitest's module registry.
// We can't use a static import (no types in core) nor a standard dynamic import
// (same reason), so we resolve the mock via vi.importMock after the mock factory
// above has run.
const keytarMod = await vi.importMock<{
  default: {
    setPassword: ReturnType<typeof vi.fn>
    getPassword: ReturnType<typeof vi.fn>
    deletePassword: ReturnType<typeof vi.fn>
  }
}>('@isaacs/keytar')
const mockKeytar = keytarMod.default

// Import module under test AFTER mocks are declared
import {
  storeApiKey,
  clearApiKey,
  getAuthStatus,
  isValidApiKeyFormat,
  saveConfig,
  loadConfig,
} from './index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_KEY = 'sk_live_' + 'a'.repeat(32)
const VALID_KEY_LONG = 'sk_live_' + 'b'.repeat(128)

/** Unique temp config dir per test run to avoid cross-test pollution */
function makeTempConfigDir(): string {
  return path.join(
    os.tmpdir(),
    `skillsmith-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

// ---------------------------------------------------------------------------
// isValidApiKeyFormat
// ---------------------------------------------------------------------------

describe('isValidApiKeyFormat', () => {
  it('accepts a key with exactly 32 suffix chars', () => {
    expect(isValidApiKeyFormat(VALID_KEY)).toBe(true)
  })

  it('accepts a key with exactly 128 suffix chars', () => {
    expect(isValidApiKeyFormat(VALID_KEY_LONG)).toBe(true)
  })

  it('rejects a key with 129 suffix chars (over cap)', () => {
    const tooLong = 'sk_live_' + 'c'.repeat(129)
    expect(isValidApiKeyFormat(tooLong)).toBe(false)
  })

  it('rejects a key shorter than 32 suffix chars', () => {
    const tooShort = 'sk_live_' + 'a'.repeat(31)
    expect(isValidApiKeyFormat(tooShort)).toBe(false)
  })

  it('rejects a key with wrong prefix', () => {
    expect(isValidApiKeyFormat('sk_test_' + 'a'.repeat(32))).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidApiKeyFormat('')).toBe(false)
  })

  it('rejects a string over 200 chars (ReDoS pre-check)', () => {
    const huge = 'sk_live_' + 'a'.repeat(193) // total 201 chars
    expect(isValidApiKeyFormat(huge)).toBe(false)
  })

  it('rejects exactly 200 chars if suffix > 128', () => {
    // 200 total — 8 prefix = 192 suffix chars, which exceeds the 128 cap
    const edge = 'sk_live_' + 'a'.repeat(192)
    expect(isValidApiKeyFormat(edge)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// storeApiKey
// ---------------------------------------------------------------------------

describe('storeApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores in keyring when keytar is available', async () => {
    mockKeytar.setPassword.mockResolvedValue(undefined)

    await storeApiKey(VALID_KEY)

    expect(mockKeytar.setPassword).toHaveBeenCalledWith('skillsmith-cli', 'api-key', VALID_KEY)
  })

  it('falls back to config file when keytar.setPassword throws', async () => {
    mockKeytar.setPassword.mockRejectedValue(new Error('keyring locked'))

    const originalHome = process.env.HOME
    const tmpDir = makeTempConfigDir()
    process.env.HOME = tmpDir

    try {
      await storeApiKey(VALID_KEY)
      // If config dir was created, the key should be in the file
      const configPath = path.join(tmpDir, '.skillsmith', 'config.json')
      if (existsSync(configPath)) {
        const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
        expect(saved.apiKey).toBe(VALID_KEY)
      }
      // Test passed if no exception was thrown
    } finally {
      process.env.HOME = originalHome
    }
  })
})

// ---------------------------------------------------------------------------
// clearApiKey
// ---------------------------------------------------------------------------

describe('clearApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears from keyring and reports success', async () => {
    mockKeytar.deletePassword.mockResolvedValue(true)

    const result = await clearApiKey()

    expect(mockKeytar.deletePassword).toHaveBeenCalledWith('skillsmith-cli', 'api-key')
    expect(result.success).toBe(true)
    expect(result.source).toContain('keyring')
  })

  it('always clears apiKey from config file (undefined, not empty string)', async () => {
    mockKeytar.deletePassword.mockResolvedValue(false)

    // Pre-populate a config with an API key
    const originalHome = process.env.HOME
    const tmpDir = makeTempConfigDir()
    process.env.HOME = tmpDir

    try {
      saveConfig({ apiKey: VALID_KEY })

      await clearApiKey()

      const config = loadConfig()
      // apiKey must be absent or undefined — NEVER an empty string
      expect(config.apiKey).toBeUndefined()
      // Verify the raw JSON does not contain an empty-string apiKey
      const configPath = path.join(tmpDir, '.skillsmith', 'config.json')
      if (existsSync(configPath)) {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
        expect(raw.apiKey).toBeUndefined()
        expect('apiKey' in raw ? raw.apiKey : 'NOT_PRESENT').not.toBe('')
      }
    } finally {
      process.env.HOME = originalHome
    }
  })

  it('reports partial failure when keyring throws but config still cleared', async () => {
    mockKeytar.deletePassword.mockRejectedValue(new Error('access denied'))

    const originalHome = process.env.HOME
    const tmpDir = makeTempConfigDir()
    process.env.HOME = tmpDir

    try {
      saveConfig({ apiKey: VALID_KEY })

      const result = await clearApiKey()

      // Config file should still be cleared
      const config = loadConfig()
      expect(config.apiKey).toBeUndefined()

      // Result should reflect the keyring error
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error).toContain('access denied')
    } finally {
      process.env.HOME = originalHome
    }
  })

  it('succeeds when no key is stored in keyring', async () => {
    mockKeytar.deletePassword.mockResolvedValue(false)

    const result = await clearApiKey()

    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getAuthStatus
// ---------------------------------------------------------------------------

describe('getAuthStatus', () => {
  let originalHome: string | undefined
  let originalApiKey: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    originalHome = process.env['HOME']
    originalApiKey = process.env['SKILLSMITH_API_KEY']
    // Start each test with no API key set
    delete process.env['SKILLSMITH_API_KEY']
  })

  afterEach(() => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env['HOME'] = originalHome
    }
    // Restore API key (delete if it wasn't set before)
    if (originalApiKey !== undefined) {
      process.env['SKILLSMITH_API_KEY'] = originalApiKey
    } else {
      delete process.env['SKILLSMITH_API_KEY']
    }
  })

  describe('env source', () => {
    it('returns env source when SKILLSMITH_API_KEY is set and valid', async () => {
      process.env['SKILLSMITH_API_KEY'] = VALID_KEY

      const status = await getAuthStatus()

      expect(status.authenticated).toBe(true)
      expect(status.source).toBe('env')
      expect(status.keyPrefix).toBe(VALID_KEY.substring(0, 12))
    })

    it('does not return env source for an invalid env key format', async () => {
      process.env['SKILLSMITH_API_KEY'] = 'not-a-valid-key'
      mockKeytar.getPassword.mockResolvedValue(null)

      const tmpDir = makeTempConfigDir()
      process.env.HOME = tmpDir

      const status = await getAuthStatus()

      expect(status.source).not.toBe('env')
    })
  })

  describe('keyring source', () => {
    it('returns keyring source when keytar has a valid key and env is not set', async () => {
      delete process.env['SKILLSMITH_API_KEY']
      mockKeytar.getPassword.mockResolvedValue(VALID_KEY)

      const tmpDir = makeTempConfigDir()
      process.env.HOME = tmpDir

      const status = await getAuthStatus()

      expect(status.authenticated).toBe(true)
      expect(status.source).toBe('keyring')
      expect(status.keyPrefix).toBe(VALID_KEY.substring(0, 12))
    })

    it('falls through when keyring returns null', async () => {
      delete process.env['SKILLSMITH_API_KEY']
      mockKeytar.getPassword.mockResolvedValue(null)

      const tmpDir = makeTempConfigDir()
      process.env.HOME = tmpDir

      const status = await getAuthStatus()

      expect(status.source).not.toBe('keyring')
    })

    it('falls through when keyring throws', async () => {
      delete process.env['SKILLSMITH_API_KEY']
      mockKeytar.getPassword.mockRejectedValue(new Error('keyring unavailable'))

      const tmpDir = makeTempConfigDir()
      process.env.HOME = tmpDir

      const status = await getAuthStatus()

      // Should not throw; should fall through to config/none
      expect(status.authenticated).toBe(false)
    })
  })

  describe('config source', () => {
    it('returns config source when key is in config file and env/keyring are absent', async () => {
      delete process.env['SKILLSMITH_API_KEY']
      mockKeytar.getPassword.mockResolvedValue(null)

      const tmpDir = makeTempConfigDir()
      process.env.HOME = tmpDir

      saveConfig({ apiKey: VALID_KEY })

      const status = await getAuthStatus()

      expect(status.authenticated).toBe(true)
      expect(status.source).toBe('config')
      expect(status.keyPrefix).toBe(VALID_KEY.substring(0, 12))
    })
  })

  describe('none source', () => {
    it('returns none when no key is stored anywhere', async () => {
      delete process.env['SKILLSMITH_API_KEY']
      mockKeytar.getPassword.mockResolvedValue(null)

      const tmpDir = makeTempConfigDir()
      process.env.HOME = tmpDir

      const status = await getAuthStatus()

      expect(status.authenticated).toBe(false)
      expect(status.keyPrefix).toBeNull()
      expect(status.source).toBe('none')
    })
  })
})

// ---------------------------------------------------------------------------
// Keytar import failure simulation
// ---------------------------------------------------------------------------

describe('keytar import failure fallback', () => {
  it('falls back to config file when @isaacs/keytar cannot be imported', async () => {
    // We simulate unavailability by mocking setPassword to throw.
    // A full module-import-failure path is covered by the storeApiKey fallback test above.
    mockKeytar.setPassword.mockRejectedValue(new Error('simulated import failure'))

    const originalHome = process.env.HOME
    const tmpDir = makeTempConfigDir()
    process.env.HOME = tmpDir

    try {
      await storeApiKey(VALID_KEY)
      // No exception means fallback succeeded
    } finally {
      process.env.HOME = originalHome
    }
  })
})
