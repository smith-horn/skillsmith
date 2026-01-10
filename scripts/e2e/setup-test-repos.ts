#!/usr/bin/env npx tsx
/**
 * Synthetic Test Repository Setup
 *
 * Creates test repositories for E2E testing of Skillsmith features.
 * These repos simulate various project types to test:
 * - Framework detection (React, Express, Flask)
 * - Dependency analysis
 * - Recommendation accuracy
 * - Edge cases (empty projects, monorepos)
 */

import { mkdir, writeFile, rm } from 'fs/promises'
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
      'package.json': JSON.stringify(
        {
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
        },
        null,
        2
      ),
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            jsx: 'react-jsx',
            strict: true,
          },
        },
        null,
        2
      ),
      'src/App.tsx': `import React from 'react'

export function App() {
  return <div>Test App</div>
}`,
      'src/components/Button.tsx': `import React from 'react'

interface ButtonProps {
  onClick: () => void
  children: React.ReactNode
}

export function Button({ onClick, children }: ButtonProps) {
  return <button onClick={onClick}>{children}</button>
}`,
    },
  },
  {
    name: 'repo-node-express',
    files: {
      'package.json': JSON.stringify(
        {
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
        },
        null,
        2
      ),
      'src/index.js': `import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (req, res) => res.json({ status: 'ok' }))

export default app`,
      'src/routes/users.js': `import { Router } from 'express'

const router = Router()

router.get('/', (req, res) => {
  res.json([{ id: 1, name: 'Test User' }])
})

export default router`,
    },
  },
  {
    name: 'repo-python-flask',
    files: {
      'requirements.txt': 'flask==3.0.0\npytest==8.0.0\nrequests==2.31.0',
      'app.py': `from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    app.run(debug=True)`,
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
      'package.json': JSON.stringify(
        {
          name: 'test-monorepo',
          version: '1.0.0',
          workspaces: ['packages/*'],
          devDependencies: {
            turbo: '^2.0.0',
            typescript: '^5.0.0',
          },
        },
        null,
        2
      ),
      'turbo.json': JSON.stringify(
        {
          $schema: 'https://turbo.build/schema.json',
          globalDependencies: ['**/.env'],
          pipeline: {
            build: { dependsOn: ['^build'], outputs: ['dist/**'] },
            test: { dependsOn: ['build'] },
          },
        },
        null,
        2
      ),
      'packages/frontend/package.json': JSON.stringify(
        {
          name: '@test/frontend',
          version: '1.0.0',
          dependencies: { react: '^18.2.0', next: '^14.0.0' },
        },
        null,
        2
      ),
      'packages/backend/package.json': JSON.stringify(
        {
          name: '@test/backend',
          version: '1.0.0',
          dependencies: { express: '^4.18.0', prisma: '^5.0.0' },
        },
        null,
        2
      ),
    },
  },
  {
    name: 'repo-vue-vite',
    files: {
      'package.json': JSON.stringify(
        {
          name: 'test-vue-app',
          version: '1.0.0',
          dependencies: {
            vue: '^3.4.0',
            pinia: '^2.1.0',
            'vue-router': '^4.2.0',
          },
          devDependencies: {
            vite: '^5.0.0',
            '@vitejs/plugin-vue': '^4.5.0',
          },
        },
        null,
        2
      ),
      'vite.config.ts': `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
})`,
      'src/App.vue': `<template>
  <div>Test Vue App</div>
</template>

<script setup lang="ts">
// Vue 3 Composition API
</script>`,
    },
  },
]

async function setupTestRepos(): Promise<void> {
  console.log('Setting up E2E test repositories...')
  console.log(`Base directory: ${TEST_BASE}\n`)

  // Clean up existing
  try {
    await rm(TEST_BASE, { recursive: true, force: true })
    console.log('Cleaned up existing test repos')
  } catch {
    // Directory didn't exist
  }

  await mkdir(TEST_BASE, { recursive: true })

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

  console.log(`\n✅ Test repositories ready at ${TEST_BASE}`)
  console.log(`   Total: ${testRepos.length} repositories`)
}

async function cleanup(): Promise<void> {
  console.log('Cleaning up E2E test repositories...')
  await rm(TEST_BASE, { recursive: true, force: true })
  console.log('✅ Cleanup complete')
}

// CLI
const command = process.argv[2]

if (command === 'cleanup') {
  cleanup().catch(console.error)
} else {
  setupTestRepos().catch(console.error)
}

export { setupTestRepos, cleanup, TEST_BASE, testRepos }
