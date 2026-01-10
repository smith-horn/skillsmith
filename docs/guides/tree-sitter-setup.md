# Tree-sitter WASM Setup Guide

**Status**: Current
**Date**: 2026-01-09
**Linear Issue**: [SMI-1338: Document Tree-sitter WASM setup](https://linear.app/smith-horn-group/issue/SMI-1338)
**Related**: [Multi-Language Analysis Architecture](../architecture/multi-language-analysis.md)

## Overview

Skillsmith uses [web-tree-sitter](https://github.com/nicfisch/web-tree-sitter) (WASM-based) for multi-language code analysis. This guide covers setup, configuration, and troubleshooting for tree-sitter in the Skillsmith project.

---

## WASM vs Native Tree-sitter

| Aspect | web-tree-sitter (WASM) | tree-sitter (Native) |
|--------|------------------------|----------------------|
| **Module Type** | WebAssembly | Native C bindings |
| **Portability** | Cross-platform, no recompilation | Requires native build per platform |
| **glibc Dependency** | None | Requires glibc (see ADR-002) |
| **Performance** | ~10-15% slower than native | Fastest option |
| **Memory** | Sandboxed WASM memory | Direct memory access |
| **Installation** | `npm install web-tree-sitter` | `npm install tree-sitter` + native build |
| **Docker Required** | No (but recommended) | Yes (for consistency) |
| **Browser Compatible** | Yes | No |

### Why Skillsmith Uses WASM

1. **Avoids glibc dependency** - Per ADR-002, native modules require Docker
2. **Consistent behavior** - Same code works in Docker and locally
3. **Simpler deployment** - No native compilation step in CI/CD
4. **Future browser support** - Enables potential web-based skill analysis

---

## Required Packages

### Core Dependencies

```bash
# Primary package (WASM-based, no native build)
npm install web-tree-sitter

# Language grammars (installed as optional dependencies)
npm install tree-sitter-typescript  # TypeScript/JavaScript
npm install tree-sitter-python      # Python
npm install tree-sitter-go          # Go
npm install tree-sitter-rust        # Rust
npm install tree-sitter-java        # Java
```

### Package Versions

Current versions in `packages/core/package.json`:

```json
{
  "optionalDependencies": {
    "web-tree-sitter": "^0.22.0",
    "tree-sitter-typescript": "^0.21.0",
    "tree-sitter-python": "^0.21.0",
    "tree-sitter-go": "^0.21.0",
    "tree-sitter-rust": "^0.21.0",
    "tree-sitter-java": "^0.21.0"
  }
}
```

### Optional: Native Fallback

For environments where WASM is unavailable:

```bash
# Native tree-sitter (requires Docker or compatible glibc)
npm install tree-sitter
```

---

## Browser vs Node.js Considerations

### Node.js (Skillsmith Default)

```typescript
// packages/core/src/analysis/tree-sitter/manager.ts

import type { SupportedLanguage } from '../types.js'

export class TreeSitterManager {
  private initialized = false
  private ParserClass: (new () => TreeSitterParser) | null = null

  async initialize(): Promise<void> {
    if (this.initialized) return

    try {
      // WASM-based (preferred)
      const TreeSitter = await import('web-tree-sitter')
      await TreeSitter.default.init()
      this.ParserClass = TreeSitter.default as unknown as new () => TreeSitterParser
      this.initialized = true
    } catch {
      // Fallback to native (requires Docker)
      const TreeSitterNative = await import('tree-sitter')
      this.ParserClass = TreeSitterNative.default as unknown as new () => TreeSitterParser
      this.initialized = true
    }
  }
}
```

### Browser Environment

For browser-based analysis (future feature):

```typescript
// Browser-specific initialization
import Parser from 'web-tree-sitter'

async function initBrowser(): Promise<Parser> {
  // Load WASM from CDN or bundled path
  await Parser.init({
    locateFile(scriptName: string, scriptDirectory: string) {
      // Custom WASM file location
      return `/wasm/${scriptName}`
    }
  })

  const parser = new Parser()

  // Load language WASM file
  const TypeScript = await Parser.Language.load('/wasm/tree-sitter-typescript.wasm')
  parser.setLanguage(TypeScript)

  return parser
}
```

### Key Differences

| Feature | Node.js | Browser |
|---------|---------|---------|
| Module Loading | `import()` dynamic import | Fetch WASM files |
| Language Loading | `require()` grammar modules | `Parser.Language.load()` |
| File System | Direct access | Via FileReader API |
| Memory Limit | Node heap size | Browser WASM limits (~2GB) |

---

## Language Grammar Installation

### 1. Installing a New Language

```bash
# Install the grammar package
npm install tree-sitter-<language>

# Example: Add Ruby support
npm install tree-sitter-ruby
```

### 2. Registering in TreeSitterManager

```typescript
// packages/core/src/analysis/tree-sitter/manager.ts

private async loadLanguageModule(language: SupportedLanguage): Promise<TreeSitterLanguage> {
  switch (language) {
    case 'typescript':
    case 'javascript': {
      const mod = await import('tree-sitter-typescript')
      return mod.typescript  // or mod.tsx for TSX
    }
    case 'python': {
      const mod = await import('tree-sitter-python')
      return mod.default
    }
    case 'go': {
      const mod = await import('tree-sitter-go')
      return mod.default
    }
    case 'rust': {
      const mod = await import('tree-sitter-rust')
      return mod.default
    }
    case 'java': {
      const mod = await import('tree-sitter-java')
      return mod.default
    }
    // Add new language here
    case 'ruby': {
      const mod = await import('tree-sitter-ruby')
      return mod.default
    }
    default:
      throw new Error(`Unsupported language: ${language}`)
  }
}
```

### 3. Creating a Language Adapter

```typescript
// packages/core/src/analysis/adapters/ruby.ts

import { LanguageAdapter, type SupportedLanguage, type ParseResult, type FrameworkRule } from './base.js'

export class RubyAdapter extends LanguageAdapter {
  readonly language: SupportedLanguage = 'ruby' as SupportedLanguage
  readonly extensions = ['.rb', '.rake', '.gemspec']

  parseFile(content: string, filePath: string): ParseResult {
    // Implement Ruby-specific parsing
    return { imports: [], exports: [], functions: [] }
  }

  parseIncremental(content: string, filePath: string, previousTree?: unknown): ParseResult {
    // Use tree-sitter for incremental parsing
    return this.parseFile(content, filePath)
  }

  getFrameworkRules(): FrameworkRule[] {
    return [
      { name: 'Rails', depIndicators: ['rails'], importIndicators: ['rails', 'active_record'] },
      { name: 'Sinatra', depIndicators: ['sinatra'], importIndicators: ['sinatra'] },
      { name: 'RSpec', depIndicators: ['rspec'], importIndicators: ['rspec'] },
    ]
  }

  dispose(): void {
    // Cleanup if needed
  }
}
```

### 4. Adding Tree-sitter Query File

```scheme
; packages/core/src/analysis/tree-sitter/queries/ruby.scm

; Import statements (require, require_relative)
(call
  method: (identifier) @method
  arguments: (argument_list
    (string) @import.path)
  (#match? @method "^require(_relative)?$"))

; Method definitions
(method
  name: (identifier) @function.name
  parameters: (method_parameters)? @function.params) @function.def

; Class definitions
(class
  name: (constant) @class.name
  superclass: (superclass)? @class.parent) @class.def

; Module definitions
(module
  name: (constant) @module.name) @module.def
```

---

## Configuring WASM Path

### Default Configuration

web-tree-sitter automatically locates WASM files from node_modules.

### Custom WASM Path

```typescript
import Parser from 'web-tree-sitter'

// For custom WASM file locations
await Parser.init({
  locateFile(path: string) {
    // Return custom path to WASM files
    return `/custom/path/to/${path}`
  }
})
```

### Environment Variable

```bash
# Set custom WASM directory (not currently used, for future reference)
TREE_SITTER_WASM_PATH=/path/to/wasm/files
```

---

## Using Incremental Parsing

Incremental parsing reuses the previous AST, only reparsing changed regions. This is significantly faster for single-file edits.

### Basic Usage

```typescript
import { TreeSitterManager } from '@skillsmith/core'
import type { TreeSitterTree } from '@skillsmith/core'

const manager = new TreeSitterManager()
let previousTree: TreeSitterTree | undefined

async function parseFile(content: string): Promise<void> {
  const parser = await manager.getParser('typescript')

  // First parse (full)
  const tree = parser.parse(content, previousTree)

  // Process tree...
  console.log(tree.rootNode.type) // 'program'

  // Store for next incremental parse
  previousTree = tree
}

// File edited - incremental parse
async function onFileChange(newContent: string): Promise<void> {
  const parser = await manager.getParser('typescript')

  // Incremental parse - much faster
  const tree = parser.parse(newContent, previousTree)
  previousTree = tree
}
```

### With Edit Information

For maximum efficiency, provide edit information:

```typescript
import { findMinimalEdit, calculateEdit } from '@skillsmith/core'

function onTextChange(oldContent: string, newContent: string): void {
  // Find what changed
  const diff = findMinimalEdit(oldContent, newContent)
  if (!diff) return // No change

  // Calculate tree-sitter edit format
  const edit = calculateEdit(
    oldContent,
    newContent,
    diff.changeStart,
    diff.changeEnd,
    diff.newText
  )

  // Apply edit to existing tree (modifies in place)
  previousTree.edit({
    startIndex: edit.startIndex,
    oldEndIndex: edit.oldEndIndex,
    newEndIndex: edit.newEndIndex,
    startPosition: edit.startPosition,
    oldEndPosition: edit.oldEndPosition,
    newEndPosition: edit.newEndPosition,
  })

  // Parse with edited tree
  const parser = await manager.getParser('typescript')
  previousTree = parser.parse(newContent, previousTree)
}
```

### Using IncrementalParser Class

```typescript
import { IncrementalParser, TypeScriptAdapter } from '@skillsmith/core'

const parser = new IncrementalParser({ maxTrees: 50 })
const adapter = new TypeScriptAdapter()

// First parse
const result1 = parser.parse('src/main.ts', initialContent, adapter)
console.log(result1.wasIncremental) // false

// After file change
const result2 = parser.parse('src/main.ts', modifiedContent, adapter)
console.log(result2.wasIncremental) // true
console.log(result2.durationMs)     // < 100ms for small changes

// Cleanup
parser.dispose()
```

---

## Troubleshooting

### Common Issues

#### 1. "tree-sitter is not available"

**Symptom**: Error on first parse attempt

**Cause**: Neither web-tree-sitter nor tree-sitter is installed

**Solution**:
```bash
npm install web-tree-sitter
# or in Docker:
docker exec skillsmith-dev-1 npm install web-tree-sitter
```

#### 2. "Failed to load tree-sitter language module"

**Symptom**: Error for specific language

**Cause**: Language grammar not installed

**Solution**:
```bash
npm install tree-sitter-<language>
# Example:
npm install tree-sitter-python
```

#### 3. WASM Memory Error

**Symptom**: Out of memory when parsing large files

**Cause**: WASM has limited memory (~4GB max)

**Solution**:
```typescript
// Increase Node.js memory if needed
// node --max-old-space-size=4096 script.js

// Or split large files for parsing
const MAX_FILE_SIZE = 1024 * 1024 // 1MB
if (content.length > MAX_FILE_SIZE) {
  console.warn('File too large for safe WASM parsing')
}
```

#### 4. Native Module Version Mismatch

**Symptom**: `NODE_MODULE_VERSION` error

**Cause**: Native tree-sitter built for different Node.js version

**Solution**:
```bash
# Rebuild native modules
docker exec skillsmith-dev-1 npm rebuild

# Or specifically:
docker exec skillsmith-dev-1 npm rebuild tree-sitter
```

See [ADR-012: Native Module Version Management](../adr/012-native-module-version-management.md).

#### 5. Parser Returns Empty Results

**Symptom**: `ParseResult` has empty arrays

**Cause**: Query file missing or invalid

**Solution**:
1. Check query file exists in `tree-sitter/queries/<language>.scm`
2. Validate query syntax with tree-sitter CLI
3. Test query against sample code

### Debug Mode

Enable detailed logging:

```typescript
// Set environment variable
process.env.TREE_SITTER_DEBUG = 'true'

// Or in TreeSitterManager
const manager = new TreeSitterManager({ debug: true })
```

---

## Performance Tuning

### Parser Pool Size

Control memory usage by limiting cached parsers:

```typescript
const manager = new TreeSitterManager({
  maxParsers: 4  // Default is 6 (one per language)
})
```

### LRU Eviction

The TreeSitterManager uses LRU (Least Recently Used) eviction:

```typescript
// SMI-1333: LRU tracking in manager.ts
private accessOrder: SupportedLanguage[] = []

private updateAccessOrder(language: SupportedLanguage): void {
  const index = this.accessOrder.indexOf(language)
  if (index > -1) {
    this.accessOrder.splice(index, 1)
  }
  this.accessOrder.push(language)
}
```

### Tree Cache for Incremental Parsing

```typescript
import { TreeCache } from '@skillsmith/core'

const treeCache = new TreeCache({
  maxTrees: 100,  // Maximum trees to cache
  maxAgeMs: 300000  // 5 minutes TTL
})
```

### Memory Monitoring

```typescript
import { MemoryMonitor, ParseCache } from '@skillsmith/core'

const cache = new ParseCache({ maxMemoryMB: 200 })
const monitor = new MemoryMonitor({
  thresholdMB: 500,
  cache,
  verbose: true
})

// Start monitoring
const stop = monitor.startMonitoring(10000)

// Check memory manually
const result = monitor.checkAndCleanup()
if (result.cleaned) {
  console.log(`Freed ${result.freedBytes} bytes`)
}

// Stop when done
stop()
```

### Parallel Parsing

For large codebases, use worker threads:

```typescript
import { ParserWorkerPool } from '@skillsmith/core'

const pool = new ParserWorkerPool({
  poolSize: 4  // Match CPU cores - 1
})

const results = await pool.parseFiles(files)
pool.dispose()
```

---

## API Reference

### TreeSitterManager

```typescript
class TreeSitterManager {
  constructor(options?: { maxParsers?: number })

  // Initialize WASM runtime (called automatically)
  async initialize(): Promise<void>

  // Get parser for language (loads if needed)
  async getParser(language: SupportedLanguage): Promise<TreeSitterParser>

  // Check if language grammar is available
  async isLanguageAvailable(language: SupportedLanguage): Promise<boolean>

  // Get currently loaded languages
  getLoadedLanguages(): SupportedLanguage[]

  // Cleanup all resources
  dispose(): void
}
```

### TreeSitterParser

```typescript
interface TreeSitterParser {
  // Parse content (optionally with previous tree for incremental)
  parse(input: string, previousTree?: TreeSitterTree): TreeSitterTree

  // Set the language for this parser
  setLanguage(language: TreeSitterLanguage): void

  // Release parser resources
  delete(): void
}
```

### TreeSitterTree

```typescript
interface TreeSitterTree {
  // Root AST node
  rootNode: TreeSitterNode

  // Release tree resources
  delete(): void
}
```

### TreeSitterNode

```typescript
interface TreeSitterNode {
  type: string                  // Node type (e.g., 'function_declaration')
  text: string                  // Source text of this node
  startPosition: Point          // Start position { row, column }
  endPosition: Point            // End position { row, column }
  children: TreeSitterNode[]    // All child nodes
  namedChildren: TreeSitterNode[] // Named children only
  childCount: number
  namedChildCount: number

  child(index: number): TreeSitterNode | null
  namedChild(index: number): TreeSitterNode | null
  childForFieldName(fieldName: string): TreeSitterNode | null
  descendantsOfType(types: string | string[]): TreeSitterNode[]
}
```

---

## Related Documentation

- [Multi-Language Analysis Architecture](../architecture/multi-language-analysis.md)
- [ADR-002: Docker glibc Requirement](../adr/002-docker-glibc-requirement.md)
- [ADR-010: Codebase Analysis Scope](../adr/010-codebase-analysis-scope.md)
- [ADR-012: Native Module Version Management](../adr/012-native-module-version-management.md)
- [Migration Guide v2](migration-v2.md)
- [tree-sitter Official Documentation](https://tree-sitter.github.io/tree-sitter/)
- [web-tree-sitter GitHub](https://github.com/nicfisch/web-tree-sitter)
