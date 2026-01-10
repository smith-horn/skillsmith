/**
 * SMI-1308: File Streamer
 *
 * Memory-efficient file reading with streaming support for large files.
 * Provides generators for processing files without loading all into memory.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/file-streamer
 */

import fs from 'fs/promises'
import { createReadStream } from 'fs'

/**
 * File content with metadata
 */
export interface FileContent {
  /** File path */
  path: string
  /** File content (may be truncated for large files) */
  content: string
  /** File size in bytes */
  size: number
  /** Number of lines */
  lineCount: number
  /** Whether content was truncated */
  truncated?: boolean
}

/**
 * Options for file streaming
 */
export interface StreamOptions {
  /** Maximum buffer size in bytes (default: 1MB) */
  maxBufferSize?: number
  /** Skip files larger than buffer (default: true) */
  skipLargeFiles?: boolean
  /** Include binary files (default: false) */
  includeBinary?: boolean
}

/**
 * Options for batch file reading
 */
export interface BatchReadOptions {
  /** Maximum concurrent reads (default: 10) */
  concurrency?: number
  /** Maximum file size to read (default: 1MB) */
  maxFileSize?: number
  /** Skip unreadable files (default: true) */
  skipErrors?: boolean
}

/**
 * Stream files with memory-efficient chunking
 *
 * Uses async generators to process files one at a time,
 * avoiding loading all file contents into memory.
 *
 * @param filePaths - Array of file paths to stream
 * @param options - Streaming options
 * @yields FileContent objects
 *
 * @example
 * ```typescript
 * for await (const file of streamFiles(paths, { maxBufferSize: 512 * 1024 })) {
 *   console.log(`${file.path}: ${file.lineCount} lines`)
 *   // Process file.content...
 * }
 * ```
 */
export async function* streamFiles(
  filePaths: string[],
  options: StreamOptions = {}
): AsyncGenerator<FileContent> {
  const { maxBufferSize = 1024 * 1024, skipLargeFiles = true, includeBinary = false } = options

  for (const filePath of filePaths) {
    try {
      const stat = await fs.stat(filePath)

      // Skip directories
      if (stat.isDirectory()) {
        continue
      }

      // Handle large files
      if (stat.size > maxBufferSize) {
        if (skipLargeFiles) {
          // Skip files larger than buffer (likely generated/minified)
          continue
        }
        // Stream large files (read only first chunk)
        yield* streamLargeFile(filePath, maxBufferSize)
        continue
      }

      // Read small files directly
      const content = await fs.readFile(filePath, 'utf-8')

      // Skip binary files unless requested
      if (!includeBinary && isBinaryContent(content)) {
        continue
      }

      yield {
        path: filePath,
        content,
        size: stat.size,
        lineCount: countLines(content),
      }
    } catch {
      // Skip files that can't be read (permissions, symlinks, etc.)
      continue
    }
  }
}

/**
 * Stream a large file in chunks
 *
 * Reads only the first chunk of the file for analysis.
 * Large files are often generated or minified, so we only
 * need the beginning for pattern detection.
 *
 * @param filePath - Path to the large file
 * @param maxBufferSize - Maximum bytes to read
 * @yields Single FileContent with truncated content
 */
async function* streamLargeFile(
  filePath: string,
  maxBufferSize: number
): AsyncGenerator<FileContent> {
  const content = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalSize = 0

    const stream = createReadStream(filePath, {
      highWaterMark: Math.min(maxBufferSize, 64 * 1024), // 64KB chunks
    })

    stream.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (totalSize < maxBufferSize) {
        chunks.push(buffer)
        totalSize += buffer.length
      }
      if (totalSize >= maxBufferSize) {
        stream.destroy()
      }
    })

    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })

    stream.on('error', reject)

    stream.on('close', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
  })

  const stat = await fs.stat(filePath)
  const actualSize = Math.min(stat.size, maxBufferSize)

  yield {
    path: filePath,
    content,
    size: actualSize,
    lineCount: countLines(content),
    truncated: stat.size > maxBufferSize,
  }
}

/**
 * Batch file reading with concurrency control
 *
 * Reads multiple files concurrently with a configurable limit
 * to balance speed and memory usage.
 *
 * @param filePaths - Array of file paths to read
 * @param options - Batch reading options
 * @returns Array of file contents
 *
 * @example
 * ```typescript
 * const files = await batchReadFiles(paths, {
 *   concurrency: 20,
 *   maxFileSize: 512 * 1024
 * })
 *
 * console.log(`Read ${files.length} files`)
 * ```
 */
export async function batchReadFiles(
  filePaths: string[],
  options: BatchReadOptions = {}
): Promise<FileContent[]> {
  const { concurrency = 10, maxFileSize = 1024 * 1024, skipErrors = true } = options

  const results: FileContent[] = []

  // Process in batches
  for (let i = 0; i < filePaths.length; i += concurrency) {
    const batch = filePaths.slice(i, i + concurrency)
    const batchResults = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const stat = await fs.stat(filePath)

          // Skip directories and large files
          if (stat.isDirectory() || stat.size > maxFileSize) {
            return null
          }

          const content = await fs.readFile(filePath, 'utf-8')

          // Skip binary content
          if (isBinaryContent(content)) {
            return null
          }

          return {
            path: filePath,
            content,
            size: stat.size,
            lineCount: countLines(content),
          }
        } catch (error) {
          if (skipErrors) {
            return null
          }
          throw error
        }
      })
    )

    for (const result of batchResults) {
      if (result) {
        results.push(result)
      }
    }
  }

  return results
}

/**
 * Read files as a map for quick lookup
 *
 * @param filePaths - Array of file paths to read
 * @param options - Batch reading options
 * @returns Map of path to file content
 *
 * @example
 * ```typescript
 * const fileMap = await readFilesAsMap(paths)
 * const content = fileMap.get('src/index.ts')
 * ```
 */
export async function readFilesAsMap(
  filePaths: string[],
  options: BatchReadOptions = {}
): Promise<Map<string, FileContent>> {
  const files = await batchReadFiles(filePaths, options)
  const map = new Map<string, FileContent>()

  for (const file of files) {
    map.set(file.path, file)
  }

  return map
}

/**
 * Count lines in content
 *
 * @param content - File content
 * @returns Number of lines
 */
function countLines(content: string): number {
  if (!content) return 0

  let count = 1
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      count++
    }
  }
  return count
}

/**
 * Check if content appears to be binary
 *
 * Detects binary content by looking for null bytes
 * in the first 8KB of the file.
 *
 * @param content - Content to check
 * @returns True if content appears binary
 */
function isBinaryContent(content: string): boolean {
  // Check first 8KB for null bytes
  const checkLength = Math.min(content.length, 8192)
  for (let i = 0; i < checkLength; i++) {
    if (content.charCodeAt(i) === 0) {
      return true
    }
  }
  return false
}

/**
 * Get file extension
 *
 * @param filePath - File path
 * @returns Extension including dot, or empty string
 */
export function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.')
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))

  if (lastDot > lastSep && lastDot > 0) {
    return filePath.slice(lastDot).toLowerCase()
  }

  return ''
}

/**
 * Filter paths by extension
 *
 * @param filePaths - Array of file paths
 * @param extensions - Extensions to include (with dot)
 * @returns Filtered paths
 *
 * @example
 * ```typescript
 * const tsPaths = filterByExtension(allPaths, ['.ts', '.tsx'])
 * ```
 */
export function filterByExtension(filePaths: string[], extensions: string[]): string[] {
  const extSet = new Set(extensions.map((e) => e.toLowerCase()))
  return filePaths.filter((p) => extSet.has(getFileExtension(p)))
}

/**
 * Estimate memory usage for files
 *
 * Provides rough estimate based on file sizes.
 *
 * @param filePaths - Array of file paths
 * @returns Estimated memory usage in bytes
 *
 * @example
 * ```typescript
 * const estimate = await estimateMemoryUsage(paths)
 * console.log(`Estimated: ${MemoryMonitor.formatBytes(estimate)}`)
 * ```
 */
export async function estimateMemoryUsage(filePaths: string[]): Promise<number> {
  let total = 0

  for (const filePath of filePaths) {
    try {
      const stat = await fs.stat(filePath)
      if (stat.isFile()) {
        // Rough estimate: content + metadata overhead
        total += stat.size + 200
      }
    } catch {
      // Skip files that can't be stat'd
    }
  }

  return total
}
