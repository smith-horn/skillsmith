/**
 * SMI-4244: buildClientEventBatcher test-environment detection
 *
 * Verifies that EventBatcher instances created via buildClientEventBatcher
 * do NOT attach process-exit listeners when running under vitest (detected
 * via process.env.VITEST === 'true'). This prevents MaxListenersExceededWarning
 * and the racy SIGTERM delivery observed in publish.yml Validate job test runs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildClientEventBatcher, type BatchPostContext } from '../../src/api/client.events.js'

describe('SMI-4244: buildClientEventBatcher exit handler suppression', () => {
  const originalVitest = process.env.VITEST

  const ctx = (): BatchPostContext => ({
    baseUrl: 'https://example.test',
    anonKey: 'anon',
    apiKey: undefined,
    timeout: 1_000,
  })

  beforeEach(() => {
    // Snapshot restored by afterEach; each test sets VITEST explicitly.
  })

  afterEach(() => {
    if (originalVitest === undefined) {
      delete process.env.VITEST
    } else {
      process.env.VITEST = originalVitest
    }
  })

  it('does NOT attach SIGTERM/SIGINT/beforeExit listeners when VITEST=true', () => {
    process.env.VITEST = 'true'

    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      beforeExit: process.listenerCount('beforeExit'),
    }

    const batcher = buildClientEventBatcher(ctx)

    const after = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      beforeExit: process.listenerCount('beforeExit'),
    }

    expect(after.sigterm).toBe(before.sigterm)
    expect(after.sigint).toBe(before.sigint)
    expect(after.beforeExit).toBe(before.beforeExit)

    // Dispose is a no-op when no handlers were attached, but call it for hygiene.
    batcher.dispose()
  })

  it('DOES attach SIGTERM/SIGINT/beforeExit listeners when VITEST is unset', () => {
    delete process.env.VITEST

    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      beforeExit: process.listenerCount('beforeExit'),
    }

    const batcher = buildClientEventBatcher(ctx)

    const after = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      beforeExit: process.listenerCount('beforeExit'),
    }

    expect(after.sigterm).toBe(before.sigterm + 1)
    expect(after.sigint).toBe(before.sigint + 1)
    expect(after.beforeExit).toBe(before.beforeExit + 1)

    // Clean up so we don't pollute other tests' listener counts.
    batcher.dispose()

    const cleaned = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      beforeExit: process.listenerCount('beforeExit'),
    }
    expect(cleaned.sigterm).toBe(before.sigterm)
    expect(cleaned.sigint).toBe(before.sigint)
    expect(cleaned.beforeExit).toBe(before.beforeExit)
  })

  it('DOES attach listeners when VITEST is set to a non-"true" value', () => {
    process.env.VITEST = '1'

    const before = process.listenerCount('SIGTERM')
    const batcher = buildClientEventBatcher(ctx)
    const after = process.listenerCount('SIGTERM')

    expect(after).toBe(before + 1)

    batcher.dispose()
  })
})
