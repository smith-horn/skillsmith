import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for visual regression testing.
 *
 * Targets the Astro preview server (built site served locally).
 * Run `npm run build && npm run preview` before executing tests,
 * or use the webServer config below to automate it.
 */
export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',

  /* Snapshot settings */
  snapshotPathTemplate: '{testDir}/visual/__snapshots__/{arg}-{projectName}{ext}',

  /* Fail the build on CI if snapshots are missing */
  expect: {
    toHaveScreenshot: {
      /* Allow slight anti-aliasing differences across environments */
      maxDiffPixelRatio: 0.01,
    },
  },

  /* Run tests sequentially to avoid port conflicts */
  fullyParallel: false,
  workers: 1,

  /* Reporter */
  reporter: [['list'], ['html', { open: 'never' }]],

  /* Shared settings for all projects */
  use: {
    baseURL: 'http://localhost:4321',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },

  /* Two viewport configurations: desktop and mobile */
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        viewport: { width: 375, height: 812 },
      },
    },
  ],

  /* Start the Astro preview server automatically.
   * Requires the site to be built first (`npm run build`). */
  webServer: {
    command: 'npm run preview',
    port: 4321,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
