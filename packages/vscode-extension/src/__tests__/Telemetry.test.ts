import { describe, it, expect, vi, beforeEach } from 'vitest'

const getConfigMock = vi.fn()
const isTelemetryEnabledGetter = vi.fn(() => true)

vi.mock('vscode', () => ({
  env: {
    get isTelemetryEnabled() {
      return isTelemetryEnabledGetter()
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: getConfigMock,
    }),
  },
  version: '1.110.0',
}))

const originalFetch = globalThis.fetch

describe('Telemetry service (SMI-4194)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    getConfigMock.mockReset()
    isTelemetryEnabledGetter.mockReset().mockReturnValue(true)
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  function makeContext(cohortId?: string) {
    const store = new Map<string, unknown>()
    if (cohortId) store.set('skillsmith.cohortId', cohortId)
    return {
      globalState: {
        get: (k: string) => store.get(k),
        update: (k: string, v: unknown) => {
          store.set(k, v)
          return Promise.resolve()
        },
      },
    } as unknown as import('vscode').ExtensionContext
  }

  it('generates a cohort UUID on first init and persists it', async () => {
    const { initializeTelemetry, __resetForTests } = await import('../services/Telemetry.js')
    __resetForTests()
    const context = makeContext()
    initializeTelemetry(context, '1.2.3')
    const stored = context.globalState.get<string>('skillsmith.cohortId')
    expect(stored).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('reuses persisted cohort id on subsequent init', async () => {
    const { initializeTelemetry, __resetForTests } = await import('../services/Telemetry.js')
    __resetForTests()
    const existing = '11111111-2222-3333-4444-555555555555'
    const context = makeContext(existing)
    initializeTelemetry(context, '1.2.3')
    expect(context.globalState.get('skillsmith.cohortId')).toBe(existing)
  })

  it('skips fetch when VS Code global telemetry is disabled', async () => {
    isTelemetryEnabledGetter.mockReturnValue(false)
    getConfigMock.mockReturnValue(true)
    const { initializeTelemetry, track, __resetForTests } = await import('../services/Telemetry.js')
    __resetForTests()
    initializeTelemetry(makeContext(), '1.2.3')
    track('vscode_create_start')
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips fetch when skillsmith.telemetry.enabled is false', async () => {
    getConfigMock.mockImplementation((k: string, d: unknown) =>
      k === 'telemetry.enabled' ? false : d
    )
    const { initializeTelemetry, track, __resetForTests } = await import('../services/Telemetry.js')
    __resetForTests()
    initializeTelemetry(makeContext(), '1.2.3')
    track('vscode_create_start')
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips fetch when telemetryEndpoint is empty (default)', async () => {
    getConfigMock.mockImplementation((k: string, d: unknown) => {
      if (k === 'telemetry.enabled') return true
      if (k === 'telemetryEndpoint') return ''
      return d
    })
    const { initializeTelemetry, track, __resetForTests } = await import('../services/Telemetry.js')
    __resetForTests()
    initializeTelemetry(makeContext(), '1.2.3')
    track('vscode_create_start')
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts event payload when endpoint is configured', async () => {
    getConfigMock.mockImplementation((k: string, d: unknown) => {
      if (k === 'telemetry.enabled') return true
      if (k === 'telemetryEndpoint') return 'https://example.com/functions/v1/events'
      return d
    })
    const { initializeTelemetry, track, __resetForTests } = await import('../services/Telemetry.js')
    __resetForTests()
    initializeTelemetry(makeContext('cohort-abc'), '9.9.9')
    track('vscode_create_complete', { type: 'basic' })
    await new Promise((r) => setTimeout(r, 10))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.com/functions/v1/events')
    const body = JSON.parse(init.body as string)
    expect(body.event).toBe('vscode_create_complete')
    expect(body.anonymous_id).toBe('cohort-abc')
    expect(body.metadata).toMatchObject({
      type: 'basic',
      extension_version: '9.9.9',
      vscode_version: '1.110.0',
    })
  })

  it('swallows fetch errors without throwing', async () => {
    getConfigMock.mockImplementation((k: string, d: unknown) => {
      if (k === 'telemetry.enabled') return true
      if (k === 'telemetryEndpoint') return 'https://example.com/x'
      return d
    })
    fetchMock.mockRejectedValue(new Error('network down'))
    const { initializeTelemetry, track, __resetForTests } = await import('../services/Telemetry.js')
    __resetForTests()
    initializeTelemetry(makeContext(), '1.2.3')
    expect(() => track('vscode_create_failed', { reason: 'x' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))
  })
})

// Restore real fetch after suite
globalThis.fetch = originalFetch
