/**
 * SMI-1473: Mock prompt utilities for E2E tests
 *
 * Provides utilities to mock @inquirer/prompts for non-interactive testing.
 */

import { vi } from 'vitest'

export interface MockPromptResponses {
  input?: Record<string, string>
  confirm?: Record<string, boolean>
  select?: Record<string, string>
}

/**
 * Setup mock responses for inquirer prompts
 */
export function setupMockPrompts(responses: MockPromptResponses) {
  // Mock the @inquirer/prompts module
  vi.mock('@inquirer/prompts', () => ({
    input: vi.fn().mockImplementation(async (opts: { message: string }) => {
      const key = opts.message.toLowerCase()
      for (const [pattern, value] of Object.entries(responses.input || {})) {
        if (key.includes(pattern.toLowerCase())) {
          return value
        }
      }
      return 'test-value'
    }),
    confirm: vi.fn().mockImplementation(async (opts: { message: string }) => {
      const key = opts.message.toLowerCase()
      for (const [pattern, value] of Object.entries(responses.confirm || {})) {
        if (key.includes(pattern.toLowerCase())) {
          return value
        }
      }
      return false
    }),
    select: vi.fn().mockImplementation(async (opts: { message: string }) => {
      const key = opts.message.toLowerCase()
      for (const [pattern, value] of Object.entries(responses.select || {})) {
        if (key.includes(pattern.toLowerCase())) {
          return value
        }
      }
      return 'development'
    }),
  }))
}

/**
 * Clear all mock prompts
 */
export function clearMockPrompts() {
  vi.clearAllMocks()
}
