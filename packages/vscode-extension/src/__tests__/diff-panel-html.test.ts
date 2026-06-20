/**
 * Tests for the "View full text diff" affordance in diff-panel-html.ts
 * (SMI-5323). Pure HTML builder — no webview needed.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('vscode', () => ({}))

import { getDiffHtml } from '../views/diff-panel-html.js'
import type { McpSkillDiffResponse } from '../mcp/types.js'

const NONCE = 'testNonce1234567890'

function makeResponse(overrides: Partial<McpSkillDiffResponse> = {}): McpSkillDiffResponse {
  return {
    changeType: 'minor',
    recommendation: 'review-then-update',
    sectionsAdded: [],
    sectionsRemoved: [],
    sectionsModified: [],
    riskScoreDelta: null,
    changelog: null,
    ...overrides,
  } as McpSkillDiffResponse
}

describe('getDiffHtml — View full text diff (SMI-5323)', () => {
  it('renders the View full text diff button', () => {
    const html = getDiffHtml('docker', makeResponse(), NONCE)
    expect(html).toContain('id="textDiffBtn"')
    expect(html).toContain('View full text diff')
  })

  it('wires the button to post viewTextDiff under the supplied nonce', () => {
    const html = getDiffHtml('docker', makeResponse(), NONCE)
    expect(html).toContain(`<script nonce="${NONCE}">`)
    expect(html).toContain("command: 'viewTextDiff'")
    expect(html).toContain('acquireVsCodeApi()')
  })

  it('escapes the skill name (no raw markup injection)', () => {
    const html = getDiffHtml('<script>alert(1)</script>', makeResponse(), NONCE)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
