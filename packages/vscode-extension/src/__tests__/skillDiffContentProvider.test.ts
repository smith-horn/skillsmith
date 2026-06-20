/**
 * Unit tests for views/skillDiffContentProvider.ts (SMI-5323).
 *
 * The provider is a tiny in-memory store keyed by URI; we mock `vscode.Uri.parse`
 * to a stable identity so `setContent` and `provideTextDocumentContent` round-trip.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('vscode', () => ({
  Uri: {
    parse: (s: string) => ({ toString: () => s }),
  },
}))

import * as vscode from 'vscode'
import { SkillDiffContentProvider } from '../views/skillDiffContentProvider.js'

describe('SkillDiffContentProvider (SMI-5323)', () => {
  it('exposes the skillsmith-diff scheme', () => {
    expect(SkillDiffContentProvider.scheme).toBe('skillsmith-diff')
  })

  it('setContent returns a skillsmith-diff URI and serves the stored text', () => {
    const provider = new SkillDiffContentProvider()
    const uri = provider.setContent('org%2Ffoo/installed.md', 'old text')

    expect(uri.toString()).toBe('skillsmith-diff:org%2Ffoo/installed.md')
    expect(provider.provideTextDocumentContent(uri)).toBe('old text')
  })

  it('returns an empty string for an unknown URI', () => {
    const provider = new SkillDiffContentProvider()
    const unknown = vscode.Uri.parse('skillsmith-diff:never/set.md')

    expect(provider.provideTextDocumentContent(unknown)).toBe('')
  })

  it('overwrites content for the same path so the map cannot grow unbounded', () => {
    const provider = new SkillDiffContentProvider()
    const first = provider.setContent('k/latest.md', 'v1')
    const second = provider.setContent('k/latest.md', 'v2')

    expect(first.toString()).toBe(second.toString())
    expect(provider.provideTextDocumentContent(second)).toBe('v2')
  })
})
