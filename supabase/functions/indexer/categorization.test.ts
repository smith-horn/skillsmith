/**
 * Skill Categorization Tests
 * @module indexer/categorization.test
 *
 * SMI-1682: Tests for categorizeSkill function
 * Covers all category detection logic including the new integrations category.
 */

import { describe, it, expect } from 'vitest'
import { categorizeSkill, CATEGORY_IDS } from './categorization.ts'

describe('categorizeSkill', () => {
  describe('integrations category (SMI-1676)', () => {
    it('should categorize mcp-server skills as integrations', () => {
      const result = categorizeSkill(['mcp-server'])
      expect(result).toContain(CATEGORY_IDS.integrations)
    })

    it('should categorize mcp-client skills as integrations', () => {
      const result = categorizeSkill(['mcp-client'])
      expect(result).toContain(CATEGORY_IDS.integrations)
    })

    it('should categorize skills with mcp tag as integrations', () => {
      const result = categorizeSkill(['mcp', 'typescript'])
      expect(result).toContain(CATEGORY_IDS.integrations)
    })

    it('should categorize model-context-protocol skills as integrations', () => {
      const result = categorizeSkill(['model-context-protocol'])
      expect(result).toContain(CATEGORY_IDS.integrations)
    })

    it('should categorize mcp-tools skills as integrations', () => {
      const result = categorizeSkill(['mcp-tools'])
      expect(result).toContain(CATEGORY_IDS.integrations)
    })

    it('should categorize api-integration skills as integrations', () => {
      const result = categorizeSkill(['api-integration'])
      expect(result).toContain(CATEGORY_IDS.integrations)
    })

    it('should categorize by description containing "mcp server"', () => {
      const result = categorizeSkill([], 'An MCP server for GitHub integration')
      expect(result).toContain(CATEGORY_IDS.integrations)
    })

    it('should categorize by description containing "model context protocol"', () => {
      const result = categorizeSkill([], 'Implements the Model Context Protocol')
      expect(result).toContain(CATEGORY_IDS.integrations)
    })
  })

  describe('development category (SMI-1677 expansion)', () => {
    it('should categorize claude skills as development', () => {
      const result = categorizeSkill(['claude'])
      expect(result).toContain(CATEGORY_IDS.development)
    })

    it('should categorize anthropic skills as development', () => {
      const result = categorizeSkill(['anthropic'])
      expect(result).toContain(CATEGORY_IDS.development)
    })

    it('should categorize llm skills as development', () => {
      const result = categorizeSkill(['llm'])
      expect(result).toContain(CATEGORY_IDS.development)
    })

    it('should categorize ai-agent skills as development', () => {
      const result = categorizeSkill(['ai-agent'])
      expect(result).toContain(CATEGORY_IDS.development)
    })

    it('should categorize agentic-ai skills as development', () => {
      const result = categorizeSkill(['agentic-ai'])
      expect(result).toContain(CATEGORY_IDS.development)
    })

    it('should categorize cursor skills as development', () => {
      const result = categorizeSkill(['cursor'])
      expect(result).toContain(CATEGORY_IDS.development)
    })

    it('should categorize codex skills as development', () => {
      const result = categorizeSkill(['codex'])
      expect(result).toContain(CATEGORY_IDS.development)
    })

    it('should categorize by description containing "claude code"', () => {
      const result = categorizeSkill([], 'A skill for Claude Code development')
      expect(result).toContain(CATEGORY_IDS.development)
    })

    it('should categorize by description containing "large language model"', () => {
      const result = categorizeSkill([], 'Uses a large language model for analysis')
      expect(result).toContain(CATEGORY_IDS.development)
    })

    // Original development keywords still work
    it('should categorize coding skills as development', () => {
      const result = categorizeSkill(['coding'])
      expect(result).toContain(CATEGORY_IDS.development)
    })

    it('should categorize framework skills as development', () => {
      const result = categorizeSkill(['framework'])
      expect(result).toContain(CATEGORY_IDS.development)
    })
  })

  describe('productivity category (SMI-1678 expansion)', () => {
    it('should categorize ai-assistant skills as productivity', () => {
      const result = categorizeSkill(['ai-assistant'])
      expect(result).toContain(CATEGORY_IDS.productivity)
    })

    it('should categorize chatbot skills as productivity', () => {
      const result = categorizeSkill(['chatbot'])
      expect(result).toContain(CATEGORY_IDS.productivity)
    })

    it('should categorize rag skills as productivity', () => {
      const result = categorizeSkill(['rag'])
      expect(result).toContain(CATEGORY_IDS.productivity)
    })

    it('should categorize orchestration skills as productivity', () => {
      const result = categorizeSkill(['orchestration'])
      expect(result).toContain(CATEGORY_IDS.productivity)
    })

    it('should categorize ai-tools skills as productivity', () => {
      const result = categorizeSkill(['ai-tools'])
      expect(result).toContain(CATEGORY_IDS.productivity)
    })

    it('should categorize by description containing "ai assistant"', () => {
      const result = categorizeSkill([], 'An AI assistant for productivity')
      expect(result).toContain(CATEGORY_IDS.productivity)
    })

    // Original productivity keywords still work
    it('should categorize automation skills as productivity', () => {
      const result = categorizeSkill(['automation'])
      expect(result).toContain(CATEGORY_IDS.productivity)
    })

    it('should categorize cli skills as productivity', () => {
      const result = categorizeSkill(['cli'])
      expect(result).toContain(CATEGORY_IDS.productivity)
    })
  })

  describe('security category', () => {
    it('should categorize security skills', () => {
      const result = categorizeSkill(['security'])
      expect(result).toContain(CATEGORY_IDS.security)
    })

    it('should categorize pentesting skills', () => {
      const result = categorizeSkill(['pentesting'])
      expect(result).toContain(CATEGORY_IDS.security)
    })

    it('should categorize ctf skills', () => {
      const result = categorizeSkill(['ctf'])
      expect(result).toContain(CATEGORY_IDS.security)
    })
  })

  describe('testing category', () => {
    it('should categorize testing skills', () => {
      const result = categorizeSkill(['testing'])
      expect(result).toContain(CATEGORY_IDS.testing)
    })

    it('should categorize jest skills', () => {
      const result = categorizeSkill(['jest'])
      expect(result).toContain(CATEGORY_IDS.testing)
    })

    it('should categorize e2e skills', () => {
      const result = categorizeSkill(['e2e'])
      expect(result).toContain(CATEGORY_IDS.testing)
    })

    it('should categorize by description containing "testing"', () => {
      const result = categorizeSkill([], 'A comprehensive testing framework')
      expect(result).toContain(CATEGORY_IDS.testing)
    })

    it('should categorize by description containing "unit test"', () => {
      const result = categorizeSkill([], 'Unit test utilities for React')
      expect(result).toContain(CATEGORY_IDS.testing)
    })
  })

  describe('devops category', () => {
    it('should categorize docker skills', () => {
      const result = categorizeSkill(['docker'])
      expect(result).toContain(CATEGORY_IDS.devops)
    })

    it('should categorize kubernetes skills', () => {
      const result = categorizeSkill(['kubernetes'])
      expect(result).toContain(CATEGORY_IDS.devops)
    })

    it('should categorize github-actions skills', () => {
      const result = categorizeSkill(['github-actions'])
      expect(result).toContain(CATEGORY_IDS.devops)
    })

    it('should categorize by description containing "deployment"', () => {
      const result = categorizeSkill([], 'Automated deployment tool')
      expect(result).toContain(CATEGORY_IDS.devops)
    })

    it('should categorize by description containing "ci/cd"', () => {
      const result = categorizeSkill([], 'CI/CD pipeline automation')
      expect(result).toContain(CATEGORY_IDS.devops)
    })
  })

  describe('documentation category', () => {
    it('should categorize documentation skills', () => {
      const result = categorizeSkill(['documentation'])
      expect(result).toContain(CATEGORY_IDS.documentation)
    })

    it('should categorize markdown skills', () => {
      const result = categorizeSkill(['markdown'])
      expect(result).toContain(CATEGORY_IDS.documentation)
    })
  })

  describe('multi-category assignment', () => {
    it('should assign skill to multiple categories when applicable', () => {
      // A skill with both MCP and security tags
      const result = categorizeSkill(['mcp-server', 'security'])
      expect(result).toContain(CATEGORY_IDS.integrations)
      expect(result).toContain(CATEGORY_IDS.security)
    })

    it('should assign claude mcp-server to both development and integrations', () => {
      const result = categorizeSkill(['claude', 'mcp-server'])
      expect(result).toContain(CATEGORY_IDS.development)
      expect(result).toContain(CATEGORY_IDS.integrations)
    })
  })

  describe('edge cases', () => {
    it('should return empty array for unmatched tags', () => {
      const result = categorizeSkill(['random-tag', 'another-tag'])
      expect(result).toEqual([])
    })

    it('should handle empty tags array', () => {
      const result = categorizeSkill([])
      expect(result).toEqual([])
    })

    it('should handle undefined description', () => {
      const result = categorizeSkill(['mcp-server'], undefined)
      expect(result).toContain(CATEGORY_IDS.integrations)
    })

    it('should handle null description', () => {
      const result = categorizeSkill(['mcp-server'], null)
      expect(result).toContain(CATEGORY_IDS.integrations)
    })

    it('should be case-insensitive for tags', () => {
      const result = categorizeSkill(['MCP-SERVER', 'CLAUDE'])
      expect(result).toContain(CATEGORY_IDS.integrations)
      expect(result).toContain(CATEGORY_IDS.development)
    })

    it('should be case-insensitive for description', () => {
      const result = categorizeSkill([], 'An MCP SERVER for testing')
      expect(result).toContain(CATEGORY_IDS.integrations)
    })
  })
})
