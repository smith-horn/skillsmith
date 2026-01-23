/**
 * Language Detection Patterns and Keywords
 * @module analysis/language-detector.patterns
 */

import type { SupportedLanguage } from './types.js'
import type { ContentPattern, ShebangPattern } from './language-detector.types.js'

// ============================================================================
// Shebang Patterns
// ============================================================================

/**
 * Shebang patterns for language detection
 * Note: Order matters - more specific patterns should come first
 */
export const SHEBANG_PATTERNS: ShebangPattern[] = [
  // TypeScript runners (more specific, must come before node)
  { pattern: /^#!.*ts-node/i, language: 'typescript' },
  { pattern: /^#!.*npx\s+tsx/i, language: 'typescript' },
  { pattern: /^#!.*deno/i, language: 'typescript' },
  { pattern: /^#!.*bun/i, language: 'typescript' },

  // JavaScript/Node (general)
  { pattern: /^#!.*node\b/i, language: 'javascript' },
  { pattern: /^#!.*\/env\s+node\b/i, language: 'javascript' },

  // Python
  { pattern: /^#!.*python3?\b/i, language: 'python' },
  { pattern: /^#!.*\/env\s+python\b/i, language: 'python' },
]

// ============================================================================
// Content Patterns
// ============================================================================

export const CONTENT_PATTERNS: ContentPattern[] = [
  // TypeScript specific
  {
    pattern: /^import\s+type\s+\{/m,
    language: 'typescript',
    weight: 0.9,
    description: 'type-only import',
  },
  {
    pattern: /:\s*(string|number|boolean|any|void|never)\b/m,
    language: 'typescript',
    weight: 0.7,
    description: 'type annotation',
  },
  {
    pattern: /interface\s+\w+\s*\{/m,
    language: 'typescript',
    weight: 0.7,
    description: 'interface declaration',
  },
  {
    pattern: /type\s+\w+\s*=\s*\{/m,
    language: 'typescript',
    weight: 0.7,
    description: 'type alias',
  },
  {
    pattern: /<\w+(?:,\s*\w+)*>\s*\(/m,
    language: 'typescript',
    weight: 0.6,
    description: 'generic function call',
  },
  {
    pattern: /as\s+\w+\s*[;,)\]}]/m,
    language: 'typescript',
    weight: 0.5,
    description: 'type assertion',
  },

  // JavaScript/TypeScript common
  {
    pattern: /^import\s+.*\s+from\s+['"`]/m,
    language: 'javascript',
    weight: 0.6,
    description: 'ES module import',
  },
  {
    pattern: /^export\s+(default\s+)?(function|class|const|let|var)/m,
    language: 'javascript',
    weight: 0.6,
    description: 'ES module export',
  },
  {
    pattern: /const\s+\w+\s*=\s*(async\s+)?\(/m,
    language: 'javascript',
    weight: 0.5,
    description: 'arrow function',
  },
  {
    pattern: /require\s*\(\s*['"`]/m,
    language: 'javascript',
    weight: 0.5,
    description: 'CommonJS require',
  },
  {
    pattern: /module\.exports\s*=/m,
    language: 'javascript',
    weight: 0.5,
    description: 'CommonJS export',
  },
  { pattern: /=>\s*\{/m, language: 'javascript', weight: 0.4, description: 'arrow function body' },
  {
    pattern: /async\s+function/m,
    language: 'javascript',
    weight: 0.4,
    description: 'async function',
  },
  { pattern: /\bawait\s+/m, language: 'javascript', weight: 0.4, description: 'await expression' },

  // Python
  {
    pattern: /^from\s+\w+\s+import\s+/m,
    language: 'python',
    weight: 0.8,
    description: 'from import',
  },
  {
    pattern: /^import\s+\w+(\s*,\s*\w+)*\s*$/m,
    language: 'python',
    weight: 0.7,
    description: 'simple import',
  },
  {
    pattern: /def\s+\w+\s*\([^)]*\)\s*(->\s*\w+)?\s*:/m,
    language: 'python',
    weight: 0.8,
    description: 'function definition',
  },
  {
    pattern: /class\s+\w+(\s*\([^)]*\))?\s*:/m,
    language: 'python',
    weight: 0.8,
    description: 'class definition',
  },
  {
    pattern: /if\s+__name__\s*==\s*['"`]__main__['"`]/m,
    language: 'python',
    weight: 0.9,
    description: 'main guard',
  },
  {
    pattern: /@\w+(\.\w+)*(\s*\([^)]*\))?\s*$/m,
    language: 'python',
    weight: 0.5,
    description: 'decorator',
  },
  { pattern: /:\s*$/m, language: 'python', weight: 0.3, description: 'colon line ending' },
  { pattern: /^\s*elif\s+/m, language: 'python', weight: 0.7, description: 'elif keyword' },
  { pattern: /\bself\.\w+/m, language: 'python', weight: 0.6, description: 'self reference' },

  // Go
  {
    pattern: /^package\s+\w+\s*$/m,
    language: 'go',
    weight: 0.9,
    description: 'package declaration',
  },
  { pattern: /^import\s*\(\s*$/m, language: 'go', weight: 0.8, description: 'import block' },
  {
    pattern: /func\s+\w+\s*\([^)]*\)\s*\{/m,
    language: 'go',
    weight: 0.8,
    description: 'function declaration',
  },
  {
    pattern: /func\s+\(\w+\s+\*?\w+\)\s+\w+\s*\(/m,
    language: 'go',
    weight: 0.9,
    description: 'method with receiver',
  },
  { pattern: /:=\s*/m, language: 'go', weight: 0.7, description: 'short variable declaration' },
  { pattern: /\bdefer\s+/m, language: 'go', weight: 0.8, description: 'defer statement' },
  { pattern: /\bgo\s+\w+\s*\(/m, language: 'go', weight: 0.8, description: 'goroutine' },
  { pattern: /\bchan\s+\w+/m, language: 'go', weight: 0.8, description: 'channel type' },
  {
    pattern: /type\s+\w+\s+struct\s*\{/m,
    language: 'go',
    weight: 0.9,
    description: 'struct definition',
  },
  {
    pattern: /type\s+\w+\s+interface\s*\{/m,
    language: 'go',
    weight: 0.9,
    description: 'interface definition',
  },

  // Rust
  { pattern: /^use\s+\w+(::\w+)*/m, language: 'rust', weight: 0.8, description: 'use statement' },
  {
    pattern: /fn\s+\w+\s*(<[^>]+>)?\s*\([^)]*\)\s*(->|{)/m,
    language: 'rust',
    weight: 0.8,
    description: 'function definition',
  },
  {
    pattern: /pub\s+(fn|struct|enum|trait|mod)\s+/m,
    language: 'rust',
    weight: 0.9,
    description: 'public declaration',
  },
  { pattern: /impl(\s+<[^>]+>)?\s+\w+/m, language: 'rust', weight: 0.9, description: 'impl block' },
  { pattern: /let\s+(mut\s+)?\w+\s*:/m, language: 'rust', weight: 0.7, description: 'let binding' },
  {
    pattern: /\bmatch\s+\w+\s*\{/m,
    language: 'rust',
    weight: 0.8,
    description: 'match expression',
  },
  { pattern: /\bOption<\w+>/m, language: 'rust', weight: 0.8, description: 'Option type' },
  { pattern: /\bResult<\w+,\s*\w+>/m, language: 'rust', weight: 0.8, description: 'Result type' },
  { pattern: /\bunwrap\(\)/m, language: 'rust', weight: 0.7, description: 'unwrap call' },
  { pattern: /\?\s*;/m, language: 'rust', weight: 0.7, description: 'try operator' },
  { pattern: /#\[derive\(/m, language: 'rust', weight: 0.9, description: 'derive macro' },
  { pattern: /#\[\w+(\([^)]*\))?\]/m, language: 'rust', weight: 0.7, description: 'attribute' },

  // Java
  {
    pattern: /^package\s+[\w.]+\s*;/m,
    language: 'java',
    weight: 0.9,
    description: 'package declaration',
  },
  {
    pattern: /^import\s+[\w.]+\s*;/m,
    language: 'java',
    weight: 0.8,
    description: 'import statement',
  },
  { pattern: /public\s+class\s+\w+/m, language: 'java', weight: 0.9, description: 'public class' },
  {
    pattern: /private\s+(static\s+)?\w+\s+\w+\s*[;=]/m,
    language: 'java',
    weight: 0.7,
    description: 'private field',
  },
  {
    pattern: /public\s+(static\s+)?\w+\s+\w+\s*\(/m,
    language: 'java',
    weight: 0.8,
    description: 'public method',
  },
  { pattern: /@Override/m, language: 'java', weight: 0.9, description: 'Override annotation' },
  { pattern: /System\.out\.print/m, language: 'java', weight: 0.8, description: 'System.out' },
  { pattern: /new\s+\w+\s*\(/m, language: 'java', weight: 0.4, description: 'new expression' },
  { pattern: /extends\s+\w+/m, language: 'java', weight: 0.5, description: 'extends clause' },
  { pattern: /implements\s+\w+/m, language: 'java', weight: 0.6, description: 'implements clause' },
]

// ============================================================================
// Language Keywords
// ============================================================================

/**
 * Keyword frequency analysis for statistical detection
 */
export const LANGUAGE_KEYWORDS: Record<SupportedLanguage, string[]> = {
  typescript: [
    'interface',
    'type',
    'enum',
    'namespace',
    'declare',
    'readonly',
    'private',
    'protected',
    'public',
    'abstract',
    'implements',
    'extends',
    'as',
    'is',
    'keyof',
    'typeof',
    'infer',
    'never',
    'unknown',
    'any',
  ],
  javascript: [
    'const',
    'let',
    'var',
    'function',
    'class',
    'async',
    'await',
    'import',
    'export',
    'default',
    'from',
    'require',
    'module',
    'undefined',
    'null',
    'this',
    'new',
    'typeof',
    'instanceof',
  ],
  python: [
    'def',
    'class',
    'import',
    'from',
    'as',
    'if',
    'elif',
    'else',
    'for',
    'while',
    'try',
    'except',
    'finally',
    'with',
    'lambda',
    'return',
    'yield',
    'raise',
    'pass',
    'break',
    'continue',
    'True',
    'False',
    'None',
    'self',
    'cls',
    'async',
    'await',
  ],
  go: [
    'package',
    'import',
    'func',
    'var',
    'const',
    'type',
    'struct',
    'interface',
    'map',
    'chan',
    'go',
    'select',
    'defer',
    'range',
    'make',
    'new',
    'append',
    'len',
    'cap',
    'nil',
    'true',
    'false',
  ],
  rust: [
    'fn',
    'let',
    'mut',
    'const',
    'static',
    'struct',
    'enum',
    'trait',
    'impl',
    'use',
    'mod',
    'pub',
    'crate',
    'self',
    'super',
    'where',
    'match',
    'if',
    'else',
    'loop',
    'while',
    'for',
    'in',
    'return',
    'break',
    'continue',
    'move',
    'ref',
    'unsafe',
    'async',
    'await',
  ],
  java: [
    'public',
    'private',
    'protected',
    'class',
    'interface',
    'enum',
    'extends',
    'implements',
    'static',
    'final',
    'abstract',
    'void',
    'new',
    'this',
    'super',
    'return',
    'if',
    'else',
    'for',
    'while',
    'try',
    'catch',
    'finally',
    'throw',
    'throws',
    'synchronized',
    'package',
    'import',
    'null',
    'true',
    'false',
    'instanceof',
  ],
}
