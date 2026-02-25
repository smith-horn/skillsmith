/**
 * SMI-2754: Error Formatter Builders Tests
 *
 * Tests for the authentication-error builder functions in errorFormatter.builders.ts:
 * - formatAuthenticationError
 * - isAuthenticationError
 * - extractAuthErrorDetails
 */

import { describe, it, expect } from 'vitest'
import {
  formatAuthenticationError,
  isAuthenticationError,
  extractAuthErrorDetails,
} from '../../middleware/errorFormatter.builders.js'

describe('formatAuthenticationError', () => {
  it('returns MCP error response with default URLs when called with no arguments', () => {
    const response = formatAuthenticationError()

    expect(response.isError).toBe(true)
    expect(response.content).toHaveLength(1)
    expect(response.content[0].type).toBe('text')
    expect(response.content[0].text).toContain('Authentication Required')
    expect(response.content[0].text).toContain('https://skillsmith.app/signup')
    expect(response.content[0].text).toContain(
      'https://skillsmith.app/docs/getting-started#api-key'
    )
    expect(response._meta?.errorCode).toBe('AUTHENTICATION_REQUIRED')
    expect(response._meta?.recoverable).toBe(true)
  })

  it('includes trial usage info when trialUsed and trialLimit are both provided', () => {
    const response = formatAuthenticationError({
      trialUsed: 8,
      trialLimit: 10,
    })

    expect(response.content[0].text).toContain('8/10 free requests used')
  })

  it('omits trial usage info when only trialUsed is provided (both required)', () => {
    const response = formatAuthenticationError({ trialUsed: 5 })

    expect(response.content[0].text).not.toContain('free requests used')
  })

  it('uses custom signupUrl and docsUrl when provided in details', () => {
    const response = formatAuthenticationError({
      signupUrl: 'https://custom.example.com/register',
      docsUrl: 'https://custom.example.com/docs',
    })

    expect(response.content[0].text).toContain('https://custom.example.com/register')
    expect(response.content[0].text).toContain('https://custom.example.com/docs')
    expect(response._meta?.upgradeUrl).toBe('https://custom.example.com/register')
  })

  it('includes reason text when provided', () => {
    const response = formatAuthenticationError({
      reason: 'Your free trial has been exhausted.',
    })

    expect(response.content[0].text).toContain('Your free trial has been exhausted.')
  })
})

describe('isAuthenticationError', () => {
  it('returns true when object has statusCode 401', () => {
    expect(isAuthenticationError({ statusCode: 401, message: 'Unauthorized' })).toBe(true)
  })

  it('returns true when object has status 401', () => {
    expect(isAuthenticationError({ status: 401 })).toBe(true)
  })

  it('returns true when message contains "authentication required" (case insensitive)', () => {
    expect(isAuthenticationError({ message: 'Authentication Required for this route' })).toBe(true)
  })

  it('returns true when message contains "free trial exhausted"', () => {
    expect(isAuthenticationError({ message: 'Free trial exhausted, please upgrade' })).toBe(true)
  })

  it('returns true when error field contains "authentication required"', () => {
    expect(isAuthenticationError({ error: 'Authentication required' })).toBe(true)
  })

  it('returns false for an object that does not match any auth pattern', () => {
    expect(isAuthenticationError({ statusCode: 403, message: 'Forbidden' })).toBe(false)
  })

  it('returns false for null input', () => {
    expect(isAuthenticationError(null)).toBe(false)
  })

  it('returns false for non-object input (string)', () => {
    expect(isAuthenticationError('error string')).toBe(false)
  })
})

describe('extractAuthErrorDetails', () => {
  it('returns the details object when present in the error', () => {
    const details = { reason: 'Trial expired', trialUsed: 10, trialLimit: 10 }
    const result = extractAuthErrorDetails({ status: 401, details })

    expect(result).toEqual(details)
  })

  it('returns empty object when no details property is present', () => {
    const result = extractAuthErrorDetails({ status: 401, message: 'Unauthorized' })

    expect(result).toEqual({})
  })

  it('returns empty object for null input', () => {
    expect(extractAuthErrorDetails(null)).toEqual({})
  })

  it('returns empty object for non-object input', () => {
    expect(extractAuthErrorDetails(42)).toEqual({})
  })
})
