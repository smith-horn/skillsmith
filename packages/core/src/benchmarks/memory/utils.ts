/**
 * SMI-689: Memory Profiler Utilities
 *
 * Utility functions for memory profiling.
 */

/**
 * Format bytes to human-readable string
 *
 * @param bytes - Number of bytes to format
 * @returns Human-readable string (e.g., "1.5 MB")
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k))
  const value = bytes / Math.pow(k, i)
  return `${value.toFixed(1)} ${sizes[i]}`
}

/**
 * Force garbage collection if available
 */
export function forceGC(): void {
  if (typeof global.gc === 'function') {
    global.gc()
  }
}
