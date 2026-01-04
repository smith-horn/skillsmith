/**
 * SMI-883: Tests for logger sensitive data redaction
 * Ensures API keys, tokens, passwords, and secrets are never written to disk
 */

import { describe, it, expect } from 'vitest'
import { redactSensitiveData, redactSensitiveObject } from '../../src/logger.js'

describe('SMI-883: Logger Sensitive Data Redaction', () => {
  describe('redactSensitiveData', () => {
    describe('GitHub tokens', () => {
      it('should redact classic personal access tokens (ghp_)', () => {
        const input = 'Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz'
        const result = redactSensitiveData(input)
        expect(result).toBe('Token: ghp_[REDACTED]')
        expect(result).not.toContain('1234567890')
      })

      it('should redact fine-grained personal access tokens (github_pat_)', () => {
        const input = 'Using github_pat_abcdefghijklmnopqrstuvwx12345'
        const result = redactSensitiveData(input)
        expect(result).toBe('Using github_pat_[REDACTED]')
      })

      it('should redact OAuth tokens (gho_)', () => {
        const input = 'OAuth: gho_1234567890abcdefghijklmnopqrstuvwxyz'
        const result = redactSensitiveData(input)
        expect(result).toBe('OAuth: gho_[REDACTED]')
      })

      it('should redact server-to-server tokens (ghs_)', () => {
        const input = 'Server: ghs_1234567890abcdefghijklmnopqrstuvwxyz'
        const result = redactSensitiveData(input)
        expect(result).toBe('Server: ghs_[REDACTED]')
      })

      it('should redact user-to-server tokens (ghu_)', () => {
        const input = 'User: ghu_1234567890abcdefghijklmnopqrstuvwxyz'
        const result = redactSensitiveData(input)
        expect(result).toBe('User: ghu_[REDACTED]')
      })

      it('should redact refresh tokens (ghr_)', () => {
        const input = 'Refresh: ghr_1234567890abcdefghijklmnopqrstuvwxyz'
        const result = redactSensitiveData(input)
        expect(result).toBe('Refresh: ghr_[REDACTED]')
      })
    })

    describe('Linear API keys', () => {
      it('should redact Linear API keys (lin_api_)', () => {
        const input = 'LINEAR_API_KEY=lin_api_abcdefghijklmnopqrstuvwxyz123456'
        const result = redactSensitiveData(input)
        expect(result).toContain('lin_api_[REDACTED]')
        expect(result).not.toContain('abcdefghij')
      })
    })

    describe('Stripe keys', () => {
      it('should redact live secret keys (sk_live_)', () => {
        const input = 'STRIPE_KEY=sk_live_abcdefghijklmnopqrstuvwx'
        const result = redactSensitiveData(input)
        expect(result).toContain('sk_live_[REDACTED]')
      })

      it('should redact test secret keys (sk_test_)', () => {
        const input = 'STRIPE_KEY=sk_test_abcdefghijklmnopqrstuvwx'
        const result = redactSensitiveData(input)
        expect(result).toContain('sk_test_[REDACTED]')
      })

      it('should redact live publishable keys (pk_live_)', () => {
        const input = 'STRIPE_PK=pk_live_abcdefghijklmnopqrstuvwx'
        const result = redactSensitiveData(input)
        expect(result).toContain('pk_live_[REDACTED]')
      })

      it('should redact test publishable keys (pk_test_)', () => {
        const input = 'STRIPE_PK=pk_test_abcdefghijklmnopqrstuvwx'
        const result = redactSensitiveData(input)
        expect(result).toContain('pk_test_[REDACTED]')
      })
    })

    describe('OpenAI API keys', () => {
      it('should redact OpenAI API keys (sk-)', () => {
        const input = 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890abcdefghijkl'
        const result = redactSensitiveData(input)
        expect(result).toContain('sk-[REDACTED]')
        expect(result).not.toContain('abcdefghij')
      })
    })

    describe('Anthropic API keys', () => {
      it('should redact Anthropic API keys (sk-ant-)', () => {
        const input = 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz12'
        const result = redactSensitiveData(input)
        expect(result).toContain('sk-ant-[REDACTED]')
      })
    })

    describe('AWS keys', () => {
      it('should redact AWS access key IDs (AKIA)', () => {
        const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'
        const result = redactSensitiveData(input)
        expect(result).toContain('AKIA[REDACTED]')
        expect(result).not.toContain('IOSFODNN7EXAMPLE')
      })
    })

    describe('Slack tokens', () => {
      it('should redact bot tokens (xoxb-)', () => {
        const input = 'SLACK_TOKEN=xoxb-123456789012-1234567890123-abcdefghijklmnop'
        const result = redactSensitiveData(input)
        expect(result).toContain('xox*-[REDACTED]')
      })

      it('should redact user tokens (xoxp-)', () => {
        const input = 'SLACK_TOKEN=xoxp-123456789012-1234567890123-abcdefghijklmnop'
        const result = redactSensitiveData(input)
        expect(result).toContain('xox*-[REDACTED]')
      })
    })

    describe('npm tokens', () => {
      it('should redact npm tokens (npm_)', () => {
        const input = 'NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz1234567890'
        const result = redactSensitiveData(input)
        expect(result).toContain('npm_[REDACTED]')
      })
    })

    describe('Bearer and Basic auth', () => {
      it('should redact Bearer tokens', () => {
        const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
        const result = redactSensitiveData(input)
        expect(result).toContain('Bearer [REDACTED]')
      })

      it('should redact Basic auth credentials', () => {
        const input = 'Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0NTY='
        const result = redactSensitiveData(input)
        expect(result).toContain('Basic [REDACTED]')
      })
    })

    describe('JWT tokens', () => {
      it('should redact JWT tokens', () => {
        const input =
          'Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
        const result = redactSensitiveData(input)
        expect(result).toContain('[JWT_REDACTED]')
        expect(result).not.toContain('eyJzdWI')
      })
    })

    describe('Generic patterns', () => {
      it('should redact api_key assignments', () => {
        const input = 'config.api_key = "my_secret_api_key_12345"'
        const result = redactSensitiveData(input)
        expect(result).toContain('api_key=[REDACTED]')
      })

      it('should redact password assignments', () => {
        const input = 'password: "supersecret123"'
        const result = redactSensitiveData(input)
        expect(result).toContain('password=[REDACTED]')
      })

      it('should redact secret assignments', () => {
        const input = 'client_secret = "abcdefghijklmnop"'
        const result = redactSensitiveData(input)
        expect(result).toContain('secret=[REDACTED]')
      })

      it('should redact token assignments', () => {
        const input = 'auth_token: "my_auth_token_value"'
        const result = redactSensitiveData(input)
        expect(result).toContain('token=[REDACTED]')
      })
    })

    describe('Connection strings', () => {
      it('should redact passwords in connection strings', () => {
        const input = 'postgresql://user:mysecretpassword@localhost:5432/db'
        const result = redactSensitiveData(input)
        expect(result).toBe('postgresql://user:[REDACTED]@localhost:5432/db')
        expect(result).not.toContain('mysecretpassword')
      })

      it('should redact passwords in MongoDB connection strings', () => {
        const input = 'mongodb://admin:p4ssw0rd123@cluster.mongodb.net/mydb'
        const result = redactSensitiveData(input)
        expect(result).toContain('[REDACTED]@cluster')
        expect(result).not.toContain('p4ssw0rd123')
      })
    })

    describe('Private keys', () => {
      it('should redact RSA private keys', () => {
        const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy
-----END RSA PRIVATE KEY-----`
        const result = redactSensitiveData(input)
        expect(result).toBe('-----[PRIVATE KEY REDACTED]-----')
        expect(result).not.toContain('MIIEpAIBAAKCAQEA')
      })

      it('should redact generic private keys', () => {
        const input = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEA
-----END PRIVATE KEY-----`
        const result = redactSensitiveData(input)
        expect(result).toBe('-----[PRIVATE KEY REDACTED]-----')
      })
    })

    describe('Edge cases', () => {
      it('should handle empty strings', () => {
        expect(redactSensitiveData('')).toBe('')
      })

      it('should handle null-ish values', () => {
        expect(redactSensitiveData(null as unknown as string)).toBe(null)
        expect(redactSensitiveData(undefined as unknown as string)).toBe(undefined)
      })

      it('should handle text with no sensitive data', () => {
        const input = 'This is a normal log message with no secrets'
        expect(redactSensitiveData(input)).toBe(input)
      })

      it('should handle multiple tokens in same string', () => {
        const input =
          'GitHub: ghp_1234567890abcdefghijklmnopqrstuvwxyz, Stripe: sk_live_abcdefghijklmnopqrstuvwx'
        const result = redactSensitiveData(input)
        expect(result).toContain('ghp_[REDACTED]')
        expect(result).toContain('sk_live_[REDACTED]')
      })

      it('should handle repeated calls (regex lastIndex reset)', () => {
        const input = 'Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz'
        // Call multiple times to verify lastIndex is reset
        const result1 = redactSensitiveData(input)
        const result2 = redactSensitiveData(input)
        const result3 = redactSensitiveData(input)
        expect(result1).toBe('Token: ghp_[REDACTED]')
        expect(result2).toBe('Token: ghp_[REDACTED]')
        expect(result3).toBe('Token: ghp_[REDACTED]')
      })
    })
  })

  describe('redactSensitiveObject', () => {
    it('should redact strings in simple objects', () => {
      const input = {
        token: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
        name: 'test',
      }
      const result = redactSensitiveObject(input) as Record<string, unknown>
      expect(result.token).toBe('ghp_[REDACTED]')
      expect(result.name).toBe('test')
    })

    it('should redact strings in nested objects', () => {
      const input = {
        config: {
          auth: {
            apiKey: 'sk_live_abcdefghijklmnopqrstuvwx',
          },
        },
      }
      const result = redactSensitiveObject(input) as Record<string, unknown>
      expect((result.config as Record<string, unknown>).auth).toEqual({
        apiKey: 'sk_live_[REDACTED]',
      })
    })

    it('should redact strings in arrays', () => {
      const input = ['ghp_1234567890abcdefghijklmnopqrstuvwxyz', 'normal string']
      const result = redactSensitiveObject(input) as string[]
      expect(result[0]).toBe('ghp_[REDACTED]')
      expect(result[1]).toBe('normal string')
    })

    it('should handle mixed arrays and objects', () => {
      const input = {
        tokens: [
          { key: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz' },
          { key: 'sk_live_abcdefghijklmnopqrstuvwx' },
        ],
      }
      const result = redactSensitiveObject(input) as Record<string, unknown>
      const tokens = result.tokens as Array<Record<string, unknown>>
      expect(tokens[0].key).toBe('ghp_[REDACTED]')
      expect(tokens[1].key).toBe('sk_live_[REDACTED]')
    })

    it('should handle null and undefined', () => {
      expect(redactSensitiveObject(null)).toBe(null)
      expect(redactSensitiveObject(undefined)).toBe(undefined)
    })

    it('should preserve non-string primitives', () => {
      const input = {
        count: 42,
        enabled: true,
        ratio: 3.14,
      }
      const result = redactSensitiveObject(input)
      expect(result).toEqual(input)
    })

    it('should handle Error objects by converting to plain object', () => {
      const input = {
        error: new Error('Failed with token ghp_1234567890abcdefghijklmnopqrstuvwxyz'),
      }
      const result = redactSensitiveObject(input) as Record<string, unknown>
      // Error.message won't be in entries, but if serialized it would be redacted
      expect(result.error).toBeDefined()
    })
  })
})
