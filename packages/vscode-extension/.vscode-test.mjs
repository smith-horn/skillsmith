import { defineConfig } from '@vscode/test-electron'

export default defineConfig({
  files: 'src/__tests__/integration/**/*.int.test.ts',
  version: 'stable',
  workspaceFolder: './',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
})
