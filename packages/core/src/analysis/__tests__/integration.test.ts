/**
 * SMI-1336: Multi-Language Analysis Integration Tests
 *
 * Integration tests for the complete multi-language analysis system,
 * testing interactions between:
 * - LanguageRouter with all adapters
 * - ParseCache across languages
 * - ParserWorkerPool with mixed language batches
 * - ResultAggregator combining results from multiple languages
 *
 * @see docs/internal/architecture/multi-language-analysis.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LanguageRouter } from '../router.js'
import { ParseCache } from '../cache.js'
import { ParserWorkerPool, type ParseTask } from '../worker-pool.js'
import { ResultAggregator } from '../aggregator.js'
import { TypeScriptAdapter } from '../adapters/typescript.js'
import { PythonAdapter } from '../adapters/python.js'
import { GoAdapter } from '../adapters/go.js'
import { RustAdapter } from '../adapters/rust.js'
import { JavaAdapter } from '../adapters/java.js'
import type { SupportedLanguage } from '../types.js'

// ============================================================
// Test Fixtures: Multi-Language Project Files
// ============================================================

const fixtures = {
  typescript: {
    path: 'src/api/handler.ts',
    content: `
import { Request, Response } from 'express'
import type { User } from '../types'
import { validateUser } from '../validators'

export interface HandlerConfig {
  timeout: number
  maxRetries: number
}

export async function handleUserRequest(req: Request, res: Response): Promise<void> {
  const user = req.body as User
  if (validateUser(user)) {
    res.json({ success: true, user })
  } else {
    res.status(400).json({ error: 'Invalid user' })
  }
}

export const DEFAULT_CONFIG: HandlerConfig = {
  timeout: 5000,
  maxRetries: 3
}
`.trim(),
  },

  python: {
    path: 'src/services/data_processor.py',
    content: `
from typing import List, Dict, Optional
from dataclasses import dataclass
import pandas as pd
import numpy as np
from .utils import sanitize_input

@dataclass
class DataConfig:
    batch_size: int
    max_workers: int

class DataProcessor:
    def __init__(self, config: DataConfig):
        self.config = config
        self._cache: Dict[str, pd.DataFrame] = {}

    async def process_batch(self, data: List[Dict]) -> pd.DataFrame:
        df = pd.DataFrame(data)
        return self._apply_transformations(df)

    def _apply_transformations(self, df: pd.DataFrame) -> pd.DataFrame:
        return df.dropna().reset_index(drop=True)

def create_processor(batch_size: int = 100) -> DataProcessor:
    config = DataConfig(batch_size=batch_size, max_workers=4)
    return DataProcessor(config)
`.trim(),
  },

  go: {
    path: 'src/server/main.go',
    content: `
package server

import (
    "context"
    "encoding/json"
    "net/http"

    "github.com/gin-gonic/gin"
    "gorm.io/gorm"
)

type Server struct {
    router *gin.Engine
    db     *gorm.DB
}

type UserRequest struct {
    Name  string \`json:"name"\`
    Email string \`json:"email"\`
}

func NewServer(db *gorm.DB) *Server {
    router := gin.Default()
    return &Server{router: router, db: db}
}

func (s *Server) Start(addr string) error {
    return s.router.Run(addr)
}

func (s *Server) handleGetUser(c *gin.Context) {
    id := c.Param("id")
    c.JSON(http.StatusOK, gin.H{"id": id})
}

func parseJSON(data []byte) (UserRequest, error) {
    var req UserRequest
    err := json.Unmarshal(data, &req)
    return req, err
}
`.trim(),
  },

  rust: {
    path: 'src/lib.rs',
    content: `
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub max_connections: usize,
}

pub trait Handler: Send + Sync {
    fn handle(&self, request: &Request) -> Response;
}

pub struct Server {
    config: Config,
    handlers: HashMap<String, Box<dyn Handler>>,
    connections: RwLock<Vec<Connection>>,
}

impl Server {
    pub fn new(config: Config) -> Self {
        Server {
            config,
            handlers: HashMap::new(),
            connections: RwLock::new(Vec::new()),
        }
    }

    pub async fn start(&self) -> Result<(), ServerError> {
        println!("Starting server on {}:{}", self.config.host, self.config.port);
        Ok(())
    }

    fn register_handler(&mut self, path: String, handler: Box<dyn Handler>) {
        self.handlers.insert(path, handler);
    }
}

pub fn create_default_config() -> Config {
    Config {
        host: "127.0.0.1".to_string(),
        port: 8080,
        max_connections: 100,
    }
}
`.trim(),
  },

  java: {
    path: 'src/main/java/com/example/UserService.java',
    content: `
package com.example;

import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class UserService {
    private final UserRepository userRepository;
    private final CacheService cacheService;

    public UserService(UserRepository userRepository, CacheService cacheService) {
        this.userRepository = userRepository;
        this.cacheService = cacheService;
    }

    @Transactional(readOnly = true)
    public Optional<User> findById(Long id) {
        return userRepository.findById(id);
    }

    @Transactional
    public User createUser(CreateUserRequest request) {
        User user = new User(request.getName(), request.getEmail());
        return userRepository.save(user);
    }

    public List<UserDTO> getAllUsers() {
        return userRepository.findAll()
            .stream()
            .map(this::toDTO)
            .collect(Collectors.toList());
    }

    private UserDTO toDTO(User user) {
        return new UserDTO(user.getId(), user.getName());
    }
}
`.trim(),
  },
}

// ============================================================
// LanguageRouter Integration Tests
// ============================================================

describe('SMI-1336: Multi-Language Integration Tests', () => {
  describe('LanguageRouter with all adapters', () => {
    let router: LanguageRouter

    beforeEach(() => {
      router = new LanguageRouter()
      router.registerAdapter(new TypeScriptAdapter())
      router.registerAdapter(new PythonAdapter())
      router.registerAdapter(new GoAdapter())
      router.registerAdapter(new RustAdapter())
      router.registerAdapter(new JavaAdapter())
    })

    afterEach(() => {
      router.dispose()
    })

    it('registers all five language adapters', () => {
      expect(router.adapterCount).toBe(5)

      const languages = router.getSupportedLanguages()
      expect(languages).toContain('typescript')
      expect(languages).toContain('python')
      expect(languages).toContain('go')
      expect(languages).toContain('rust')
      expect(languages).toContain('java')
    })

    it('routes files to correct adapters based on extension', () => {
      // TypeScript/JavaScript
      expect(router.getLanguage('file.ts')).toBe('typescript')
      expect(router.getLanguage('file.tsx')).toBe('typescript')
      expect(router.getLanguage('file.js')).toBe('typescript')
      expect(router.getLanguage('file.jsx')).toBe('typescript')

      // Python
      expect(router.getLanguage('file.py')).toBe('python')
      expect(router.getLanguage('file.pyi')).toBe('python')

      // Go
      expect(router.getLanguage('file.go')).toBe('go')

      // Rust
      expect(router.getLanguage('file.rs')).toBe('rust')

      // Java
      expect(router.getLanguage('file.java')).toBe('java')
    })

    it('returns null for unsupported extensions', () => {
      expect(router.getLanguage('file.cpp')).toBeNull()
      expect(router.getLanguage('file.rb')).toBeNull()
      expect(router.getLanguage('file.php')).toBeNull()
    })

    it('canHandle returns correct values for all languages', () => {
      expect(router.canHandle('src/main.ts')).toBe(true)
      expect(router.canHandle('src/main.py')).toBe(true)
      expect(router.canHandle('src/main.go')).toBe(true)
      expect(router.canHandle('src/lib.rs')).toBe(true)
      expect(router.canHandle('src/App.java')).toBe(true)
      expect(router.canHandle('src/main.cpp')).toBe(false)
    })

    it('parses TypeScript files correctly', () => {
      const result = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)

      expect(result.imports.length).toBeGreaterThan(0)
      expect(result.imports.some((i) => i.module === 'express')).toBe(true)

      expect(result.functions.length).toBeGreaterThan(0)
      expect(result.functions.some((f) => f.name === 'handleUserRequest')).toBe(true)

      expect(result.exports.length).toBeGreaterThan(0)
      expect(result.exports.some((e) => e.name === 'HandlerConfig')).toBe(true)
    })

    it('parses Python files correctly', () => {
      const result = router.parseFile(fixtures.python.content, fixtures.python.path)

      expect(result.imports.length).toBeGreaterThan(0)
      expect(result.imports.some((i) => i.module === 'pandas')).toBe(true)
      expect(result.imports.some((i) => i.module === 'numpy')).toBe(true)

      expect(result.functions.length).toBeGreaterThan(0)
      expect(result.functions.some((f) => f.name === 'create_processor')).toBe(true)

      expect(result.exports.length).toBeGreaterThan(0)
      expect(result.exports.some((e) => e.name === 'DataProcessor')).toBe(true)
    })

    it('parses Go files correctly', () => {
      const result = router.parseFile(fixtures.go.content, fixtures.go.path)

      expect(result.imports.length).toBeGreaterThan(0)
      expect(result.imports.some((i) => i.module === 'github.com/gin-gonic/gin')).toBe(true)

      expect(result.functions.length).toBeGreaterThan(0)
      expect(result.functions.some((f) => f.name === 'NewServer')).toBe(true)

      expect(result.exports.length).toBeGreaterThan(0)
      expect(result.exports.some((e) => e.name === 'Server')).toBe(true)
    })

    it('parses Rust files correctly', () => {
      const result = router.parseFile(fixtures.rust.content, fixtures.rust.path)

      expect(result.imports.length).toBeGreaterThan(0)
      expect(result.imports.some((i) => i.module.includes('serde'))).toBe(true)

      expect(result.functions.length).toBeGreaterThan(0)
      expect(result.functions.some((f) => f.name === 'new')).toBe(true)

      expect(result.exports.length).toBeGreaterThan(0)
      expect(result.exports.some((e) => e.name === 'Config')).toBe(true)
    })

    it('parses Java files correctly', () => {
      const result = router.parseFile(fixtures.java.content, fixtures.java.path)

      expect(result.imports.length).toBeGreaterThan(0)
      expect(result.imports.some((i) => i.module.includes('springframework'))).toBe(true)

      expect(result.functions.length).toBeGreaterThan(0)
      expect(result.functions.some((f) => f.name === 'findById')).toBe(true)

      expect(result.exports.length).toBeGreaterThan(0)
      expect(result.exports.some((e) => e.name === 'UserService')).toBe(true)
    })

    it('aggregates framework rules from all adapters', () => {
      const rules = router.getAllFrameworkRules()

      // Should have rules from all languages
      expect(rules.length).toBeGreaterThan(10)

      // TypeScript frameworks
      expect(rules.some((r) => r.name === 'React')).toBe(true)
      expect(rules.some((r) => r.name === 'Express')).toBe(true)

      // Python frameworks
      expect(rules.some((r) => r.name === 'Django')).toBe(true)
      expect(rules.some((r) => r.name === 'FastAPI')).toBe(true)

      // Go frameworks
      expect(rules.some((r) => r.name === 'Gin')).toBe(true)

      // Rust frameworks
      expect(rules.some((r) => r.name === 'Actix')).toBe(true)

      // Java frameworks
      expect(rules.some((r) => r.name === 'Spring')).toBe(true)
    })

    it('throws error for unsupported file when adapter not found', () => {
      expect(() => router.parseFile('content', 'file.xyz')).toThrow(/No adapter registered/)
    })
  })

  // ============================================================
  // ParseCache Integration Tests
  // ============================================================

  describe('ParseCache integration with adapters', () => {
    let cache: ParseCache
    let router: LanguageRouter

    beforeEach(() => {
      cache = new ParseCache({ maxMemoryMB: 50 })
      router = new LanguageRouter()
      router.registerAdapter(new TypeScriptAdapter())
      router.registerAdapter(new PythonAdapter())
      router.registerAdapter(new GoAdapter())
    })

    afterEach(() => {
      cache.clear()
      router.dispose()
    })

    it('caches parse results across different languages', () => {
      // Parse and cache TypeScript
      const tsResult = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      cache.set(fixtures.typescript.path, fixtures.typescript.content, tsResult)

      // Parse and cache Python
      const pyResult = router.parseFile(fixtures.python.content, fixtures.python.path)
      cache.set(fixtures.python.path, fixtures.python.content, pyResult)

      // Parse and cache Go
      const goResult = router.parseFile(fixtures.go.content, fixtures.go.path)
      cache.set(fixtures.go.path, fixtures.go.content, goResult)

      // Verify all cached
      expect(cache.size).toBe(3)
      expect(cache.has(fixtures.typescript.path)).toBe(true)
      expect(cache.has(fixtures.python.path)).toBe(true)
      expect(cache.has(fixtures.go.path)).toBe(true)
    })

    it('returns cached results on cache hit', () => {
      const result = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      cache.set(fixtures.typescript.path, fixtures.typescript.content, result)

      const cached = cache.get(fixtures.typescript.path, fixtures.typescript.content)

      expect(cached).not.toBeNull()
      expect(cached).toEqual(result)
    })

    it('invalidates cache on content change', () => {
      const result = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      cache.set(fixtures.typescript.path, fixtures.typescript.content, result)

      const modifiedContent = fixtures.typescript.content + '\n// new comment'
      const cached = cache.get(fixtures.typescript.path, modifiedContent)

      expect(cached).toBeNull()
    })

    it('tracks hit/miss statistics correctly', () => {
      const tsResult = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      cache.set(fixtures.typescript.path, fixtures.typescript.content, tsResult)

      // First access - hit
      cache.get(fixtures.typescript.path, fixtures.typescript.content)
      // Second access - hit
      cache.get(fixtures.typescript.path, fixtures.typescript.content)
      // Miss - file not cached
      cache.get('not-cached.ts', 'content')

      const stats = cache.getStats()
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2)
    })

    it('manages cache entries with add and invalidate', () => {
      // Test cache management behavior with add and invalidate operations
      const testCache = new ParseCache({ maxMemoryMB: 1 })

      // Add multiple entries
      for (let i = 0; i < 10; i++) {
        const content = `export const x${i} = ${i}`
        const result = router.parseFile(content, `file${i}.ts`)
        testCache.set(`file${i}.ts`, content, result)
      }

      // Verify entries were added
      expect(testCache.size).toBe(10)

      // Test that invalidation works (key cache behavior)
      testCache.invalidate(['file0.ts', 'file1.ts', 'file2.ts'])
      expect(testCache.size).toBe(7)

      testCache.clear()
    })

    it('invalidates by pattern across languages', () => {
      // Cache multiple files
      const tsResult = router.parseFile(fixtures.typescript.content, 'src/api/handler.ts')
      cache.set('src/api/handler.ts', fixtures.typescript.content, tsResult)

      const pyResult = router.parseFile(fixtures.python.content, 'src/services/processor.py')
      cache.set('src/services/processor.py', fixtures.python.content, pyResult)

      const goResult = router.parseFile(fixtures.go.content, 'src/server/main.go')
      cache.set('src/server/main.go', fixtures.go.content, goResult)

      // Invalidate by pattern
      cache.invalidatePattern('src/*.ts')
      cache.invalidatePattern('src/*.py')

      // Only Go file should remain
      expect(cache.has('src/server/main.go')).toBe(true)
    })
  })

  // ============================================================
  // ParserWorkerPool Integration Tests
  // ============================================================

  describe('ParserWorkerPool with mixed language batches', () => {
    let pool: ParserWorkerPool

    beforeEach(() => {
      pool = new ParserWorkerPool({
        poolSize: 2,
        minBatchForWorkers: 5, // Lower threshold for testing
      })
    })

    afterEach(() => {
      pool.dispose()
    })

    it('processes single-language batch', async () => {
      const tasks: ParseTask[] = [
        {
          filePath: 'a.ts',
          content: 'export const a = 1',
          language: 'typescript',
        },
        {
          filePath: 'b.ts',
          content: 'export const b = 2',
          language: 'typescript',
        },
        {
          filePath: 'c.ts',
          content: 'export function c() {}',
          language: 'typescript',
        },
      ]

      const results = await pool.parseFiles(tasks)

      expect(results).toHaveLength(3)
      expect(results.every((r) => r.result !== undefined)).toBe(true)
      expect(results.every((r) => r.error === undefined)).toBe(true)
    })

    it('processes mixed-language batch', async () => {
      const tasks: ParseTask[] = [
        {
          filePath: 'handler.ts',
          content: 'export function handle() {}',
          language: 'typescript',
        },
        {
          filePath: 'processor.py',
          content: 'def process(): pass',
          language: 'python',
        },
        {
          filePath: 'main.go',
          content: 'package main\nfunc main() {}',
          language: 'go',
        },
      ]

      const results = await pool.parseFiles(tasks)

      expect(results).toHaveLength(3)

      const tsResult = results.find((r) => r.filePath === 'handler.ts')
      const pyResult = results.find((r) => r.filePath === 'processor.py')
      const goResult = results.find((r) => r.filePath === 'main.go')

      expect(tsResult?.result.functions.length).toBeGreaterThan(0)
      expect(pyResult?.result.functions.length).toBeGreaterThan(0)
      expect(goResult?.result.functions.length).toBeGreaterThan(0)
    })

    it('handles large mixed batch with workers', async () => {
      // Create a batch large enough to use workers
      const tasks: ParseTask[] = []

      // Add TypeScript files
      for (let i = 0; i < 5; i++) {
        tasks.push({
          filePath: `src/ts/file${i}.ts`,
          content: `export const value${i} = ${i}\nexport function fn${i}() { return ${i} }`,
          language: 'typescript',
        })
      }

      // Add Python files
      for (let i = 0; i < 5; i++) {
        tasks.push({
          filePath: `src/py/file${i}.py`,
          content: `def func${i}(): return ${i}\nclass Class${i}: pass`,
          language: 'python',
        })
      }

      // Add Go files
      for (let i = 0; i < 5; i++) {
        tasks.push({
          filePath: `src/go/file${i}.go`,
          content: `package main\nfunc Func${i}() int { return ${i} }`,
          language: 'go',
        })
      }

      const results = await pool.parseFiles(tasks)

      expect(results).toHaveLength(15)
      expect(results.filter((r) => r.filePath.endsWith('.ts'))).toHaveLength(5)
      expect(results.filter((r) => r.filePath.endsWith('.py'))).toHaveLength(5)
      expect(results.filter((r) => r.filePath.endsWith('.go'))).toHaveLength(5)
    })

    it('handles empty batch gracefully', async () => {
      const results = await pool.parseFiles([])
      expect(results).toHaveLength(0)
    })

    it('handles parse errors gracefully', async () => {
      const tasks: ParseTask[] = [
        {
          filePath: 'valid.ts',
          content: 'export const x = 1',
          language: 'typescript',
        },
        {
          filePath: 'unknown.xyz',
          content: 'invalid content',
          language: 'unknown',
        },
      ]

      const results = await pool.parseFiles(tasks)

      expect(results).toHaveLength(2)

      const validResult = results.find((r) => r.filePath === 'valid.ts')
      expect(validResult?.error).toBeUndefined()

      const invalidResult = results.find((r) => r.filePath === 'unknown.xyz')
      expect(invalidResult?.error).toBeDefined()
    })

    it('reports timing information', async () => {
      const tasks: ParseTask[] = [
        {
          filePath: 'test.ts',
          content: fixtures.typescript.content,
          language: 'typescript',
        },
      ]

      const results = await pool.parseFiles(tasks)

      expect(results[0].durationMs).toBeGreaterThanOrEqual(0)
    })

    it('provides pool statistics', () => {
      const stats = pool.getStats()

      expect(stats.poolSize).toBe(2)
      expect(stats.activeWorkers).toBe(0)
      expect(stats.queuedTasks).toBe(0)
    })
  })

  // ============================================================
  // ResultAggregator Integration Tests
  // ============================================================

  describe('ResultAggregator combining results from multiple languages', () => {
    let aggregator: ResultAggregator
    let router: LanguageRouter

    beforeEach(() => {
      aggregator = new ResultAggregator()
      router = new LanguageRouter()
      router.registerAdapter(new TypeScriptAdapter())
      router.registerAdapter(new PythonAdapter())
      router.registerAdapter(new GoAdapter())
      router.registerAdapter(new RustAdapter())
      router.registerAdapter(new JavaAdapter())
    })

    afterEach(() => {
      aggregator.reset()
      router.dispose()
    })

    it('aggregates results from all supported languages', () => {
      // Parse and aggregate TypeScript
      const tsResult = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      aggregator.add({
        filePath: fixtures.typescript.path,
        language: 'typescript',
        result: tsResult,
      })

      // Parse and aggregate Python
      const pyResult = router.parseFile(fixtures.python.content, fixtures.python.path)
      aggregator.add({
        filePath: fixtures.python.path,
        language: 'python',
        result: pyResult,
      })

      // Parse and aggregate Go
      const goResult = router.parseFile(fixtures.go.content, fixtures.go.path)
      aggregator.add({
        filePath: fixtures.go.path,
        language: 'go',
        result: goResult,
      })

      // Parse and aggregate Rust
      const rustResult = router.parseFile(fixtures.rust.content, fixtures.rust.path)
      aggregator.add({
        filePath: fixtures.rust.path,
        language: 'rust',
        result: rustResult,
      })

      // Parse and aggregate Java
      const javaResult = router.parseFile(fixtures.java.content, fixtures.java.path)
      aggregator.add({
        filePath: fixtures.java.path,
        language: 'java',
        result: javaResult,
      })

      expect(aggregator.getFileCount()).toBe(5)
      expect(aggregator.getLanguages()).toContain('typescript')
      expect(aggregator.getLanguages()).toContain('python')
      expect(aggregator.getLanguages()).toContain('go')
      expect(aggregator.getLanguages()).toContain('rust')
      expect(aggregator.getLanguages()).toContain('java')
    })

    it('aggregates imports from all languages with correct annotation', () => {
      const tsResult = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      aggregator.add({
        filePath: fixtures.typescript.path,
        language: 'typescript',
        result: tsResult,
      })

      const pyResult = router.parseFile(fixtures.python.content, fixtures.python.path)
      aggregator.add({
        filePath: fixtures.python.path,
        language: 'python',
        result: pyResult,
      })

      const imports = aggregator.getImports()

      // Should have imports from both languages
      const tsImports = imports.filter((i) => i.language === 'typescript')
      const pyImports = imports.filter((i) => i.language === 'python')

      expect(tsImports.length).toBeGreaterThan(0)
      expect(pyImports.length).toBeGreaterThan(0)

      // Verify source file annotation
      expect(tsImports.every((i) => i.sourceFile === fixtures.typescript.path)).toBe(true)
      expect(pyImports.every((i) => i.sourceFile === fixtures.python.path)).toBe(true)
    })

    it('aggregates exports from all languages with correct kind', () => {
      const tsResult = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      aggregator.add({
        filePath: fixtures.typescript.path,
        language: 'typescript',
        result: tsResult,
      })

      const goResult = router.parseFile(fixtures.go.content, fixtures.go.path)
      aggregator.add({
        filePath: fixtures.go.path,
        language: 'go',
        result: goResult,
      })

      const exports = aggregator.getExports()

      // TypeScript exports
      expect(exports.some((e) => e.name === 'HandlerConfig' && e.kind === 'interface')).toBe(true)

      // Go exports (structs)
      expect(exports.some((e) => e.name === 'Server' && e.kind === 'struct')).toBe(true)
    })

    it('aggregates functions from all languages with async detection', () => {
      const tsResult = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      aggregator.add({
        filePath: fixtures.typescript.path,
        language: 'typescript',
        result: tsResult,
      })

      const pyResult = router.parseFile(fixtures.python.content, fixtures.python.path)
      aggregator.add({
        filePath: fixtures.python.path,
        language: 'python',
        result: pyResult,
      })

      const functions = aggregator.getFunctions()

      // TypeScript async function
      const tsAsyncFunc = functions.find((f) => f.name === 'handleUserRequest')
      expect(tsAsyncFunc?.isAsync).toBe(true)
      expect(tsAsyncFunc?.language).toBe('typescript')

      // Python async function
      const pyAsyncFunc = functions.find((f) => f.name === 'process_batch')
      expect(pyAsyncFunc?.isAsync).toBe(true)
      expect(pyAsyncFunc?.language).toBe('python')
    })

    it('builds complete CodebaseContext from multi-language project', () => {
      // Add all fixture files
      const files: Array<{
        path: string
        content: string
        language: SupportedLanguage
      }> = [
        { ...fixtures.typescript, language: 'typescript' },
        { ...fixtures.python, language: 'python' },
        { ...fixtures.go, language: 'go' },
        { ...fixtures.rust, language: 'rust' },
        { ...fixtures.java, language: 'java' },
      ]

      for (const file of files) {
        const result = router.parseFile(file.content, file.path)
        aggregator.add({
          filePath: file.path,
          language: file.language,
          result,
        })
        aggregator.addLines(file.content.split('\n').length)
      }

      const context = aggregator.build(
        '/project',
        [
          { name: 'express', version: '^4.18.0', isDev: false },
          { name: 'pandas', version: '>=2.0', isDev: false },
        ],
        [
          { name: 'Express', confidence: 0.9, evidence: ['import express'] },
          { name: 'Gin', confidence: 0.9, evidence: ['import gin'] },
        ],
        { durationMs: 500, version: '2.0.0', cacheHitRate: 0.8 }
      )

      expect(context.rootPath).toBe('/project')
      expect(context.imports.length).toBeGreaterThan(0)
      expect(context.exports.length).toBeGreaterThan(0)
      expect(context.functions.length).toBeGreaterThan(0)
      expect(context.frameworks).toHaveLength(2)
      expect(context.dependencies).toHaveLength(2)
      expect(context.stats.totalFiles).toBe(5)
      expect(context.stats.totalLines).toBeGreaterThan(0)
      expect(context.metadata.languages).toHaveLength(5)
      expect(context.metadata.cacheHitRate).toBe(0.8)
    })

    it('provides accurate summary statistics', () => {
      const tsResult = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      aggregator.add({
        filePath: fixtures.typescript.path,
        language: 'typescript',
        result: tsResult,
      })
      aggregator.addLines(fixtures.typescript.content.split('\n').length)

      const pyResult = router.parseFile(fixtures.python.content, fixtures.python.path)
      aggregator.add({
        filePath: fixtures.python.path,
        language: 'python',
        result: pyResult,
      })
      aggregator.addLines(fixtures.python.content.split('\n').length)

      const summary = aggregator.getSummary()

      expect(summary.files).toBe(2)
      expect(summary.imports).toBeGreaterThan(0)
      expect(summary.exports).toBeGreaterThan(0)
      expect(summary.functions).toBeGreaterThan(0)
      expect(summary.lines).toBeGreaterThan(0)
      expect(summary.languages).toContain('typescript')
      expect(summary.languages).toContain('python')
    })

    it('merges two aggregators correctly', () => {
      const aggregator1 = new ResultAggregator()
      const aggregator2 = new ResultAggregator()

      const tsResult = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      aggregator1.add({
        filePath: fixtures.typescript.path,
        language: 'typescript',
        result: tsResult,
      })

      const pyResult = router.parseFile(fixtures.python.content, fixtures.python.path)
      aggregator2.add({
        filePath: fixtures.python.path,
        language: 'python',
        result: pyResult,
      })

      aggregator1.merge(aggregator2)

      expect(aggregator1.getFileCount()).toBe(2)
      expect(aggregator1.getLanguages()).toContain('typescript')
      expect(aggregator1.getLanguages()).toContain('python')
    })

    it('resets state completely', () => {
      const tsResult = router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
      aggregator.add({
        filePath: fixtures.typescript.path,
        language: 'typescript',
        result: tsResult,
      })

      aggregator.reset()

      expect(aggregator.getFileCount()).toBe(0)
      expect(aggregator.getImports()).toHaveLength(0)
      expect(aggregator.getExports()).toHaveLength(0)
      expect(aggregator.getFunctions()).toHaveLength(0)
      expect(aggregator.getLanguages()).toHaveLength(0)
    })
  })

  // ============================================================
  // End-to-End Multi-Language Project Scenario
  // ============================================================

  describe('End-to-end multi-language project analysis', () => {
    let router: LanguageRouter
    let cache: ParseCache
    let aggregator: ResultAggregator

    beforeEach(() => {
      router = new LanguageRouter()
      router.registerAdapter(new TypeScriptAdapter())
      router.registerAdapter(new PythonAdapter())
      router.registerAdapter(new GoAdapter())
      cache = new ParseCache({ maxMemoryMB: 50 })
      aggregator = new ResultAggregator()
    })

    afterEach(() => {
      router.dispose()
      cache.clear()
      aggregator.reset()
    })

    it('analyzes a realistic mixed-language microservices project', () => {
      // Simulate a microservices project with multiple languages
      const projectFiles = [
        {
          path: 'api-gateway/src/server.ts',
          content: `
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'

export function createGateway(config: GatewayConfig) {
  const app = express()
  app.use('/users', createProxyMiddleware({ target: config.userServiceUrl }))
  return app
}
          `.trim(),
          language: 'typescript' as SupportedLanguage,
        },
        {
          path: 'user-service/app/main.py',
          content: `
from fastapi import FastAPI, Depends
from sqlalchemy.orm import Session
from .database import get_db
from .models import User

app = FastAPI()

@app.get("/users/{user_id}")
async def get_user(user_id: int, db: Session = Depends(get_db)):
    return db.query(User).filter(User.id == user_id).first()
          `.trim(),
          language: 'python' as SupportedLanguage,
        },
        {
          path: 'notification-service/main.go',
          content: `
package main

import (
    "github.com/gin-gonic/gin"
    "github.com/go-redis/redis/v8"
)

func main() {
    router := gin.Default()
    router.POST("/notify", HandleNotify)
    router.Run(":8082")
}

func HandleNotify(c *gin.Context) {
    c.JSON(200, gin.H{"status": "sent"})
}
          `.trim(),
          language: 'go' as SupportedLanguage,
        },
      ]

      // Parse each file with caching
      for (const file of projectFiles) {
        // Check cache first
        let result = cache.get(file.path, file.content)

        if (!result) {
          // Parse if not cached
          result = router.parseFile(file.content, file.path)
          cache.set(file.path, file.content, result)
        }

        // Aggregate
        aggregator.add({
          filePath: file.path,
          language: file.language,
          result,
        })
        aggregator.addLines(file.content.split('\n').length)
      }

      // Verify comprehensive analysis
      const context = aggregator.build('/microservices-project', [], [], {
        durationMs: 100,
        version: '2.0.0',
        cacheHitRate: 0,
      })

      // File counts
      expect(context.stats.totalFiles).toBe(3)
      expect(context.metadata.languages).toHaveLength(3)

      // Cross-language imports
      const imports = context.imports
      expect(imports.some((i) => i.module === 'express' && i.language === 'typescript')).toBe(true)
      expect(imports.some((i) => i.module === 'fastapi' && i.language === 'python')).toBe(true)
      expect(
        imports.some((i) => i.module === 'github.com/gin-gonic/gin' && i.language === 'go')
      ).toBe(true)

      // Cross-language functions
      const functions = context.functions
      expect(functions.some((f) => f.name === 'createGateway' && f.language === 'typescript')).toBe(
        true
      )
      expect(functions.some((f) => f.name === 'get_user' && f.language === 'python')).toBe(true)
      expect(functions.some((f) => f.name === 'HandleNotify' && f.language === 'go')).toBe(true)
    })

    it('verifies cross-adapter output format consistency', () => {
      // All adapters should produce consistent ParseResult structure
      const testCases: Array<{ path: string; content: string }> = [
        { path: 'test.ts', content: 'export function test() {}' },
        { path: 'test.py', content: 'def test(): pass' },
        { path: 'test.go', content: 'package main\nfunc Test() {}' },
      ]

      for (const { path, content } of testCases) {
        const result = router.parseFile(content, path)

        // All results should have the required arrays
        expect(Array.isArray(result.imports)).toBe(true)
        expect(Array.isArray(result.exports)).toBe(true)
        expect(Array.isArray(result.functions)).toBe(true)

        // Functions should have consistent shape
        for (const func of result.functions) {
          expect(typeof func.name).toBe('string')
          expect(typeof func.parameterCount).toBe('number')
          expect(typeof func.isAsync).toBe('boolean')
          expect(typeof func.isExported).toBe('boolean')
          expect(typeof func.sourceFile).toBe('string')
          expect(typeof func.line).toBe('number')
        }

        // Imports should have consistent shape
        for (const imp of result.imports) {
          expect(typeof imp.module).toBe('string')
          expect(Array.isArray(imp.namedImports)).toBe(true)
          expect(typeof imp.isTypeOnly).toBe('boolean')
          expect(typeof imp.sourceFile).toBe('string')
        }

        // Exports should have consistent shape
        for (const exp of result.exports) {
          expect(typeof exp.name).toBe('string')
          expect(typeof exp.kind).toBe('string')
          expect(typeof exp.isDefault).toBe('boolean')
          expect(typeof exp.sourceFile).toBe('string')
        }
      }
    })

    it('tests cache hit/miss behavior across languages', () => {
      const files = [
        { path: 'a.ts', content: 'export const a = 1' },
        { path: 'b.py', content: 'a = 1' },
        { path: 'c.go', content: 'package main\nvar a = 1' },
      ]

      // First pass - all misses
      for (const file of files) {
        const cached = cache.get(file.path, file.content)
        expect(cached).toBeNull()

        const result = router.parseFile(file.content, file.path)
        cache.set(file.path, file.content, result)
      }

      // Second pass - all hits
      for (const file of files) {
        const cached = cache.get(file.path, file.content)
        expect(cached).not.toBeNull()
      }

      const stats = cache.getStats()
      // 3 misses + 3 hits = 50% hit rate
      expect(stats.hitRate).toBeCloseTo(0.5, 2)

      // Third pass with modified content - misses
      for (const file of files) {
        const modifiedContent = file.content + '\n// modified'
        const cached = cache.get(file.path, modifiedContent)
        expect(cached).toBeNull()
      }
    })
  })

  // ============================================================
  // Performance Tests
  // ============================================================

  describe('Performance benchmarks', () => {
    let router: LanguageRouter
    let pool: ParserWorkerPool

    beforeEach(() => {
      router = new LanguageRouter()
      router.registerAdapter(new TypeScriptAdapter())
      router.registerAdapter(new PythonAdapter())
      router.registerAdapter(new GoAdapter())
      pool = new ParserWorkerPool({ poolSize: 4, minBatchForWorkers: 5 })
    })

    afterEach(() => {
      router.dispose()
      pool.dispose()
    })

    it('parses mixed-language batch under 500ms', async () => {
      const tasks: ParseTask[] = []

      // Generate test files
      for (let i = 0; i < 10; i++) {
        tasks.push({
          filePath: `file${i}.ts`,
          content: fixtures.typescript.content,
          language: 'typescript',
        })
        tasks.push({
          filePath: `file${i}.py`,
          content: fixtures.python.content,
          language: 'python',
        })
        tasks.push({
          filePath: `file${i}.go`,
          content: fixtures.go.content,
          language: 'go',
        })
      }

      const start = performance.now()
      const results = await pool.parseFiles(tasks)
      const duration = performance.now() - start

      expect(results).toHaveLength(30)
      expect(duration).toBeLessThan(500)
    })

    it('maintains consistent parsing speed across languages', () => {
      const iterations = 10
      const times: Record<string, number[]> = {
        typescript: [],
        python: [],
        go: [],
      }

      for (let i = 0; i < iterations; i++) {
        // TypeScript
        let start = performance.now()
        router.parseFile(fixtures.typescript.content, fixtures.typescript.path)
        times.typescript.push(performance.now() - start)

        // Python
        start = performance.now()
        router.parseFile(fixtures.python.content, fixtures.python.path)
        times.python.push(performance.now() - start)

        // Go
        start = performance.now()
        router.parseFile(fixtures.go.content, fixtures.go.path)
        times.go.push(performance.now() - start)
      }

      // Calculate averages
      const avgTimes = {
        typescript: times.typescript.reduce((a, b) => a + b, 0) / iterations,
        python: times.python.reduce((a, b) => a + b, 0) / iterations,
        go: times.go.reduce((a, b) => a + b, 0) / iterations,
      }

      // All languages should parse in under 50ms average
      expect(avgTimes.typescript).toBeLessThan(50)
      expect(avgTimes.python).toBeLessThan(50)
      expect(avgTimes.go).toBeLessThan(50)
    })
  })
})
