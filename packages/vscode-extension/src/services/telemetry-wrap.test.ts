/**
 * SMI-5143 — behavioral emission tests for the VS Code-local telemetry wrapper.
 *
 * The per-tree coverage test (`commands/__meta__/telemetry-coverage.test.ts`) is
 * brand-only (`isTelemetered`). The core HOF's emission is covered by
 * `packages/core/src/telemetry/wrap.test.ts`, but the VS Code wrapper
 * (`telemetry-wrap.ts`) is a separate impl (it can't import the core HOF — the
 * extension esbuild-bundles standalone), so its emit-via-`track()` path needs
 * its own behavioral coverage. Mirrors wrap.test.ts's mock-the-emitter pattern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./Telemetry.js', () => ({ track: vi.fn() }))

import { track } from './Telemetry.js'
import { withTelemetry, isTelemetered } from './telemetry-wrap.js'

const mockTrack = vi.mocked(track)

beforeEach(() => {
  mockTrack.mockReset()
})

describe('SMI-5130/5143: VS Code telemetry-wrap', () => {
  it('emits vscode_skill_invoke with the normalized skill_id + hardcoded source', async () => {
    async function impl(x: number): Promise<number> {
      return x * 2
    }
    const wrapped = withTelemetry(impl, {
      source: 'vscode-extension',
      extractSkillId: () => 'search',
    })

    const result = await wrapped(3)

    expect(result).toBe(6)
    expect(mockTrack).toHaveBeenCalledOnce()
    expect(mockTrack).toHaveBeenCalledWith('vscode_skill_invoke', {
      skill_id: 'search',
      source: 'vscode-extension',
    })
  })

  it('marks the wrapped function telemetered (and the impl is not)', () => {
    async function impl(): Promise<void> {}
    const wrapped = withTelemetry(impl, {
      source: 'vscode-extension',
      extractSkillId: () => 'create',
    })

    expect(isTelemetered(wrapped)).toBe(true)
    expect(isTelemetered(impl)).toBe(false)
  })

  it('does not break the handler when telemetry throws (fire-and-forget)', async () => {
    mockTrack.mockImplementation(() => {
      throw new Error('telemetry endpoint down')
    })
    async function impl(): Promise<string> {
      return 'ok'
    }
    const wrapped = withTelemetry(impl, {
      source: 'vscode-extension',
      extractSkillId: () => 'install',
    })

    await expect(wrapped()).resolves.toBe('ok')
  })
})
