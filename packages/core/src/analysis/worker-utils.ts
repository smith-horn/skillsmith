/**
 * SMI-1308: Worker Pool Utilities
 *
 * Utility functions for the worker thread pool.
 * Extracted from worker-pool.ts for better modularity.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/worker-utils
 */

/**
 * Map of file extensions to language names
 * Used for metrics recording
 */
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
}

/**
 * Get language from file extension
 *
 * @param ext - File extension (without leading dot)
 * @returns Language name or undefined if not supported
 *
 * @example
 * ```typescript
 * getLanguageFromExtension('ts') // 'typescript'
 * getLanguageFromExtension('py') // 'python'
 * getLanguageFromExtension('unknown') // undefined
 * ```
 */
export function getLanguageFromExtension(ext?: string): string | undefined {
  if (!ext) return undefined
  return EXTENSION_TO_LANGUAGE[ext]
}

/**
 * Chunk an array into smaller arrays of specified size
 *
 * @param array - Array to chunk
 * @param size - Maximum size of each chunk
 * @returns Array of chunks
 *
 * @example
 * ```typescript
 * chunkArray([1, 2, 3, 4, 5], 2) // [[1, 2], [3, 4], [5]]
 * ```
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

/**
 * Worker code template for inline parsing
 *
 * This code runs inside worker threads to perform basic regex-based parsing.
 * Full adapter-based parsing happens in main thread for accuracy.
 */
export const WORKER_PARSE_CODE = `
const { parentPort, workerData } = require('worker_threads');

function processTask(task) {
  const start = Date.now();
  try {
    const result = {
      imports: [],
      exports: [],
      functions: [],
    };

    const lines = task.content.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect imports (TypeScript/JavaScript)
      if (/^import\\s/.test(line) || /^from\\s/.test(line)) {
        const moduleMatch = line.match(/from\\s+['"]([^'"]+)['"]/);
        result.imports.push({
          module: moduleMatch ? moduleMatch[1] : line.trim(),
          namedImports: [],
          isTypeOnly: /^import\\s+type/.test(line),
          sourceFile: task.filePath,
          line: i + 1,
        });
      }

      // Detect imports (Python)
      if (/^import\\s+\\w/.test(line) || /^from\\s+\\w/.test(line)) {
        const moduleMatch = line.match(/^(?:from\\s+)?(\\w+(?:\\.\\w+)*)/);
        if (moduleMatch && !result.imports.some(imp => imp.line === i + 1)) {
          result.imports.push({
            module: moduleMatch[1],
            namedImports: [],
            isTypeOnly: false,
            sourceFile: task.filePath,
            line: i + 1,
          });
        }
      }

      // Detect imports (Go)
      if (/^\\s*"[^"]+"/.test(line) || /^import\\s+/.test(line)) {
        const pathMatch = line.match(/"([^"]+)"/);
        if (pathMatch) {
          result.imports.push({
            module: pathMatch[1],
            namedImports: [],
            isTypeOnly: false,
            sourceFile: task.filePath,
            line: i + 1,
          });
        }
      }

      // Detect functions (TypeScript/JavaScript)
      const tsFuncMatch = line.match(/^(export\\s+)?(async\\s+)?function\\s+(\\w+)/);
      if (tsFuncMatch) {
        result.functions.push({
          name: tsFuncMatch[3],
          parameterCount: 0,
          isAsync: !!tsFuncMatch[2],
          isExported: !!tsFuncMatch[1],
          sourceFile: task.filePath,
          line: i + 1,
        });
      }

      // Detect functions (Python)
      const pyFuncMatch = line.match(/^(async\\s+)?def\\s+(\\w+)/);
      if (pyFuncMatch) {
        result.functions.push({
          name: pyFuncMatch[2],
          parameterCount: 0,
          isAsync: !!pyFuncMatch[1],
          isExported: !pyFuncMatch[2].startsWith('_'),
          sourceFile: task.filePath,
          line: i + 1,
        });
      }

      // Detect functions (Go)
      const goFuncMatch = line.match(/^func\\s+(?:\\([^)]+\\)\\s+)?(\\w+)/);
      if (goFuncMatch) {
        const isExported = goFuncMatch[1][0] === goFuncMatch[1][0].toUpperCase();
        result.functions.push({
          name: goFuncMatch[1],
          parameterCount: 0,
          isAsync: false,
          isExported: isExported,
          sourceFile: task.filePath,
          line: i + 1,
        });
      }

      // Detect exports (TypeScript/JavaScript)
      if (/^export\\s+(default\\s+)?(const|let|var|class|function|interface|type|enum)/.test(line)) {
        const exportMatch = line.match(/^export\\s+(default\\s+)?(const|let|var|class|function|interface|type|enum)\\s+(\\w+)/);
        if (exportMatch) {
          result.exports.push({
            name: exportMatch[3],
            kind: exportMatch[2] === 'function' ? 'function' :
                  exportMatch[2] === 'class' ? 'class' :
                  exportMatch[2] === 'interface' ? 'interface' :
                  exportMatch[2] === 'type' ? 'type' :
                  exportMatch[2] === 'enum' ? 'enum' : 'variable',
            isDefault: !!exportMatch[1],
            sourceFile: task.filePath,
            line: i + 1,
          });
        }
      }
    }

    return {
      filePath: task.filePath,
      result,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      filePath: task.filePath,
      result: { imports: [], exports: [], functions: [] },
      durationMs: Date.now() - start,
      error: error.message || String(error),
    };
  }
}

const results = workerData.tasks.map(processTask);
parentPort.postMessage(results);
`
