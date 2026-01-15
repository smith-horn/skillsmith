/**
 * SMI-1436: MCP Server Template Tests
 *
 * Tests for the MCP server scaffolding template generation.
 */

import { describe, it, expect } from 'vitest'
import {
  renderMcpServerTemplates,
  type McpServerTemplateData,
} from '../src/templates/mcp-server.template.js'

describe('SMI-1436: MCP Server Template Generation', () => {
  const basicTemplateData: McpServerTemplateData = {
    name: 'test-mcp-server',
    description: 'A test MCP server',
    author: 'test-author',
    tools: [],
  }

  describe('renderMcpServerTemplates', () => {
    it('generates all required files', () => {
      const files = renderMcpServerTemplates(basicTemplateData)

      expect(files.has('package.json')).toBe(true)
      expect(files.has('tsconfig.json')).toBe(true)
      expect(files.has('src/index.ts')).toBe(true)
      expect(files.has('src/server.ts')).toBe(true)
      expect(files.has('src/tools/index.ts')).toBe(true)
      expect(files.has('src/tools/example.ts')).toBe(true)
      expect(files.has('README.md')).toBe(true)
      expect(files.has('.gitignore')).toBe(true)
    })

    it('generates exactly 8 files', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      expect(files.size).toBe(8)
    })
  })

  describe('package.json generation', () => {
    it('includes correct name', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const packageJson = JSON.parse(files.get('package.json') || '{}')

      expect(packageJson.name).toBe('test-mcp-server')
    })

    it('includes correct description', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const packageJson = JSON.parse(files.get('package.json') || '{}')

      expect(packageJson.description).toBe('A test MCP server')
    })

    it('includes correct author', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const packageJson = JSON.parse(files.get('package.json') || '{}')

      expect(packageJson.author).toBe('test-author')
    })

    it('includes MCP SDK dependency', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const packageJson = JSON.parse(files.get('package.json') || '{}')

      expect(packageJson.dependencies).toHaveProperty('@modelcontextprotocol/sdk')
    })

    it('includes required dev dependencies', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const packageJson = JSON.parse(files.get('package.json') || '{}')

      expect(packageJson.devDependencies).toHaveProperty('@types/node')
      expect(packageJson.devDependencies).toHaveProperty('typescript')
      expect(packageJson.devDependencies).toHaveProperty('tsx')
    })

    it('includes required scripts', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const packageJson = JSON.parse(files.get('package.json') || '{}')

      expect(packageJson.scripts).toHaveProperty('build')
      expect(packageJson.scripts).toHaveProperty('start')
      expect(packageJson.scripts).toHaveProperty('dev')
    })

    it('sets type to module', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const packageJson = JSON.parse(files.get('package.json') || '{}')

      expect(packageJson.type).toBe('module')
    })

    it('configures bin entry point', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const packageJson = JSON.parse(files.get('package.json') || '{}')

      expect(packageJson.bin).toHaveProperty('test-mcp-server')
    })
  })

  describe('tsconfig.json generation', () => {
    it('targets ES2022', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const tsconfig = JSON.parse(files.get('tsconfig.json') || '{}')

      expect(tsconfig.compilerOptions.target).toBe('ES2022')
    })

    it('uses NodeNext module resolution', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const tsconfig = JSON.parse(files.get('tsconfig.json') || '{}')

      expect(tsconfig.compilerOptions.module).toBe('NodeNext')
      expect(tsconfig.compilerOptions.moduleResolution).toBe('NodeNext')
    })

    it('enables strict mode', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const tsconfig = JSON.parse(files.get('tsconfig.json') || '{}')

      expect(tsconfig.compilerOptions.strict).toBe(true)
    })

    it('outputs to dist directory', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const tsconfig = JSON.parse(files.get('tsconfig.json') || '{}')

      expect(tsconfig.compilerOptions.outDir).toBe('./dist')
    })
  })

  describe('src/index.ts generation', () => {
    it('includes shebang for npx execution', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const indexTs = files.get('src/index.ts') || ''

      expect(indexTs.startsWith('#!/usr/bin/env node')).toBe(true)
    })

    it('includes server name in comments', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const indexTs = files.get('src/index.ts') || ''

      expect(indexTs).toContain('test-mcp-server')
    })

    it('imports createServer from server module', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const indexTs = files.get('src/index.ts') || ''

      expect(indexTs).toContain("import { createServer } from './server.js'")
    })
  })

  describe('src/server.ts generation', () => {
    it('includes server name', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const serverTs = files.get('src/server.ts') || ''

      expect(serverTs).toContain("name: 'test-mcp-server'")
    })

    it('imports MCP SDK components', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const serverTs = files.get('src/server.ts') || ''

      expect(serverTs).toContain('@modelcontextprotocol/sdk/server/index.js')
      expect(serverTs).toContain('@modelcontextprotocol/sdk/server/stdio.js')
      expect(serverTs).toContain('@modelcontextprotocol/sdk/types.js')
    })

    it('sets up tool capabilities', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const serverTs = files.get('src/server.ts') || ''

      expect(serverTs).toContain('capabilities:')
      expect(serverTs).toContain('tools: {}')
    })
  })

  describe('tool generation', () => {
    it('generates example tool when no tools provided', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const toolsIndex = files.get('src/tools/index.ts') || ''

      expect(toolsIndex).toContain('example')
    })

    it('includes example.ts file', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const exampleTool = files.get('src/tools/example.ts') || ''

      expect(exampleTool).toContain("name: 'example'")
      expect(exampleTool).toContain('handleExampleTool')
    })

    it('generates custom tool definitions when tools provided', () => {
      const dataWithTools: McpServerTemplateData = {
        ...basicTemplateData,
        tools: [
          {
            name: 'greet',
            description: 'Greet a user',
            parameters: [
              {
                name: 'name',
                type: 'string',
                description: 'Name to greet',
                required: true,
              },
            ],
          },
        ],
      }

      const files = renderMcpServerTemplates(dataWithTools)
      const toolsIndex = files.get('src/tools/index.ts') || ''

      expect(toolsIndex).toContain("name: 'greet'")
      expect(toolsIndex).toContain("description: 'Greet a user'")
    })

    it('includes required parameters in tool definition', () => {
      const dataWithTools: McpServerTemplateData = {
        ...basicTemplateData,
        tools: [
          {
            name: 'search',
            description: 'Search for items',
            parameters: [
              {
                name: 'query',
                type: 'string',
                description: 'Search query',
                required: true,
              },
              {
                name: 'limit',
                type: 'number',
                description: 'Max results',
                required: false,
              },
            ],
          },
        ],
      }

      const files = renderMcpServerTemplates(dataWithTools)
      const toolsIndex = files.get('src/tools/index.ts') || ''

      expect(toolsIndex).toContain("'query'")
      expect(toolsIndex).toContain('required:')
    })
  })

  describe('README.md generation', () => {
    it('includes project name', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const readme = files.get('README.md') || ''

      expect(readme).toContain('# test-mcp-server')
    })

    it('includes description', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const readme = files.get('README.md') || ''

      expect(readme).toContain('A test MCP server')
    })

    it('includes installation instructions', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const readme = files.get('README.md') || ''

      expect(readme).toContain('npm install')
      expect(readme).toContain('npx')
    })

    it('includes Claude configuration example', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const readme = files.get('README.md') || ''

      expect(readme).toContain('mcpServers')
      expect(readme).toContain('~/.claude/settings.json')
    })

    it('includes development instructions', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const readme = files.get('README.md') || ''

      expect(readme).toContain('npm run dev')
      expect(readme).toContain('npm run build')
    })
  })

  describe('.gitignore generation', () => {
    it('ignores node_modules', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const gitignore = files.get('.gitignore') || ''

      expect(gitignore).toContain('node_modules/')
    })

    it('ignores dist directory', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const gitignore = files.get('.gitignore') || ''

      expect(gitignore).toContain('dist/')
    })

    it('ignores environment files', () => {
      const files = renderMcpServerTemplates(basicTemplateData)
      const gitignore = files.get('.gitignore') || ''

      expect(gitignore).toContain('.env')
    })
  })

  describe('edge cases', () => {
    it('handles special characters in description', () => {
      const dataWithSpecialChars: McpServerTemplateData = {
        ...basicTemplateData,
        description: 'An MCP server for "testing" & validation',
      }

      const files = renderMcpServerTemplates(dataWithSpecialChars)
      const readme = files.get('README.md') || ''

      expect(readme).toContain('An MCP server for "testing" & validation')
    })

    it('escapes single quotes in tool descriptions', () => {
      const dataWithQuotes: McpServerTemplateData = {
        ...basicTemplateData,
        tools: [
          {
            name: 'test',
            description: "It's a test tool",
            parameters: [
              {
                name: 'input',
                type: 'string' as const,
                description: "The user's input",
                required: true,
              },
            ],
          },
        ],
      }

      const files = renderMcpServerTemplates(dataWithQuotes)
      const toolsIndex = files.get('src/tools/index.ts') || ''

      // Single quotes should be escaped to prevent syntax errors
      expect(toolsIndex).toContain("\\'s")
      expect(toolsIndex).not.toContain("description: 'It's")
    })

    it('handles hyphenated server names', () => {
      const dataWithHyphens: McpServerTemplateData = {
        ...basicTemplateData,
        name: 'my-awesome-mcp-server',
      }

      const files = renderMcpServerTemplates(dataWithHyphens)
      const packageJson = JSON.parse(files.get('package.json') || '{}')

      expect(packageJson.name).toBe('my-awesome-mcp-server')
      expect(packageJson.bin).toHaveProperty('my-awesome-mcp-server')
    })

    it('handles multiple tools', () => {
      const dataWithMultipleTools: McpServerTemplateData = {
        ...basicTemplateData,
        tools: [
          { name: 'tool1', description: 'First tool' },
          { name: 'tool2', description: 'Second tool' },
          { name: 'tool3', description: 'Third tool' },
        ],
      }

      const files = renderMcpServerTemplates(dataWithMultipleTools)
      const toolsIndex = files.get('src/tools/index.ts') || ''

      expect(toolsIndex).toContain("name: 'tool1'")
      expect(toolsIndex).toContain("name: 'tool2'")
      expect(toolsIndex).toContain("name: 'tool3'")
    })
  })
})
