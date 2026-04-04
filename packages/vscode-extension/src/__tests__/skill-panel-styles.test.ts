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

  it('contains badge styles for all tiers', () => {
    expect(css).toContain('.badge-verified')
    expect(css).toContain('.badge-community')
    expect(css).toContain('.badge-experimental')
    expect(css).toContain('.badge-local')
    expect(css).toContain('.badge-unknown')
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
