/**
 * Tests for skill-panel-script.ts
 * Verifies extracted script returns HTML fragment with expected event listeners.
 */
import { describe, it, expect } from 'vitest'
import { getScript } from '../views/skill-panel-script.js'

const NONCE = 'test-nonce-abc123'

describe('getScript', () => {
  const html = getScript(NONCE)

  it('returns an HTML fragment with script tag', () => {
    expect(html).toContain('<script nonce=')
    expect(html).toContain('</script>')
  })

  it('includes the provided nonce', () => {
    expect(html).toContain(`nonce="${NONCE}"`)
  })

  it('acquires VS Code API', () => {
    expect(html).toContain('acquireVsCodeApi()')
  })

  it('includes install button listener', () => {
    expect(html).toContain("getElementById('installBtn')")
    expect(html).toContain("command: 'install'")
  })

  it('includes repository button listener', () => {
    expect(html).toContain("getElementById('repoBtn')")
    expect(html).toContain("command: 'openRepository'")
  })

  it('includes repository link click handler', () => {
    expect(html).toContain("querySelectorAll('.repository-link')")
  })

  it('includes keyboard handler for Enter and Space', () => {
    expect(html).toContain("e.key === 'Enter'")
    expect(html).toContain("e.key === ' '")
  })

  it('includes expand content button listener', () => {
    expect(html).toContain("getElementById('expandContentBtn')")
    expect(html).toContain("command: 'expandContent'")
  })

  it('intercepts markdown link clicks', () => {
    expect(html).toContain('.skill-content a[href], .description a[href]')
    expect(html).toContain("command: 'openExternal'")
  })

  it('only intercepts https and http links', () => {
    expect(html).toContain("url.startsWith('https://')")
    expect(html).toContain("url.startsWith('http://')")
  })
})
