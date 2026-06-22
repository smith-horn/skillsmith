/**
 * Tests for compare-source.ts (SMI-5340).
 *
 * Covers: set/get/clear lifecycle + the `setContext` calls that drive the
 * `skillsmith.compareSourceSet` VS Code context key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── hoisted spies ─────────────────────────────────────────────────────────────
const executeCommand = vi.hoisted(() => vi.fn())

// ── vscode mock ───────────────────────────────────────────────────────────────
// compare-source.ts only uses `vscode.commands.executeCommand` — a minimal stub
// is sufficient. No module-scope call touches it (see file header), so the mock
// does not need to handle import-time invocations.
vi.mock('vscode', () => ({
  commands: { executeCommand },
  window: {},
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  env: {},
  Uri: {},
}))

// ── SUT ───────────────────────────────────────────────────────────────────────
import {
  getCompareSource,
  setCompareSource,
  clearCompareSource,
} from '../commands/compare-source.js'

const CONTEXT_KEY = 'skillsmith.compareSourceSet'

describe('compare-source (SMI-5340)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset module state: clear any source left over from a previous test.
    clearCompareSource()
    // clearCompareSource will have called executeCommand — reset after the cleanup.
    vi.clearAllMocks()
  })

  it('getCompareSource returns undefined when nothing has been set', () => {
    expect(getCompareSource()).toBeUndefined()
  })

  it('setCompareSource stores the id and returns it via getCompareSource', () => {
    setCompareSource('org/my-skill')
    expect(getCompareSource()).toBe('org/my-skill')
  })

  it('setCompareSource calls setContext with key and true', () => {
    setCompareSource('org/my-skill')
    expect(executeCommand).toHaveBeenCalledWith('setContext', CONTEXT_KEY, true)
  })

  it('clearCompareSource removes the stored id', () => {
    setCompareSource('org/my-skill')
    clearCompareSource()
    expect(getCompareSource()).toBeUndefined()
  })

  it('clearCompareSource calls setContext with key and false', () => {
    setCompareSource('org/my-skill')
    vi.clearAllMocks() // reset call record so only clearCompareSource shows
    clearCompareSource()
    expect(executeCommand).toHaveBeenCalledWith('setContext', CONTEXT_KEY, false)
    expect(executeCommand).toHaveBeenCalledTimes(1)
  })

  it('setCompareSource overwrites a previously-set id', () => {
    setCompareSource('org/skill-a')
    setCompareSource('org/skill-b')
    expect(getCompareSource()).toBe('org/skill-b')
    // setContext called twice — both with true
    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(executeCommand).toHaveBeenNthCalledWith(1, 'setContext', CONTEXT_KEY, true)
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'setContext', CONTEXT_KEY, true)
  })

  it('setContext key is exactly "skillsmith.compareSourceSet"', () => {
    setCompareSource('org/x')
    const [, key] = executeCommand.mock.calls[0] as [string, string, boolean]
    expect(key).toBe('skillsmith.compareSourceSet')
  })
})
