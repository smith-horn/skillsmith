/**
 * SMI-3672: Tests for skill content rendering (skill-panel-content.ts)
 */
import { describe, it, expect } from 'vitest'
import {
  getContentHtml,
  getContentStyles,
  renderMarkdown,
  SANITIZE_OPTIONS,
} from '../views/skill-panel-content.js'

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

  it('does not truncate when showFullContent is true', () => {
    const longContent = 'x'.repeat(20_000)
    const html = getContentHtml(longContent, true)
    expect(html).not.toContain('Content truncated')
    expect(html).not.toContain('expandContentBtn')
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

describe('renderMarkdown', () => {
  it('renders basic markdown to HTML', () => {
    const html = renderMarkdown('**bold** and *italic*')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
  })

  it('renders headings', () => {
    const html = renderMarkdown('# Title')
    expect(html).toContain('<h1')
    expect(html).toContain('Title')
  })

  it('renders links with href', () => {
    const html = renderMarkdown('[GitHub](https://github.com)')
    expect(html).toContain('href="https://github.com"')
    expect(html).toContain('GitHub')
  })

  it('renders unordered lists', () => {
    const html = renderMarkdown('- item one\n- item two')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>item one</li>')
  })

  it('strips <script> tags (XSS prevention)', () => {
    const html = renderMarkdown('<script>alert("xss")</script>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert')
  })

  it('strips javascript: URLs', () => {
    const html = renderMarkdown('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('strips event handler attributes', () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">')
    expect(html).not.toContain('onerror')
  })

  it('allows https links', () => {
    const html = renderMarkdown('[safe](https://example.com)')
    expect(html).toContain('href="https://example.com"')
  })

  it('allows code blocks', () => {
    const html = renderMarkdown('`inline code`')
    expect(html).toContain('<code>')
    expect(html).toContain('inline code')
  })
})

describe('SANITIZE_OPTIONS', () => {
  it('allows heading tags', () => {
    expect(SANITIZE_OPTIONS.allowedTags).toContain('h1')
    expect(SANITIZE_OPTIONS.allowedTags).toContain('h2')
    expect(SANITIZE_OPTIONS.allowedTags).toContain('h3')
  })

  it('allows img tag', () => {
    expect(SANITIZE_OPTIONS.allowedTags).toContain('img')
  })

  it('allows code and pre tags', () => {
    expect(SANITIZE_OPTIONS.allowedTags).toContain('code')
    expect(SANITIZE_OPTIONS.allowedTags).toContain('pre')
  })

  it('only allows https and http schemes', () => {
    expect(SANITIZE_OPTIONS.allowedSchemes).toEqual(['https', 'http'])
  })

  it('allows href, title, target, rel on links', () => {
    const attrs = SANITIZE_OPTIONS.allowedAttributes as Record<string, string[]>
    expect(attrs['a']).toContain('href')
    expect(attrs['a']).toContain('rel')
  })
})
