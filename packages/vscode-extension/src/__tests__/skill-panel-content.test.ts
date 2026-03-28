/**
 * SMI-3672: Tests for skill content rendering (skill-panel-content.ts)
 */
import { describe, it, expect } from 'vitest'
import { getContentHtml, getContentStyles } from '../views/skill-panel-content.js'

describe('getContentHtml', () => {
  it('returns empty string for undefined content', () => {
    expect(getContentHtml(undefined)).toBe('')
  })

  it('returns empty string for empty content', () => {
    expect(getContentHtml('')).toBe('')
  })

  it('renders markdown headings to HTML', () => {
    const html = getContentHtml('# Hello World')
    expect(html).toContain('<h1')
    expect(html).toContain('Hello World')
    expect(html).toContain('class="skill-content"')
  })

  it('renders markdown code blocks', () => {
    const html = getContentHtml('```typescript\nconst x = 1\n```')
    expect(html).toContain('<code')
    expect(html).toContain('const x = 1')
  })

  it('renders markdown links', () => {
    const html = getContentHtml('[Click](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('Click')
  })

  it('strips <script> tags (XSS prevention)', () => {
    const html = getContentHtml('<script>alert("xss")</script>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert')
  })

  it('strips <iframe> tags (XSS prevention)', () => {
    const html = getContentHtml('<iframe src="https://evil.com"></iframe>')
    expect(html).not.toContain('<iframe')
  })

  it('strips event handler attributes (XSS prevention)', () => {
    const html = getContentHtml('<img src="x" onerror="alert(1)">')
    expect(html).not.toContain('onerror')
  })

  it('strips javascript: URLs (XSS prevention)', () => {
    const html = getContentHtml('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('truncates content over 10KB', () => {
    const longContent = 'x'.repeat(20_000)
    const html = getContentHtml(longContent)
    expect(html).toContain('Content truncated')
    expect(html).toContain('expandContentBtn')
  })

  it('does not show truncation notice for short content', () => {
    const html = getContentHtml('Short content')
    expect(html).not.toContain('Content truncated')
  })

  it('wraps content in section with h2', () => {
    const html = getContentHtml('Some content')
    expect(html).toContain('<h2>Skill Content</h2>')
    expect(html).toContain('class="section"')
  })
})

describe('getContentStyles', () => {
  it('returns CSS string with skill-content class', () => {
    const css = getContentStyles()
    expect(css).toContain('.skill-content')
    expect(css).toContain('.skill-content pre')
    expect(css).toContain('.content-truncated')
  })
})
