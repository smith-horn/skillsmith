/**
 * SMI-1310: TypeScript Adapter Tests
 *
 * Tests for the TypeScriptAdapter class, verifying:
 * - File extension handling
 * - Parse result extraction (imports, exports, functions)
 * - React/JSX component parsing
 * - Async function detection
 * - Backward compatibility with existing analyzer
 *
 * @see docs/architecture/multi-language-analysis.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TypeScriptAdapter } from '../typescript.js'
import { parseFile } from '../../parsers.js'

describe('TypeScriptAdapter', () => {
  let adapter: TypeScriptAdapter

  beforeEach(() => {
    adapter = new TypeScriptAdapter()
  })

  afterEach(() => {
    adapter.dispose()
  })

  describe('canHandle', () => {
    it('handles .ts files', () => {
      expect(adapter.canHandle('src/index.ts')).toBe(true)
      expect(adapter.canHandle('lib/utils.ts')).toBe(true)
    })

    it('handles .tsx files', () => {
      expect(adapter.canHandle('components/Button.tsx')).toBe(true)
    })

    it('handles .js files', () => {
      expect(adapter.canHandle('scripts/build.js')).toBe(true)
    })

    it('handles .jsx files', () => {
      expect(adapter.canHandle('components/Card.jsx')).toBe(true)
    })

    it('handles .mjs files', () => {
      expect(adapter.canHandle('lib/module.mjs')).toBe(true)
    })

    it('handles .cjs files', () => {
      expect(adapter.canHandle('config.cjs')).toBe(true)
    })

    it('does not handle .py files', () => {
      expect(adapter.canHandle('main.py')).toBe(false)
    })

    it('does not handle .go files', () => {
      expect(adapter.canHandle('main.go')).toBe(false)
    })

    it('does not handle .rs files', () => {
      expect(adapter.canHandle('lib.rs')).toBe(false)
    })
  })

  describe('language property', () => {
    it('returns typescript', () => {
      expect(adapter.language).toBe('typescript')
    })
  })

  describe('extensions property', () => {
    it('includes all TypeScript/JavaScript extensions', () => {
      expect(adapter.extensions).toContain('.ts')
      expect(adapter.extensions).toContain('.tsx')
      expect(adapter.extensions).toContain('.js')
      expect(adapter.extensions).toContain('.jsx')
      expect(adapter.extensions).toContain('.mjs')
      expect(adapter.extensions).toContain('.cjs')
    })
  })

  describe('parseFile', () => {
    it('extracts named imports', () => {
      const content = `
import { useState, useEffect } from 'react'
import { Button, Input } from './components'
      `

      const result = adapter.parseFile(content, 'test.ts')

      expect(result.imports).toHaveLength(2)
      expect(result.imports[0]).toMatchObject({
        module: 'react',
        namedImports: ['useState', 'useEffect'],
      })
      expect(result.imports[1]).toMatchObject({
        module: './components',
        namedImports: ['Button', 'Input'],
      })
    })

    it('extracts default imports', () => {
      const content = `
import React from 'react'
import express from 'express'
      `

      const result = adapter.parseFile(content, 'test.ts')

      expect(result.imports).toHaveLength(2)
      expect(result.imports[0]).toMatchObject({
        module: 'react',
        defaultImport: 'React',
      })
      expect(result.imports[1]).toMatchObject({
        module: 'express',
        defaultImport: 'express',
      })
    })

    it('extracts namespace imports', () => {
      const content = `
import * as fs from 'fs'
import * as path from 'path'
      `

      const result = adapter.parseFile(content, 'test.ts')

      expect(result.imports).toHaveLength(2)
      expect(result.imports[0]).toMatchObject({
        module: 'fs',
        namespaceImport: 'fs',
      })
    })

    it('extracts type-only imports', () => {
      const content = `
import type { User } from './types'
import type { Config } from './config'
      `

      const result = adapter.parseFile(content, 'test.ts')

      expect(result.imports).toHaveLength(2)
      expect(result.imports[0]).toMatchObject({
        module: './types',
        isTypeOnly: true,
      })
    })

    it('extracts exported functions', () => {
      const content = `
export function greet(name: string): string {
  return 'Hello, ' + name
}

export async function fetchUser(id: number): Promise<User> {
  return await api.get('/users/' + id)
}
      `

      const result = adapter.parseFile(content, 'test.ts')

      expect(result.functions).toHaveLength(2)
      expect(result.functions[0]).toMatchObject({
        name: 'greet',
        parameterCount: 1,
        isAsync: false,
        isExported: true,
      })
      expect(result.functions[1]).toMatchObject({
        name: 'fetchUser',
        parameterCount: 1,
        isAsync: true,
        isExported: true,
      })
    })

    it('extracts arrow functions', () => {
      const content = `
export const add = (a: number, b: number) => a + b

export const delay = async (ms: number) => {
  return new Promise(resolve => setTimeout(resolve, ms))
}
      `

      const result = adapter.parseFile(content, 'test.ts')

      expect(result.functions).toHaveLength(2)
      expect(result.functions[0]).toMatchObject({
        name: 'add',
        parameterCount: 2,
        isAsync: false,
        isExported: true,
      })
      expect(result.functions[1]).toMatchObject({
        name: 'delay',
        parameterCount: 1,
        isAsync: true,
        isExported: true,
      })
    })

    it('extracts exported classes', () => {
      const content = `
export class UserService {
  constructor(private db: Database) {}

  async findById(id: number): Promise<User> {
    return this.db.query('SELECT * FROM users WHERE id = ?', [id])
  }
}

export default class ApiClient {}
      `

      const result = adapter.parseFile(content, 'test.ts')

      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: 'UserService',
          kind: 'class',
          isDefault: false,
        })
      )
      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: 'ApiClient',
          kind: 'class',
          isDefault: true,
        })
      )
    })

    it('extracts exported interfaces', () => {
      const content = `
export interface User {
  id: number
  name: string
  email: string
}

export interface Config {
  apiUrl: string
  timeout: number
}
      `

      const result = adapter.parseFile(content, 'test.ts')

      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: 'User',
          kind: 'interface',
        })
      )
      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: 'Config',
          kind: 'interface',
        })
      )
    })

    it('extracts exported types', () => {
      const content = `
export type UserId = number
export type UserRole = 'admin' | 'user' | 'guest'
      `

      const result = adapter.parseFile(content, 'test.ts')

      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: 'UserId',
          kind: 'type',
        })
      )
      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: 'UserRole',
          kind: 'type',
        })
      )
    })
  })

  describe('parseFile with JSX', () => {
    it('parses React functional component', () => {
      const content = `
import React from 'react'
import { Button } from './Button'

interface Props {
  title: string
  onClick: () => void
}

export const Card: React.FC<Props> = ({ title, onClick }) => {
  return (
    <div className="card">
      <h2>{title}</h2>
      <Button onClick={onClick}>Click me</Button>
    </div>
  )
}
      `

      const result = adapter.parseFile(content, 'Card.tsx')

      expect(result.imports).toHaveLength(2)
      expect(result.imports[0]).toMatchObject({
        module: 'react',
        defaultImport: 'React',
      })

      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: 'Card',
          kind: 'function',
        })
      )
    })

    it('parses React component with hooks', () => {
      const content = `
import { useState, useEffect } from 'react'

export function Counter() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    document.title = \`Count: \${count}\`
  }, [count])

  return <button onClick={() => setCount(c => c + 1)}>{count}</button>
}
      `

      const result = adapter.parseFile(content, 'Counter.tsx')

      expect(result.imports[0]).toMatchObject({
        module: 'react',
        namedImports: ['useState', 'useEffect'],
      })

      expect(result.functions).toContainEqual(
        expect.objectContaining({
          name: 'Counter',
          isExported: true,
        })
      )
    })
  })

  describe('parseFile with async functions', () => {
    it('detects async functions correctly', () => {
      const content = `
export async function fetchData(): Promise<Data> {
  const response = await fetch('/api/data')
  return response.json()
}

export const fetchUser = async (id: number) => {
  return await api.get(\`/users/\${id}\`)
}

export function syncOperation(): void {
  console.log('sync')
}
      `

      const result = adapter.parseFile(content, 'api.ts')

      const fetchData = result.functions.find((f) => f.name === 'fetchData')
      const fetchUser = result.functions.find((f) => f.name === 'fetchUser')
      const syncOp = result.functions.find((f) => f.name === 'syncOperation')

      expect(fetchData?.isAsync).toBe(true)
      expect(fetchUser?.isAsync).toBe(true)
      expect(syncOp?.isAsync).toBe(false)
    })
  })

  describe('parseIncremental', () => {
    it('returns same result as parseFile (fallback until SMI-1309)', () => {
      const content = `
import { foo } from 'bar'
export function test() {}
      `

      const fullResult = adapter.parseFile(content, 'test.ts')
      const incrementalResult = adapter.parseIncremental(content, 'test.ts')

      expect(incrementalResult).toEqual(fullResult)
    })
  })

  describe('getFrameworkRules', () => {
    it('returns framework detection rules', () => {
      const rules = adapter.getFrameworkRules()

      expect(rules.length).toBeGreaterThan(0)
    })

    it('includes React detection', () => {
      const rules = adapter.getFrameworkRules()
      const react = rules.find((r) => r.name === 'React')

      expect(react).toBeDefined()
      expect(react?.depIndicators).toContain('react')
      expect(react?.importIndicators).toContain('react')
    })

    it('includes Next.js detection', () => {
      const rules = adapter.getFrameworkRules()
      const nextjs = rules.find((r) => r.name === 'Next.js')

      expect(nextjs).toBeDefined()
      expect(nextjs?.depIndicators).toContain('next')
    })

    it('includes Express detection', () => {
      const rules = adapter.getFrameworkRules()
      const express = rules.find((r) => r.name === 'Express')

      expect(express).toBeDefined()
      expect(express?.importIndicators).toContain('express')
    })
  })

  describe('backward compatibility with existing analyzer', () => {
    it('parseFile matches existing parseFile function', () => {
      const content = `
import { useState } from 'react'

export function useCounter(initial: number = 0) {
  const [count, setCount] = useState(initial)
  return { count, increment: () => setCount(c => c + 1) }
}
      `

      const adapterResult = adapter.parseFile(content, 'hooks.ts')
      const legacyResult = parseFile(content, 'hooks.ts')

      // Results should be identical
      expect(adapterResult.imports).toEqual(legacyResult.imports)
      expect(adapterResult.exports).toEqual(legacyResult.exports)
      expect(adapterResult.functions).toEqual(legacyResult.functions)
    })
  })

  describe('dispose', () => {
    it('can be called multiple times without error', () => {
      expect(() => {
        adapter.dispose()
        adapter.dispose()
      }).not.toThrow()
    })
  })
})
