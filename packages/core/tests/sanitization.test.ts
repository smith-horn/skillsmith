/**
 * SMI-732: Input Sanitization Tests
 *
 * Comprehensive test suite for input sanitization functions
 */

import { describe, it, expect } from 'vitest'
import {
  sanitizeHtml,
  sanitizeFileName,
  sanitizePath,
  sanitizeUrl,
  sanitizeText,
} from '../src/security/sanitization.js'

describe('sanitization', () => {
  describe('sanitizeHtml', () => {
    it('should remove script tags', () => {
      const input = '<p>Hello</p><script>alert("XSS")</script><p>World</p>'
      const result = sanitizeHtml(input)
      expect(result).not.toContain('<script>')
      expect(result).not.toContain('alert')
      expect(result).toContain('<p>Hello</p>')
      expect(result).toContain('<p>World</p>')
    })

    it('should remove event handlers', () => {
      const tests = [
        '<div onclick="alert(1)">Click</div>',
        '<img onerror="alert(1)" src="x">',
        '<body onload="doEvil()">',
        '<a href="#" onmouseover="hack()">Link</a>',
      ]

      for (const input of tests) {
        const result = sanitizeHtml(input)
        expect(result).not.toMatch(/on\w+\s*=/i)
      }
    })

    it('should remove javascript: protocol', () => {
      const input = '<a href="javascript:alert(1)">Click</a>'
      const result = sanitizeHtml(input)
      expect(result).not.toContain('javascript:')
    })

    it('should remove data: protocol for HTML', () => {
      const input = '<object data="data:text/html,<script>alert(1)</script>"></object>'
      const result = sanitizeHtml(input)
      expect(result).not.toContain('data:text/html')
    })

    it('should remove object, embed, iframe tags', () => {
      const tests = [
        '<object data="malware.swf"></object>',
        '<embed src="malware.swf">',
        '<iframe src="evil.com"></iframe>',
      ]

      for (const input of tests) {
        const result = sanitizeHtml(input)
        expect(result).not.toMatch(/<(object|embed|iframe)/i)
      }
    })

    it('should remove style tags', () => {
      const input = '<p>Safe</p><style>body { background: url("javascript:alert(1)") }</style>'
      const result = sanitizeHtml(input)
      expect(result).not.toContain('<style>')
      expect(result).toContain('<p>Safe</p>')
    })

    it('should preserve safe HTML', () => {
      const input = '<h1>Title</h1><p>Paragraph with <strong>bold</strong> and <em>italic</em></p>'
      const result = sanitizeHtml(input)
      expect(result).toBe(input)
    })

    it('should handle empty input', () => {
      expect(sanitizeHtml('')).toBe('')
      expect(sanitizeHtml(null as unknown as string)).toBe('')
      expect(sanitizeHtml(undefined as unknown as string)).toBe('')
    })

    it('should handle non-string input', () => {
      expect(sanitizeHtml(123 as unknown as string)).toBe('')
      expect(sanitizeHtml({} as unknown as string)).toBe('')
    })
  })

  describe('sanitizeFileName', () => {
    it('should allow valid file names', () => {
      const validNames = ['file.txt', 'my-document.pdf', 'image_001.png', 'Data File.csv']

      for (const name of validNames) {
        expect(sanitizeFileName(name)).toBe(name)
      }
    })

    it('should remove path separators', () => {
      expect(sanitizeFileName('path/to/file.txt')).toBe('pathtofile.txt')
      expect(sanitizeFileName('path\\to\\file.txt')).toBe('pathtofile.txt')
      expect(sanitizeFileName('C:\\Windows\\System32\\file.dll')).toBe('CWindowsSystem32file.dll')
    })

    it('should remove parent directory references', () => {
      expect(sanitizeFileName('../../etc/passwd')).toBe('etcpasswd')
      expect(sanitizeFileName('..\\..\\windows\\system32')).toBe('windowssystem32')
      expect(sanitizeFileName('....')).toBe('')
    })

    it('should remove leading dots (hidden files)', () => {
      expect(sanitizeFileName('.hidden')).toBe('hidden')
      expect(sanitizeFileName('..hidden')).toBe('hidden')
      expect(sanitizeFileName('...config')).toBe('config')
    })

    it('should remove control characters', () => {
      expect(sanitizeFileName('file\x00name.txt')).toBe('filename.txt')
      expect(sanitizeFileName('file\n\r\tname.txt')).toBe('filename.txt')
    })

    it('should remove special characters', () => {
      expect(sanitizeFileName('file<>:"|?*.txt')).toBe('file.txt')
      expect(sanitizeFileName('file@#$%^&.txt')).toBe('file.txt')
    })

    it('should handle reserved Windows file names', () => {
      const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1']

      for (const name of reserved) {
        const result = sanitizeFileName(name)
        expect(result).toBe(`${name}_safe`)
      }

      // With extensions
      expect(sanitizeFileName('CON.txt')).toBe('CON.txt_safe')
      expect(sanitizeFileName('con.txt')).toBe('con.txt_safe') // case-insensitive
    })

    it('should handle empty input', () => {
      expect(sanitizeFileName('')).toBe('')
      expect(sanitizeFileName(null as unknown as string)).toBe('')
      expect(sanitizeFileName(undefined as unknown as string)).toBe('')
    })

    it('should handle too long file names', () => {
      const longName = 'a'.repeat(300)
      expect(sanitizeFileName(longName)).toBe('')
    })

    it('should trim whitespace', () => {
      expect(sanitizeFileName('  file.txt  ')).toBe('file.txt')
      expect(sanitizeFileName('\tfile.txt\n')).toBe('file.txt')
    })

    it('should collapse multiple spaces', () => {
      expect(sanitizeFileName('my    file.txt')).toBe('my file.txt')
    })

    it('should collapse multiple dots', () => {
      expect(sanitizeFileName('file....txt')).toBe('file.txt')
      expect(sanitizeFileName('my...file...txt')).toBe('my.file.txt')
    })
  })

  describe('sanitizePath', () => {
    it('should allow safe relative paths', () => {
      const safePaths = ['user/files/doc.txt', 'data/images/photo.jpg', 'config/settings.json']

      for (const path of safePaths) {
        expect(sanitizePath(path)).toBe(path)
      }
    })

    it('should block parent directory references', () => {
      expect(sanitizePath('../../../etc/passwd')).toBe('')
      expect(sanitizePath('user/../../etc/passwd')).toBe('user')
      expect(sanitizePath('./../../file.txt')).toBe('')
    })

    it('should normalize path separators', () => {
      expect(sanitizePath('user\\files\\doc.txt')).toBe('user/files/doc.txt')
      expect(sanitizePath('path\\to/mixed\\separators')).toBe('path/to/mixed/separators')
    })

    it('should remove empty segments', () => {
      expect(sanitizePath('path//to///file.txt')).toBe('path/to/file.txt')
      expect(sanitizePath('path/./to/./file.txt')).toBe('path/to/file.txt')
    })

    it('should handle absolute paths', () => {
      expect(sanitizePath('/home/user/file.txt')).toBe('/home/user/file.txt')
      expect(sanitizePath('/etc/passwd')).toBe('/etc/passwd')
    })

    it('should validate against root directory', () => {
      const rootDir = '/app/data'

      // Valid paths within root
      expect(sanitizePath('user/files/doc.txt', rootDir)).toBe('user/files/doc.txt')
      expect(sanitizePath('files/doc.txt', rootDir)).toBe('files/doc.txt')

      // Invalid paths escaping root
      expect(sanitizePath('../../../etc/passwd', rootDir)).toBe('')
      expect(sanitizePath('../../sensitive', rootDir)).toBe('')
    })

    it('should remove control characters from segments', () => {
      expect(sanitizePath('path/\x00to/file.txt')).toBe('path/file.txt')
      expect(sanitizePath('path/to\n/file.txt')).toBe('path/file.txt')
    })

    it('should handle empty input', () => {
      expect(sanitizePath('')).toBe('')
      expect(sanitizePath(null as unknown as string)).toBe('')
      expect(sanitizePath(undefined as unknown as string)).toBe('')
    })

    it('should sanitize each segment as a file name', () => {
      expect(sanitizePath('user/../file.txt')).toBe('user/file.txt')
      expect(sanitizePath('path/to/<script>/file')).toBe('path/to/script/file')
    })
  })

  describe('sanitizeUrl', () => {
    it('should allow valid HTTP/HTTPS URLs', () => {
      const validUrls = [
        'https://example.com',
        'http://example.com/path/to/resource',
        'https://subdomain.example.com:8080/path?query=value',
      ]

      for (const url of validUrls) {
        const result = sanitizeUrl(url)
        expect(result).toBeTruthy()
        expect(result).toMatch(/^https?:\/\//)
      }
    })

    it('should block javascript: protocol', () => {
      expect(sanitizeUrl('javascript:alert(1)')).toBe('')
      expect(sanitizeUrl('JavaScript:alert(1)')).toBe('')
    })

    it('should block data: protocol', () => {
      expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('')
    })

    it('should block vbscript: protocol', () => {
      expect(sanitizeUrl('vbscript:msgbox(1)')).toBe('')
    })

    it('should block file: protocol', () => {
      expect(sanitizeUrl('file:///etc/passwd')).toBe('')
    })

    it('should block URLs with embedded credentials', () => {
      expect(sanitizeUrl('https://user:pass@example.com')).toBe('')
      expect(sanitizeUrl('http://admin@example.com')).toBe('')
    })

    it('should remove control characters', () => {
      expect(sanitizeUrl('https://example.com\x00/path')).toBe('https://example.com/path')
      expect(sanitizeUrl('https://example.com\n/path')).toBe('https://example.com/path')
    })

    it('should handle empty input', () => {
      expect(sanitizeUrl('')).toBe('')
      expect(sanitizeUrl(null as unknown as string)).toBe('')
      expect(sanitizeUrl(undefined as unknown as string)).toBe('')
    })

    it('should handle invalid URL format', () => {
      expect(sanitizeUrl('not-a-url')).toBe('')
      expect(sanitizeUrl('htp://broken')).toBe('')
      expect(sanitizeUrl('://missing-protocol')).toBe('')
    })

    it('should trim whitespace', () => {
      expect(sanitizeUrl('  https://example.com  ')).toBe('https://example.com/')
    })

    it('should normalize URLs', () => {
      // URL constructor normalizes and adds trailing slash to domain-only URLs
      expect(sanitizeUrl('https://example.com')).toBe('https://example.com/')
      expect(sanitizeUrl('https://example.com/')).toBe('https://example.com/')
    })
  })

  describe('sanitizeText', () => {
    it('should remove control characters except newline and tab', () => {
      expect(sanitizeText('Hello\x00World')).toBe('HelloWorld')
      expect(sanitizeText('Test\x1fString')).toBe('TestString')
      expect(sanitizeText('Keep\nNewline\tTab')).toBe('Keep\nNewline\tTab')
    })

    it('should remove zero-width characters', () => {
      expect(sanitizeText('Hello\u200bWorld')).toBe('HelloWorld')
      expect(sanitizeText('Test\u200c\u200d\ufeffString')).toBe('TestString')
    })

    it('should normalize Unicode', () => {
      // é can be represented as single char or combining char
      const composed = '\u00e9' // é as single character
      const decomposed = 'e\u0301' // e + combining acute accent
      const result = sanitizeText(decomposed)
      expect(result).toBe(composed) // NFC normalization
    })

    it('should trim whitespace', () => {
      expect(sanitizeText('  Hello World  ')).toBe('Hello World')
      expect(sanitizeText('\n\tTest\n\t')).toBe('Test')
    })

    it('should handle empty input', () => {
      expect(sanitizeText('')).toBe('')
      expect(sanitizeText(null as unknown as string)).toBe('')
      expect(sanitizeText(undefined as unknown as string)).toBe('')
    })

    it('should preserve regular text', () => {
      const text = 'This is normal text with punctuation! And numbers: 123.'
      expect(sanitizeText(text)).toBe(text)
    })

    it('should handle emoji and special characters', () => {
      const text = 'Hello 👋 World 🌍'
      expect(sanitizeText(text)).toBe(text)
    })
  })
})
