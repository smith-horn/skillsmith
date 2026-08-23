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

  /* SMI-6119: relocate Playwright's own output outside packages/website/ so
   * neither this directory nor its per-worker `.playwright-artifacts-N/`
   * scratch subdirectory (created/torn down at every project boundary --
   * see WorkerHost in node_modules/playwright/lib/runner/index.js) ever
   * falls inside the tree the watcher in the `vercel dev` process tree
   * covers. That watcher's routine scandir of the default in-tree outputDir
   * (`packages/website/test-results/`) could race the worker-teardown
   * `removeFolders()` call at the desktop -> mobile project transition,
   * crash `astro dev` with `ENOENT: no such file or directory, scandir
   * '.../test-results/.playwright-artifacts-0/traces'`, and fail every
   * subsequent test with `page.goto: Could not connect ... Connection
   * refused` -- see SMI-6119 for the full CI-run evidence trail. Resolved
   * relative to this file's directory (Playwright's own
   * `path.resolve(configDir, outputDir)` rule), so this lands at
   * `<repo-root>/test-results/playwright/` -- a sibling of the
   * `test-results/preview.log` / `test-results/*.log` convention every
   * vercel-dev-based e2e workflow already uses, already covered by root
   * .gitignore, and already devcontainer-bind-mounted. */
  outputDir: '../../test-results/playwright',

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
  /* HTML report folder relocated alongside outputDir above (SMI-6119) --
   * both resolve relative to this config file's directory, land as
   * siblings under <repo-root>/test-results/, and are never nested inside
   * each other (Playwright's html reporter warns -- prints a Configuration
   * Error and continues, does not fail the run -- if it detects that
   * shape; see the `_isSubdirectory` check in
   * node_modules/playwright/lib/runner/index.js). Note: two of the four
   * CI workflows sharing this config pass --reporter=list on their
   * `playwright test` invocation, which overrides this array entirely --
   * this outputFolder only takes effect for invocations that don't. */
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../test-results/playwright-report' }],
  ],

  /* Shared settings for all projects */
  use: {
    /* SMI-5481: CI boots `vercel dev --listen 127.0.0.1:4321`; on GH runners
     * `localhost` can resolve to ::1 and browsers hang against an IPv4-only
     * server (SMI-4493/4496). CI sets PLAYWRIGHT_BASE_URL; local default is
     * unchanged (`||` so an empty string also falls back). */
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:4321',
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

  /* Start the preview server automatically when no server is already
   * listening on the port. Every CI workflow that runs these specs
   * (website-account-e2e.yml, website-skills-e2e.yml,
   * cross-harness-inventory-e2e.yml, device-login-roundtrip.yml) instead
   * starts `vercel dev` itself before invoking playwright (SMI-4508;
   * device-login-roundtrip.yml switched to this from an earlier
   * http-server/dist/client approach documented at SMI-4494 -- this
   * comment previously described that superseded approach).
   * `reuseExistingServer: true` lets Playwright detect the externally-
   * started server and skip its own webServer command entirely. */
  webServer: {
    command: 'npm run preview',
    port: 4321,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
