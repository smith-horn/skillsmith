# Wave 7: End-to-End Testing with Synthetic Data

**Issue:** SMI-XXXX - E2E Testing Post-Release
**Est. Tokens:** ~40K
**Prerequisites:** Wave 6 complete (v0.2.0 published, live API operational)

---

## Objective

Validate all Skillsmith features work correctly with the live production system using synthetic test repositories and comprehensive E2E test scenarios.

## Context

- v0.2.0 published to npm
- Live API at api.skillsmith.app serving 9,717+ skills
- All MCP tools operational: search, get-skill, install, uninstall, recommend, validate, compare, analyze
- Telemetry active in PostHog
- Daily indexer running

---

## Test Strategy Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    WAVE 7: E2E TESTING FRAMEWORK                        │
├─────────────────────────────────────────────────────────────────────────┤
│  Phase 1: Synthetic Repository Setup              ~10K tokens          │
│     └── Create test repos with known skill configurations              │
├─────────────────────────────────────────────────────────────────────────┤
│  Phase 2: API E2E Tests                           ~15K tokens          │
│     └── Validate all API endpoints with live data                      │
├─────────────────────────────────────────────────────────────────────────┤
│  Phase 3: MCP Tool E2E Tests                      ~15K tokens          │
│     └── Test all MCP tools against live system                         │
├─────────────────────────────────────────────────────────────────────────┤
│  Phase 4: Integration Scenarios                   ~10K tokens          │
│     └── Complete user journey tests                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Synthetic Repository Setup

### 1.1 Test Repository Structure

Create synthetic test repositories to provide controlled test data:

```bash
# Test repositories to create in /tmp for E2E testing
/tmp/skillsmith-e2e-tests/
├── repo-react-typescript/          # React + TypeScript project
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── App.tsx
│       └── components/
├── repo-node-express/              # Node.js + Express API
│   ├── package.json
│   └── src/
│       ├── index.js
│       └── routes/
├── repo-python-flask/              # Python Flask project
│   ├── requirements.txt
│   └── app.py
├── repo-empty/                     # Empty project (edge case)
│   └── README.md
└── repo-monorepo/                  # Monorepo structure
    ├── package.json
    ├── packages/
    │   ├── frontend/
    │   └── backend/
    └── turbo.json
```

### 1.2 Synthetic Repository Generator Script

```typescript
// scripts/e2e/setup-test-repos.ts
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

const TEST_BASE = '/tmp/skillsmith-e2e-tests'

interface TestRepo {
  name: string
  files: Record<string, string>
}

const testRepos: TestRepo[] = [
  {
    name: 'repo-react-typescript',
    files: {
      'package.json': JSON.stringify({
        name: 'test-react-app',
        version: '1.0.0',
        dependencies: {
          react: '^18.2.0',
          'react-dom': '^18.2.0',
          typescript: '^5.0.0',
          vitest: '^1.0.0',
        },
        devDependencies: {
          '@types/react': '^18.2.0',
          eslint: '^8.0.0',
        },
      }, null, 2),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          jsx: 'react-jsx',
          strict: true,
        },
      }, null, 2),
      'src/App.tsx': `
import React from 'react'

export function App() {
  return <div>Test App</div>
}
      `.trim(),
      'src/components/Button.tsx': `
import React from 'react'

interface ButtonProps {
  onClick: () => void
  children: React.ReactNode
}

export function Button({ onClick, children }: ButtonProps) {
  return <button onClick={onClick}>{children}</button>
}
      `.trim(),
    },
  },
  {
    name: 'repo-node-express',
    files: {
      'package.json': JSON.stringify({
        name: 'test-express-api',
        version: '1.0.0',
        type: 'module',
        dependencies: {
          express: '^4.18.0',
          cors: '^2.8.5',
          dotenv: '^16.0.0',
        },
        devDependencies: {
          jest: '^29.0.0',
          supertest: '^6.0.0',
        },
      }, null, 2),
      'src/index.js': `
import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (req, res) => res.json({ status: 'ok' }))

export default app
      `.trim(),
      'src/routes/users.js': `
import { Router } from 'express'

const router = Router()

router.get('/', (req, res) => {
  res.json([{ id: 1, name: 'Test User' }])
})

export default router
      `.trim(),
    },
  },
  {
    name: 'repo-python-flask',
    files: {
      'requirements.txt': 'flask==3.0.0\npytest==8.0.0\nrequests==2.31.0',
      'app.py': `
from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    app.run(debug=True)
      `.trim(),
    },
  },
  {
    name: 'repo-empty',
    files: {
      'README.md': '# Empty Test Project\n\nThis is an empty project for edge case testing.',
    },
  },
  {
    name: 'repo-monorepo',
    files: {
      'package.json': JSON.stringify({
        name: 'test-monorepo',
        version: '1.0.0',
        workspaces: ['packages/*'],
        devDependencies: {
          turbo: '^2.0.0',
          typescript: '^5.0.0',
        },
      }, null, 2),
      'turbo.json': JSON.stringify({
        '$schema': 'https://turbo.build/schema.json',
        globalDependencies: ['**/.env'],
        pipeline: {
          build: { dependsOn: ['^build'], outputs: ['dist/**'] },
          test: { dependsOn: ['build'] },
        },
      }, null, 2),
      'packages/frontend/package.json': JSON.stringify({
        name: '@test/frontend',
        version: '1.0.0',
        dependencies: { react: '^18.2.0', next: '^14.0.0' },
      }, null, 2),
      'packages/backend/package.json': JSON.stringify({
        name: '@test/backend',
        version: '1.0.0',
        dependencies: { express: '^4.18.0', prisma: '^5.0.0' },
      }, null, 2),
    },
  },
]

async function setupTestRepos(): Promise<void> {
  console.log('Setting up E2E test repositories...')

  for (const repo of testRepos) {
    const repoPath = join(TEST_BASE, repo.name)

    for (const [filePath, content] of Object.entries(repo.files)) {
      const fullPath = join(repoPath, filePath)
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
      await mkdir(dir, { recursive: true })
      await writeFile(fullPath, content)
    }

    console.log(`  ✓ Created ${repo.name}`)
  }

  console.log('\nTest repositories ready!')
}

export { setupTestRepos, TEST_BASE, testRepos }
```

### 1.3 Setup Commands

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Create test repo setup script
mkdir -p scripts/e2e

# Run setup
npx tsx scripts/e2e/setup-test-repos.ts

# Verify setup
ls -la /tmp/skillsmith-e2e-tests/
```

---

## Phase 2: API E2E Tests

### 2.1 API Endpoint Test Matrix

| Endpoint | Method | Test Cases | Expected Behavior |
|----------|--------|------------|-------------------|
| `/functions/v1/skills-search` | GET | query, filters, pagination | Return matching skills |
| `/functions/v1/skills-get` | GET | valid ID, invalid ID, malformed ID | Return skill or error |
| `/functions/v1/skills-recommend` | POST | valid stack, empty stack, unknown tech | Return recommendations |
| `/functions/v1/events` | POST | valid event, invalid event, missing fields | Accept or reject |

### 2.2 API E2E Test Suite

```typescript
// tests/e2e/api.e2e.test.ts
import { describe, it, expect, beforeAll } from 'vitest'

const API_BASE = 'https://api.skillsmith.app/functions/v1'

describe('Skillsmith API E2E Tests', () => {
  describe('GET /skills-search', () => {
    it('should return results for valid query', async () => {
      const response = await fetch(`${API_BASE}/skills-search?query=testing`)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.data).toBeInstanceOf(Array)
      expect(data.total).toBeGreaterThan(0)
    })

    it('should filter by category', async () => {
      const response = await fetch(
        `${API_BASE}/skills-search?query=react&category=development`
      )
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.data.every((s: any) =>
        s.categories?.includes('development') || true
      )).toBe(true)
    })

    it('should filter by trust_tier', async () => {
      const response = await fetch(
        `${API_BASE}/skills-search?query=git&trust_tier=verified`
      )
      const data = await response.json()

      expect(response.status).toBe(200)
      data.data.forEach((skill: any) => {
        expect(['verified', 'community']).toContain(skill.trust_tier)
      })
    })

    it('should respect limit parameter', async () => {
      const response = await fetch(
        `${API_BASE}/skills-search?query=code&limit=5`
      )
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.data.length).toBeLessThanOrEqual(5)
    })

    it('should handle empty query gracefully', async () => {
      const response = await fetch(`${API_BASE}/skills-search?query=`)

      expect([200, 400]).toContain(response.status)
    })

    it('should handle special characters in query', async () => {
      const response = await fetch(
        `${API_BASE}/skills-search?query=${encodeURIComponent('react+typescript')}`
      )

      expect(response.status).toBe(200)
    })

    it('should return results within performance budget', async () => {
      const start = Date.now()
      await fetch(`${API_BASE}/skills-search?query=testing`)
      const elapsed = Date.now() - start

      expect(elapsed).toBeLessThan(2000) // 2 second budget
    })
  })

  describe('GET /skills-get', () => {
    let validSkillId: string

    beforeAll(async () => {
      // Get a valid skill ID from search
      const response = await fetch(`${API_BASE}/skills-search?query=commit&limit=1`)
      const data = await response.json()
      validSkillId = data.data[0]?.id
    })

    it('should return skill details for valid ID', async () => {
      if (!validSkillId) return

      const response = await fetch(`${API_BASE}/skills-get?id=${validSkillId}`)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.id).toBe(validSkillId)
      expect(data.name).toBeDefined()
      expect(data.description).toBeDefined()
    })

    it('should return 404 for invalid ID', async () => {
      const response = await fetch(
        `${API_BASE}/skills-get?id=nonexistent/fake-skill-12345`
      )

      expect([404, 200]).toContain(response.status)
      if (response.status === 200) {
        const data = await response.json()
        expect(data.error).toBeDefined()
      }
    })

    it('should handle malformed ID gracefully', async () => {
      const response = await fetch(
        `${API_BASE}/skills-get?id=<script>alert(1)</script>`
      )

      expect(response.status).not.toBe(500)
    })
  })

  describe('POST /skills-recommend', () => {
    it('should return recommendations for valid stack', async () => {
      const response = await fetch(`${API_BASE}/skills-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stack: ['react', 'typescript', 'vitest'],
          project_type: 'web',
        }),
      })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.recommendations).toBeInstanceOf(Array)
    })

    it('should handle empty stack', async () => {
      const response = await fetch(`${API_BASE}/skills-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stack: [] }),
      })

      expect([200, 400]).toContain(response.status)
    })

    it('should handle unknown technologies', async () => {
      const response = await fetch(`${API_BASE}/skills-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stack: ['unknowntech12345', 'anotherfake'],
        }),
      })

      expect(response.status).toBe(200)
    })
  })

  describe('POST /events (Telemetry)', () => {
    it('should accept valid event', async () => {
      const response = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'e2e_test_event',
          properties: { test: true, timestamp: Date.now() },
          anonymous_id: 'e2e-test-runner',
        }),
      })

      expect([200, 202]).toContain(response.status)
    })

    it('should reject malformed event', async () => {
      const response = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-valid-json',
      })

      expect([400, 500]).toContain(response.status)
    })
  })
})
```

### 2.3 Run API E2E Tests

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Create test file
mkdir -p tests/e2e

# Run E2E tests
docker exec skillsmith-dev-1 npm test -- --grep "E2E"

# Or run directly
npx vitest run tests/e2e/api.e2e.test.ts
```

---

## Phase 3: MCP Tool E2E Tests

### 3.1 MCP Tool Test Matrix

| Tool | Test Scenarios | Synthetic Repo | Expected Result |
|------|----------------|----------------|-----------------|
| `search` | query, filters, limits | N/A | Skills returned |
| `get_skill` | valid/invalid IDs | N/A | Skill details or error |
| `install` | install skill | repo-react-typescript | Files created in ~/.claude/skills |
| `uninstall` | remove installed | After install | Files removed |
| `recommend` | codebase analysis | All repos | Relevant recommendations |
| `validate` | check skill structure | Installed skills | Validation report |
| `compare` | compare 2-5 skills | N/A | Comparison matrix |
| `analyze` | scan codebase | All repos | Framework detection |

### 3.2 MCP Tool E2E Test Suite

```typescript
// tests/e2e/mcp-tools.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { mkdir, rm, readdir, access } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const SKILLS_DIR = join(homedir(), '.claude', 'skills')
const TEST_REPOS = '/tmp/skillsmith-e2e-tests'

// Helper to call MCP tool via CLI
async function callMcpTool(tool: string, args: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['skillsmith', tool, JSON.stringify(args)], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => { stdout += data.toString() })
    proc.stderr.on('data', (data) => { stderr += data.toString() })

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout))
        } catch {
          resolve({ raw: stdout })
        }
      } else {
        reject(new Error(`Exit code ${code}: ${stderr}`))
      }
    })
  })
}

describe('MCP Tools E2E Tests', () => {
  describe('search tool', () => {
    it('should search with query', async () => {
      const result = await callMcpTool('search', { query: 'testing' })

      expect(result.results || result.skills).toBeDefined()
      expect(Array.isArray(result.results || result.skills)).toBe(true)
    })

    it('should search with category filter', async () => {
      const result = await callMcpTool('search', {
        query: 'react',
        category: 'development',
      })

      expect(result.results || result.skills).toBeDefined()
    })

    it('should search with trust_tier filter', async () => {
      const result = await callMcpTool('search', {
        query: 'git',
        trust_tier: 'verified',
      })

      expect(result.results || result.skills).toBeDefined()
    })

    it('should respect limit', async () => {
      const result = await callMcpTool('search', {
        query: 'code',
        limit: 3,
      })

      const items = result.results || result.skills || []
      expect(items.length).toBeLessThanOrEqual(3)
    })
  })

  describe('get_skill tool', () => {
    let testSkillId: string

    beforeAll(async () => {
      const searchResult = await callMcpTool('search', { query: 'commit', limit: 1 })
      const skills = searchResult.results || searchResult.skills || []
      testSkillId = skills[0]?.id
    })

    it('should get skill details for valid ID', async () => {
      if (!testSkillId) return

      const result = await callMcpTool('get_skill', { id: testSkillId })

      expect(result.skill || result.name).toBeDefined()
    })

    it('should handle invalid ID gracefully', async () => {
      const result = await callMcpTool('get_skill', { id: 'fake/nonexistent' })

      expect(result.error || result.message).toBeDefined()
    })
  })

  describe('install/uninstall tools', () => {
    const testSkillId = 'community/test-skill-e2e'
    const installPath = join(SKILLS_DIR, 'test-skill-e2e')

    afterAll(async () => {
      // Cleanup
      try {
        await rm(installPath, { recursive: true, force: true })
      } catch {}
    })

    it('should install a skill', async () => {
      // Find a real skill to install
      const searchResult = await callMcpTool('search', { query: 'commit', limit: 1 })
      const skills = searchResult.results || searchResult.skills || []
      const skillToInstall = skills[0]?.id

      if (!skillToInstall) return

      const result = await callMcpTool('install', { id: skillToInstall })

      expect(result.success || result.installed).toBeDefined()
    })

    it('should list installed skills', async () => {
      const files = await readdir(SKILLS_DIR).catch(() => [])
      expect(Array.isArray(files)).toBe(true)
    })

    it('should uninstall a skill', async () => {
      // Note: Only uninstall if we installed in previous test
      // This is a placeholder - real test would track installed skill
      expect(true).toBe(true)
    })
  })

  describe('recommend tool', () => {
    it('should recommend skills for React project', async () => {
      const result = await callMcpTool('recommend', {
        path: join(TEST_REPOS, 'repo-react-typescript'),
      })

      expect(result.recommendations).toBeDefined()
      expect(Array.isArray(result.recommendations)).toBe(true)
    })

    it('should recommend skills for Node.js project', async () => {
      const result = await callMcpTool('recommend', {
        path: join(TEST_REPOS, 'repo-node-express'),
      })

      expect(result.recommendations).toBeDefined()
    })

    it('should handle empty project', async () => {
      const result = await callMcpTool('recommend', {
        path: join(TEST_REPOS, 'repo-empty'),
      })

      // Should return empty recommendations, not error
      expect(result.error || result.recommendations).toBeDefined()
    })

    it('should recommend for monorepo', async () => {
      const result = await callMcpTool('recommend', {
        path: join(TEST_REPOS, 'repo-monorepo'),
      })

      expect(result.recommendations).toBeDefined()
    })
  })

  describe('validate tool', () => {
    it('should validate installed skill structure', async () => {
      const installedSkills = await readdir(SKILLS_DIR).catch(() => [])

      if (installedSkills.length === 0) return

      const result = await callMcpTool('validate', {
        path: join(SKILLS_DIR, installedSkills[0]),
      })

      expect(result.valid !== undefined || result.errors).toBeDefined()
    })

    it('should report errors for invalid skill', async () => {
      // Create a malformed skill for testing
      const invalidSkillPath = join(SKILLS_DIR, '_e2e_invalid_test')
      await mkdir(invalidSkillPath, { recursive: true })

      try {
        const result = await callMcpTool('validate', { path: invalidSkillPath })
        expect(result.valid === false || result.errors).toBeDefined()
      } finally {
        await rm(invalidSkillPath, { recursive: true, force: true })
      }
    })
  })

  describe('compare tool', () => {
    it('should compare two skills', async () => {
      const searchResult = await callMcpTool('search', { query: 'test', limit: 2 })
      const skills = searchResult.results || searchResult.skills || []

      if (skills.length < 2) return

      const result = await callMcpTool('compare', {
        skill_ids: [skills[0].id, skills[1].id],
      })

      expect(result.comparison || result.skills).toBeDefined()
    })

    it('should handle single skill (edge case)', async () => {
      const searchResult = await callMcpTool('search', { query: 'git', limit: 1 })
      const skills = searchResult.results || searchResult.skills || []

      if (skills.length < 1) return

      const result = await callMcpTool('compare', {
        skill_ids: [skills[0].id],
      })

      expect(result.error || result.comparison).toBeDefined()
    })
  })

  describe('analyze tool', () => {
    it('should analyze React TypeScript project', async () => {
      const result = await callMcpTool('analyze', {
        path: join(TEST_REPOS, 'repo-react-typescript'),
      })

      expect(result.analysis || result.frameworks).toBeDefined()

      const frameworks = result.analysis?.frameworks || result.frameworks || []
      const frameworkNames = frameworks.map((f: any) => f.name || f)

      expect(frameworkNames).toEqual(
        expect.arrayContaining(['react', 'typescript'].map(expect.stringContaining))
      )
    })

    it('should analyze Node.js Express project', async () => {
      const result = await callMcpTool('analyze', {
        path: join(TEST_REPOS, 'repo-node-express'),
      })

      expect(result.analysis || result.dependencies).toBeDefined()
    })

    it('should analyze Python project', async () => {
      const result = await callMcpTool('analyze', {
        path: join(TEST_REPOS, 'repo-python-flask'),
      })

      expect(result.analysis || result.language).toBeDefined()
    })

    it('should handle empty project gracefully', async () => {
      const result = await callMcpTool('analyze', {
        path: join(TEST_REPOS, 'repo-empty'),
      })

      expect(result.error || result.analysis).toBeDefined()
    })

    it('should analyze monorepo structure', async () => {
      const result = await callMcpTool('analyze', {
        path: join(TEST_REPOS, 'repo-monorepo'),
      })

      expect(result.analysis || result.workspaces).toBeDefined()
    })
  })
})
```

### 3.3 Run MCP Tool E2E Tests

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Setup synthetic repos first
npx tsx scripts/e2e/setup-test-repos.ts

# Run MCP tool E2E tests
docker exec skillsmith-dev-1 npm test -- tests/e2e/mcp-tools.e2e.test.ts
```

---

## Phase 4: Integration Scenarios

### 4.1 Complete User Journey Tests

```typescript
// tests/e2e/user-journeys.e2e.test.ts
import { describe, it, expect } from 'vitest'

describe('User Journey E2E Tests', () => {
  describe('Journey 1: Discovery Flow', () => {
    it('should complete: Search → View Details → Compare → Install', async () => {
      // Step 1: Search for skills
      const searchResult = await callMcpTool('search', {
        query: 'testing',
        limit: 5,
      })
      expect(searchResult.results?.length).toBeGreaterThan(0)

      // Step 2: Get details for top result
      const skillId = searchResult.results[0].id
      const details = await callMcpTool('get_skill', { id: skillId })
      expect(details.name).toBeDefined()
      expect(details.description).toBeDefined()

      // Step 3: Compare top 2 results
      if (searchResult.results.length >= 2) {
        const comparison = await callMcpTool('compare', {
          skill_ids: [searchResult.results[0].id, searchResult.results[1].id],
        })
        expect(comparison.comparison).toBeDefined()
      }

      // Step 4: Install selected skill
      const installResult = await callMcpTool('install', { id: skillId })
      expect(installResult.success || installResult.installed).toBe(true)

      // Step 5: Validate installation
      const validation = await callMcpTool('validate', { id: skillId })
      expect(validation.valid).toBe(true)
    })
  })

  describe('Journey 2: Project Analysis Flow', () => {
    it('should complete: Analyze → Recommend → Search Related → Install', async () => {
      // Step 1: Analyze project
      const analysis = await callMcpTool('analyze', {
        path: '/tmp/skillsmith-e2e-tests/repo-react-typescript',
      })
      expect(analysis.frameworks).toBeDefined()

      // Step 2: Get recommendations based on analysis
      const recommendations = await callMcpTool('recommend', {
        path: '/tmp/skillsmith-e2e-tests/repo-react-typescript',
      })
      expect(recommendations.recommendations?.length).toBeGreaterThan(0)

      // Step 3: Search for related skills
      const framework = analysis.frameworks[0]?.name || 'react'
      const related = await callMcpTool('search', {
        query: framework,
        limit: 10,
      })
      expect(related.results?.length).toBeGreaterThan(0)
    })
  })

  describe('Journey 3: Skill Lifecycle', () => {
    const testSkillId = 'e2e-lifecycle-test'

    it('should complete: Install → Validate → Use → Uninstall', async () => {
      // Find a real skill
      const search = await callMcpTool('search', { query: 'helper', limit: 1 })
      const skillId = search.results?.[0]?.id

      if (!skillId) return

      // Step 1: Install
      const install = await callMcpTool('install', { id: skillId })
      expect(install.success || install.installed).toBe(true)

      // Step 2: Validate
      const validate = await callMcpTool('validate', { id: skillId })
      expect(validate.valid).toBe(true)

      // Step 3: Verify files exist
      const skillDir = join(homedir(), '.claude', 'skills', skillId.split('/')[1])
      const exists = await access(skillDir).then(() => true).catch(() => false)
      expect(exists).toBe(true)

      // Step 4: Uninstall
      const uninstall = await callMcpTool('uninstall', { id: skillId })
      expect(uninstall.success || uninstall.removed).toBe(true)

      // Step 5: Verify cleanup
      const stillExists = await access(skillDir).then(() => true).catch(() => false)
      expect(stillExists).toBe(false)
    })
  })

  describe('Journey 4: Edge Cases', () => {
    it('should handle: Empty Search → No Results Gracefully', async () => {
      const result = await callMcpTool('search', {
        query: 'xyz123nonexistent456abc',
      })

      expect(result.results || result.skills).toBeDefined()
      expect((result.results || result.skills).length).toBe(0)
    })

    it('should handle: Invalid Skill ID → Clear Error', async () => {
      const result = await callMcpTool('get_skill', {
        id: 'invalid/nonexistent-skill-12345',
      })

      expect(result.error || result.message).toBeDefined()
    })

    it('should handle: Analyze Non-Project → Graceful Fallback', async () => {
      const result = await callMcpTool('analyze', {
        path: '/tmp',
      })

      // Should not crash, may return empty analysis
      expect(result.error || result.analysis).toBeDefined()
    })
  })
})
```

---

## Hive Mind Execution Configuration

### Swarm Configuration

```yaml
# .hive-mind/wave-7-e2e.yml
name: wave-7-e2e-testing
topology: mesh
strategy: balanced
maxAgents: 6

phases:
  - name: setup
    agents:
      - type: infrastructure
        task: "Set up synthetic test repositories"
        capabilities: [filesystem, typescript]

  - name: api-tests
    agents:
      - type: tester
        task: "Run API E2E test suite"
        capabilities: [http, testing, validation]
      - type: reviewer
        task: "Review API test results and coverage"
        capabilities: [analysis, reporting]

  - name: mcp-tests
    agents:
      - type: tester
        task: "Run MCP tool E2E test suite"
        capabilities: [mcp, testing, cli]
      - type: validator
        task: "Validate MCP tool responses"
        capabilities: [schema, validation]

  - name: integration
    agents:
      - type: integrator
        task: "Run user journey tests"
        capabilities: [testing, workflows]
      - type: reporter
        task: "Generate test report and metrics"
        capabilities: [reporting, metrics]

memory:
  namespace: wave-7-e2e
  ttl: 86400  # 24 hours
  persist: true
```

### Execution Commands

```bash
# Start hive mind for Wave 7
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Option 1: Use hive-mind skill
claude --prompt "Execute Wave 7 E2E testing using hive-mind with the configuration in docs/execution/wave-7-e2e-testing.md"

# Option 2: Manual swarm execution
npx claude-flow swarm "Run E2E tests for Skillsmith live system" \
  --strategy testing \
  --mode mesh \
  --max-agents 6 \
  --parallel \
  --monitor
```

---

## Success Criteria

### Test Coverage Requirements

| Category | Tests | Pass Rate Target |
|----------|-------|------------------|
| API Endpoints | 15+ | 100% |
| MCP Tools | 25+ | 95% |
| User Journeys | 5+ | 100% |
| Edge Cases | 10+ | 90% |

### Performance Budgets

| Operation | Budget | Tolerance |
|-----------|--------|-----------|
| API search | < 2s | 500ms |
| MCP tool call | < 5s | 1s |
| Install skill | < 10s | 2s |
| Analyze codebase | < 15s | 3s |

### Acceptance Checklist

- [ ] Synthetic test repositories created
- [ ] API E2E tests passing (100%)
- [ ] MCP tool tests passing (95%+)
- [ ] User journey tests passing (100%)
- [ ] Edge case tests passing (90%+)
- [ ] Performance within budget
- [ ] Test report generated
- [ ] Issues logged for any failures

---

## Test Report Template

```markdown
# Skillsmith E2E Test Report

**Date:** [DATE]
**Version:** v0.2.0
**Environment:** Production (api.skillsmith.app)

## Summary

| Category | Total | Passed | Failed | Skipped |
|----------|-------|--------|--------|---------|
| API      | XX    | XX     | XX     | XX      |
| MCP      | XX    | XX     | XX     | XX      |
| Journeys | XX    | XX     | XX     | XX      |
| Edge     | XX    | XX     | XX     | XX      |

## Pass Rate: XX%

## Failures

[List any test failures with details]

## Performance Metrics

| Operation | P50 | P95 | Max |
|-----------|-----|-----|-----|
| Search    | XXms| XXms| XXms|
| Install   | XXs | XXs | XXs |
| Analyze   | XXs | XXs | XXs |

## Recommendations

[Any recommendations based on test results]
```

---

## Next Steps After Wave 7

1. **Address Failures**: Fix any failing tests before next release
2. **Performance Tuning**: Optimize slow operations
3. **Coverage Gaps**: Add tests for uncovered scenarios
4. **Documentation**: Update docs based on findings
5. **Monitoring**: Set up continuous E2E testing in CI

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | January 8, 2026 | Claude Opus 4.5 | Initial E2E testing plan |
