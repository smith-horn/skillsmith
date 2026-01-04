/**
 * SMI-992: Shared Test Utilities for Date/Time Mocking
 *
 * Provides consistent date mocking utilities to eliminate flaky tests
 * caused by timing dependencies on Date.now() and new Date() calls.
 */

import { vi, beforeEach, afterEach } from 'vitest'

/**
 * Fixed timestamp for deterministic testing - January 15, 2024 at 10:00 UTC
 */
export const FIXED_TIMESTAMP = 1705312800000

/**
 * Fixed date object for deterministic testing
 */
export const FIXED_DATE = new Date(FIXED_TIMESTAMP)

/**
 * Fixed ISO string for deterministic testing
 */
export const FIXED_DATE_ISO = FIXED_DATE.toISOString()

/**
 * One day in milliseconds
 */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * One year in milliseconds (365 days)
 */
export const ONE_YEAR_MS = 365 * ONE_DAY_MS

/**
 * Creates a date relative to FIXED_DATE
 * @param daysOffset - Number of days to add (negative for past dates)
 * @returns Date object
 */
export function createRelativeDate(daysOffset: number): Date {
  return new Date(FIXED_TIMESTAMP + daysOffset * ONE_DAY_MS)
}

/**
 * Creates an ISO date string relative to FIXED_DATE
 * @param daysOffset - Number of days to add (negative for past dates)
 * @returns ISO date string
 */
export function createRelativeDateISO(daysOffset: number): string {
  return createRelativeDate(daysOffset).toISOString()
}

/**
 * Sets up fake timers with FIXED_DATE for the current test suite.
 * Call in beforeEach() and pair with cleanupFakeTimers() in afterEach().
 */
export function setupFakeTimers(): void {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_DATE)
}

/**
 * Cleans up fake timers after tests.
 * Call in afterEach() when paired with setupFakeTimers().
 */
export function cleanupFakeTimers(): void {
  vi.useRealTimers()
}

/**
 * Helper to advance fake timers by a specified amount
 * @param ms - Milliseconds to advance
 */
export function advanceTime(ms: number): void {
  vi.advanceTimersByTime(ms)
}

/**
 * Helper to advance fake timers by a number of days
 * @param days - Days to advance
 */
export function advanceTimeByDays(days: number): void {
  vi.advanceTimersByTime(days * ONE_DAY_MS)
}

/**
 * Creates a unique test directory path with deterministic naming
 * @param prefix - Prefix for the directory name
 * @param counter - A counter to ensure uniqueness within the test
 */
export function createTestDirPath(prefix: string, counter: number): string {
  return `${prefix}-${FIXED_TIMESTAMP}-${counter.toString(36)}`
}

/**
 * Decorator to set up and tear down fake timers for a describe block.
 * Usage:
 *   withFakeTimers(() => {
 *     beforeEach(() => { ... })
 *     it('test', () => { ... })
 *   })
 */
export function withFakeTimers(fn: () => void): void {
  beforeEach(() => {
    setupFakeTimers()
  })

  afterEach(() => {
    cleanupFakeTimers()
  })

  fn()
}
