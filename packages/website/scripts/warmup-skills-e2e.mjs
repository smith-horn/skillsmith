// SMI-6433 -- absorbs the Astro dev server's one-time first-load full-reload
// (docs/internal/implementation/smi-6433-vite-optimizedeps-prewarm-and-ci-warmup.md)
// before the real Playwright run starts. Not Vite's dependency optimizer --
// ruled out directly against the installed vite package (see that doc's
// "Root cause, re-verified" section). The reload is EXPECTED on this fresh
// server's first load, but its absence is only a WARNING here, not a hard
// failure -- what actually matters, and is hard-enforced, is that the
// server ends this step in a settled state (round-3 plan-review finding
// #2: gate the required outcome, not the causal model).
import { chromium } from '@playwright/test'

const url = `${process.env.SKILLSMITH_WEBSITE_URL || 'http://127.0.0.1:4321'}/skills`
const RELOAD_FRAME_TIMEOUT_MS = 10000
const RELOAD_NAV_TIMEOUT_MS = 15000
// Round-4 plan-review finding #1: this used to be a much shorter 3s window,
// which was weaker than the first load's own 10s allowance -- a reload
// merely delayed past 3s (but still within what the first load would have
// tolerated) could slip past undetected. Now the same bound applies
// whether or not the first load's reload was observed.
const SECOND_LOAD_QUIET_MS = RELOAD_FRAME_TIMEOUT_MS
// Round-4 plan-review finding #2: rather than making the reader sum five
// separate nested timeouts to know the real worst case, the whole script
// runs under one explicit deadline.
const OVERALL_TIMEOUT_MS = 60000

// Only sets a nonzero exit code and returns -- run()'s own try/finally
// (below) is what actually closes the browser, on every path, exactly
// once. Round-5 plan-review found the previous version's claim that
// run() closed its browser "on every path it controls" was inaccurate
// (an exception from newPage()/waitForLoadState()/the second goto()
// would skip it entirely) -- true cleanup now doesn't depend on that.
function fail(message) {
  console.error(`[warmup] FAIL: ${message}`)
  process.exitCode = 1
}

// Tracks main-frame navigations and reload-frame sightings against a single
// shared, monotonically increasing sequence number, updated synchronously
// inside each event handler. This is deliberate: round-3 plan-review found
// that snapshotting a navigation count AFTER an `await page.goto()` call
// races the very thing it's meant to measure -- the reload can complete
// before that continuation even runs (confirmed possible: the SPARC
// investigation's own probe saw the reload frame arrive during module
// execution, before the initial page's own 'load' event). Recording the
// sequence number AT the moment each event fires, inside the handler
// itself, has no such race regardless of when any `await` resumes.
function makeNavTracker(page) {
  let seq = 0
  let reloadSeenAtSeq = null
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seq += 1
  })
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      if (
        reloadSeenAtSeq === null &&
        typeof payload === 'string' &&
        payload.includes('"full-reload"')
      ) {
        reloadSeenAtSeq = seq
      }
    })
  })
  return {
    currentSeq: () => seq,
    reloadSeenAtSeq: () => reloadSeenAtSeq,
  }
}

async function run() {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const tracker = makeNavTracker(page)

    console.log(
      `[warmup] loading ${url} (first load on a fresh server -- expecting the one-time reload)`
    )
    // A reload firing mid-navigation can make goto() itself reject (the
    // client-side location.reload() interrupts the original navigation) --
    // that's an expected, benign outcome here, not a real failure. The
    // tracker above is what actually decides success or failure below.
    // 15s here is a local-loopback request; if it's actually stalled that
    // long something is already badly wrong and the overall deadline below
    // catches it regardless.
    await page.goto(url, { waitUntil: 'load', timeout: 15000 }).catch(() => {})

    const frameDeadline = Date.now() + RELOAD_FRAME_TIMEOUT_MS
    while (tracker.reloadSeenAtSeq() === null && Date.now() < frameDeadline) {
      await page.waitForTimeout(100)
    }
    const reloadSeenAtSeq = tracker.reloadSeenAtSeq()

    if (reloadSeenAtSeq === null) {
      console.warn(
        `[warmup] WARNING: expected the one-time full-reload frame on this fresh server's first load ` +
          `but none arrived within ${RELOAD_FRAME_TIMEOUT_MS}ms -- this warm-up's causal model may be stale ` +
          `(re-run the SPARC verification in the SMI-6433 plan doc), but proceeding: the second-load check ` +
          `below is what actually gates this step.`
      )
    } else {
      console.log(
        '[warmup] observed the full-reload frame; waiting for the resulting navigation to complete'
      )
      const navDeadline = Date.now() + RELOAD_NAV_TIMEOUT_MS
      while (tracker.currentSeq() <= reloadSeenAtSeq && Date.now() < navDeadline) {
        await page.waitForTimeout(100)
      }
      if (tracker.currentSeq() <= reloadSeenAtSeq) {
        fail(
          `full-reload frame observed but no subsequent navigation completed within ${RELOAD_NAV_TIMEOUT_MS}ms`
        )
        return
      }
      await page.waitForLoadState('load', { timeout: 15000 })
      console.log('[warmup] reload navigation settled')
    }

    // The hard gate: regardless of whether the first load's reload was
    // observed above, a second page load against this same server session
    // must never reload -- for the SAME bound the first load gets, not a
    // shorter one, so a merely-delayed reload can't slip past unnoticed
    // (round-4 plan-review finding #1).
    const page2 = await browser.newPage()
    const tracker2 = makeNavTracker(page2)
    console.log('[warmup] loading a second page to confirm the server stays warm')
    await page2.goto(url, { waitUntil: 'load', timeout: 15000 })
    await page2.waitForTimeout(SECOND_LOAD_QUIET_MS)
    if (tracker2.reloadSeenAtSeq() !== null) {
      fail(
        'a second page load triggered another full-reload -- the server did not stay warm as expected'
      )
      return
    }
    console.log('[warmup] confirmed: second load is clean -- server is warm for the real test run')
  } finally {
    // Unconditional, exactly-once cleanup -- covers every path, including
    // an exception from newPage()/waitForLoadState()/the second goto()
    // that the earlier per-branch fail() calls didn't reach. Round-5
    // plan-review found the previous version's comment overclaimed this
    // without an actual try/finally backing it.
    await browser.close()
  }
}

async function main() {
  // Round-5 plan-review finding #1: an uncleared setTimeout keeps Node's
  // event loop alive until the full budget elapses even after run()
  // finishes -- a successful ~10-12s run would otherwise still take a
  // full 60s wall-clock in CI. clearTimeout() in finally fixes this.
  let timeoutHandle
  let timedOut = false
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      reject(new Error(`warm-up exceeded its overall ${OVERALL_TIMEOUT_MS}ms budget`))
    }, OVERALL_TIMEOUT_MS)
  })
  try {
    await Promise.race([run(), timeout])
  } catch (err) {
    console.error('[warmup] failed:', err)
    if (timedOut) {
      // run() is still executing in the background at this point (JS has
      // no true cancellation) and may not reach its own cleanup for a
      // while -- force an immediate hard stop so the documented 60s
      // budget is a real wall-clock guarantee, not best-effort. This also
      // force-kills any still-running Chromium child process.
      process.exit(1)
    }
    process.exitCode = 1
  } finally {
    clearTimeout(timeoutHandle)
  }
}

main()
