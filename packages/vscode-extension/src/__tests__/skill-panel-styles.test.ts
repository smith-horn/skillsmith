/**
 * Tests for skill-panel-styles.ts
 * Verifies extracted CSS contains expected selectors and content styles.
 */
import { describe, it, expect } from 'vitest'
import { getStyles } from '../views/skill-panel-styles.js'

describe('getStyles', () => {
  const css = getStyles()

  it('returns a string', () => {
    expect(typeof css).toBe('string')
  })

  it('contains body styles', () => {
    expect(css).toContain('body {')
    expect(css).toContain('var(--vscode-font-family)')
  })

  it('contains header styles', () => {
    expect(css).toContain('.header {')
    expect(css).toContain('.header h1')
  })

  it('contains badge styles for all canonical tiers', () => {
    expect(css).toContain('.badge-official')
    expect(css).toContain('.badge-verified')
    expect(css).toContain('.badge-curated')
    expect(css).toContain('.badge-community')
    expect(css).toContain('.badge-unverified')
  })

  it('does not contain removed legacy badge classes', () => {
    expect(css).not.toContain('.badge-experimental')
    expect(css).not.toContain('.badge-local')
    expect(css).not.toContain('.badge-unknown')
  })

  it('contains security scan status styles', () => {
    expect(css).toContain('.scan-pass')
    expect(css).toContain('.scan-fail')
    expect(css).toContain('.scan-none')
    expect(css).toContain('.scan-date')
  })

  it('contains WCAG AA compliant community badge color', () => {
    expect(css).toContain('#b8960a')
    expect(css).not.toContain('#ffc107')
  })

  it('contains score bar styles', () => {
    expect(css).toContain('.score-bar')
    expect(css).toContain('.score-fill')
  })

  it('contains action button styles', () => {
    expect(css).toContain('.actions')
    expect(css).toContain('.btn-primary')
    expect(css).toContain('.btn-secondary')
  })

  it('makes the header sticky with an opaque background (SMI-5308)', () => {
    expect(css).toContain('position: sticky')
    expect(css).toContain('top: 0')
    expect(css).toContain('background-color: var(--vscode-editor-background)')
    expect(css).toContain('justify-content: space-between')
  })

  it('defines a destructive button style using VS Code error tokens', () => {
    expect(css).toContain('.btn-destructive')
    expect(css).toContain('var(--vscode-inputValidation-errorBackground)')
    expect(css).toContain('var(--vscode-errorForeground)')
  })

  it('contains repository link styles with focus indicator', () => {
    expect(css).toContain('.repository-link')
    expect(css).toContain('.repository-link:focus')
    expect(css).toContain('var(--vscode-focusBorder)')
  })

  it('contains description heading size cap', () => {
    expect(css).toContain('.description h1')
    expect(css).toContain('font-size: 14px')
  })

  it('contains inferred-label styling', () => {
    expect(css).toContain('.inferred-label')
    expect(css).toContain('font-size: 12px')
  })

  it('includes content styles from skill-panel-content', () => {
    expect(css).toContain('.skill-content')
  })
})
