/**
 * Blog Utilities
 * SMI-1729, SMI-1730: Shared blog utilities for reading time and date formatting
 */

/**
 * Calculates the estimated reading time for a given content string.
 * Uses a standard reading speed of 200 words per minute.
 *
 * @param content - The content string to calculate reading time for
 * @returns The estimated reading time in minutes, rounded up
 * @example
 * const readingTime = calculateReadingTime(post.body ?? '');
 * // Returns: 5 (for ~1000 words)
 */
export function calculateReadingTime(content: string): number {
  const wordsPerMinute = 200;
  const words = content.split(/\s+/).length;
  return Math.ceil(words / wordsPerMinute);
}

/**
 * Formats a Date object into a human-readable string using Intl.DateTimeFormat.
 *
 * @param date - The Date object to format
 * @param format - The format style: 'short' (Jan 15, 2025) or 'long' (January 15, 2025). Defaults to 'long'.
 * @returns A formatted date string in en-US locale
 * @example
 * formatDate(new Date('2025-01-15'), 'long');
 * // Returns: "January 15, 2025"
 *
 * formatDate(new Date('2025-01-15'), 'short');
 * // Returns: "Jan 15, 2025"
 */
export function formatDate(date: Date, format: 'short' | 'long' = 'long'): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: format,
    day: 'numeric',
  }).format(date);
}
