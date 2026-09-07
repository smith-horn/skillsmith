/**
 * Skills Filter E2E Tests
 *
 * SMI-1658: E2E test for filter-only skill browsing
 *
 * Tests that users can browse skills by selecting filters (category, trust tier)
 * without entering a search query. This verifies the ADR-019 filter-only browsing
 * feature works correctly.
 *
 * Prerequisites:
 * - Install Playwright: npm install -D @playwright/test
 * - Install browsers: npx playwright install
 *
 * Run with: npx playwright test packages/website/tests/e2e/skills-filter.spec.ts
 */

import { test, expect, type Page } from '@playwright/test'

const BASE_URL = process.env.SKILLSMITH_WEBSITE_URL || 'https://www.skillsmith.app'

/**
 * Wait for the skills grid to display results (not empty, not loading, not search prompt)
 */
async function waitForResults(page: Page): Promise<void> {
  // Wait for loading to complete
  await expect(page.locator('#loading-state')).toBeHidden({ timeout: 15000 })

  // Ensure we're not showing empty state or search prompt
  await expect(page.locator('#empty-state')).toBeHidden()
  await expect(page.locator('#search-prompt-state')).toBeHidden()

  // SMI-6428: assert the error state too. Without it, a 401/429/timeout from
  // skills-search fails at the #results-grid line with a bare "expected visible,
  // received hidden" — visually identical to the state-stomp failure this ticket
  // fixed, which is exactly what made the CI trace ambiguous.
  await expect(page.locator('#error-state')).toBeHidden()

  // Results grid should be visible with content
  await expect(page.locator('#results-grid')).toBeVisible()
}

/**
 * Verify that results are displayed in the grid
 */
async function verifyResultsDisplayed(page: Page): Promise<number> {
  const resultsGrid = page.locator('#results-grid')
  await expect(resultsGrid).toBeVisible()

  // Count skill cards via their title links. The new card root is a <div class="card-hover">,
  // but each card still renders exactly one <a> (the stretched title link), so the count is valid.
  const skillCards = resultsGrid.locator('a')
  const count = await skillCards.count()

  expect(count).toBeGreaterThan(0)
  return count
}

test.describe('Skills Filter-Only Browsing (SMI-1658)', () => {
  test.beforeEach(async ({ page }) => {
    // SMI-5504 deflake: suppress SignedOutOverlay (SMI-4401/4837) deterministically.
    // Anonymous contexts have no Supabase session, so the overlay's deferred script
    // reveals a full-viewport pointer-blocking backdrop ~250ms+ after astro:page-load,
    // racing every click in this suite (~7% loss in CI). Both historical failures'
    // error-context artifacts (run 28305673909; run 28626331405 attempt 1 -- after a
    // rerun the red evidence survives only in the run's ARTIFACTS, not its logs) name
    // "signed-out-overlay ... intercepts pointer events". Seeding the component's own
    // dismissal key (+24h here; the component's real TTL is 7 days) makes
    // setupOverlay() remove the overlay before it can reveal.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem(
          'skills_overlay_dismissed_until',
          new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        )
      } catch {
        /* localStorage unavailable — overlay suppression falls back to the race */
      }
    })
    // SMI-6428 confirmation review (round 2, finding F-3): the readiness barrier
    // below waits on loadFeaturedSkills()'s terminal write, and that function has
    // no AbortController/timeout of its own -- it issues one real, unmocked
    // fetch per featured-skills.json ID against prod skills-get. A slow or
    // degraded prod response would stall this barrier for up to 30s on every
    // test in this block, including the 2 that DO run in the required CI check
    // -- for a reason unrelated to the code under test. Route it deterministically
    // instead; loadFeaturedSkills() treats a non-ok response as a per-item null
    // and only skips populating the grid if every item comes back that way
    // (index.astro:954-963), so this doesn't need real skill data to resolve fast.
    await page.route('**/skills-get/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":null}' })
    })
    await page.goto(`${BASE_URL}/skills`)
    // Wait for the page to be fully loaded
    await expect(page.locator('#category-filter')).toBeVisible()
    // SMI-6428 readiness barrier: #category-filter is static HTML, visible long
    // before the astro:page-load handler binds its change listener (index.astro
    // ~835) or the initAuth() -> loadFeaturedSkills() chain resolves. #results-count
    // renders as "Loading skills..." (index.astro:274) and is only rewritten to
    // "Showing featured examples" by that chain's terminal write (~917). Waiting
    // for that exact string proves the handler ran to completion, so no interaction
    // below can be stomped by it.
    await expect(page.locator('#results-count')).toHaveText('Showing featured examples', {
      timeout: 30000,
    })
  })

  test.describe('Category Filter Without Search Query', () => {
    test('should display results when selecting "security" category', async ({ page }) => {
      // Verify search input is empty
      const searchInput = page.locator('#search-input')
      await expect(searchInput).toHaveValue('')

      // Select the security category
      const categoryFilter = page.locator('#category-filter')
      await categoryFilter.selectOption('security')

      // Wait for results to load
      await waitForResults(page)

      // Verify results are displayed
      const count = await verifyResultsDisplayed(page)
      console.log(`Security category returned ${count} results`)

      // Verify results count text is updated
      const resultsCount = page.locator('#results-count')
      await expect(resultsCount).not.toContainText('No skills found')
      await expect(resultsCount).not.toContainText('Enter a search term')
    })

    test('should display results when selecting "testing" category', async ({ page }) => {
      // Verify search input is empty
      const searchInput = page.locator('#search-input')
      await expect(searchInput).toHaveValue('')

      // Select the testing category
      const categoryFilter = page.locator('#category-filter')
      await categoryFilter.selectOption('testing')

      // Wait for results to load
      await waitForResults(page)

      // Verify results are displayed
      const count = await verifyResultsDisplayed(page)
      console.log(`Testing category returned ${count} results`)

      // Verify results count text shows skills found
      const resultsCount = page.locator('#results-count')
      await expect(resultsCount).toContainText(/\d+ skills?/)
    })

    test('should display results when selecting "devops" category', async ({ page }) => {
      // Verify search input is empty
      const searchInput = page.locator('#search-input')
      await expect(searchInput).toHaveValue('')

      // Select the devops category
      const categoryFilter = page.locator('#category-filter')
      await categoryFilter.selectOption('devops')

      // Wait for results to load
      await waitForResults(page)

      // Verify results are displayed
      const count = await verifyResultsDisplayed(page)
      console.log(`DevOps category returned ${count} results`)

      // Verify we're showing results, not an error
      await expect(page.locator('#error-state')).toBeHidden()
    })
  })

  test.describe('Trust Tier Filter Without Search Query', () => {
    test('should display results when selecting "verified" trust tier', async ({ page }) => {
      // Select the verified trust tier without entering a search query
      const trustFilter = page.locator('#trust-filter')
      await trustFilter.selectOption('verified')

      // Wait for results to load
      await waitForResults(page)

      // Verify results are displayed
      await verifyResultsDisplayed(page)

      // Verify all displayed skills have "verified" badge
      const verifiedBadges = page.locator('#results-grid').getByText('verified', { exact: true })
      const badgeCount = await verifiedBadges.count()
      expect(badgeCount).toBeGreaterThan(0)
    })

    test('should display results when selecting "community" trust tier', async ({ page }) => {
      // Select the community trust tier without entering a search query
      const trustFilter = page.locator('#trust-filter')
      await trustFilter.selectOption('community')

      // Wait for results to load
      await waitForResults(page)

      // Verify results are displayed
      await verifyResultsDisplayed(page)
    })
  })

  test.describe('Combined Filters Without Search Query', () => {
    test('should display results with both category and trust tier filters', async ({ page }) => {
      // Select both filters without entering a search query
      const categoryFilter = page.locator('#category-filter')
      const trustFilter = page.locator('#trust-filter')

      await categoryFilter.selectOption('development')
      await trustFilter.selectOption('community')

      // Wait for results to load
      await waitForResults(page)

      // Verify results are displayed
      await verifyResultsDisplayed(page)

      // Verify the combination works
      const resultsCount = page.locator('#results-count')
      await expect(resultsCount).not.toContainText('No skills found')
    })
  })

  test.describe('Filter State Transitions', () => {
    test('should show search prompt initially, then results after filter selection', async ({
      page,
    }) => {
      // Initially, search prompt should be visible
      await expect(page.locator('#search-prompt-state')).toBeVisible()
      await expect(page.locator('#results-grid')).toBeHidden()

      // Select a category
      const categoryFilter = page.locator('#category-filter')
      await categoryFilter.selectOption('productivity')

      // Wait for results to load
      await waitForResults(page)

      // Search prompt should now be hidden, results visible
      await expect(page.locator('#search-prompt-state')).toBeHidden()
      await expect(page.locator('#results-grid')).toBeVisible()
    })

    test('should return to search prompt when filter is cleared', async ({ page }) => {
      // Select a category first
      const categoryFilter = page.locator('#category-filter')
      await categoryFilter.selectOption('documentation')

      // Wait for results
      await waitForResults(page)
      await verifyResultsDisplayed(page)

      // Clear the filter (select "All Categories")
      await categoryFilter.selectOption('')

      // Should return to search prompt state
      await expect(page.locator('#search-prompt-state')).toBeVisible({ timeout: 5000 })
    })
  })

  test.describe('Multiple Category Switching', () => {
    test('should update results when switching between categories', async ({ page }) => {
      const categoryFilter = page.locator('#category-filter')

      // Test switching between multiple categories
      const categories = ['security', 'testing', 'development', 'devops']

      for (const category of categories) {
        await categoryFilter.selectOption(category)
        await waitForResults(page)

        const count = await verifyResultsDisplayed(page)
        console.log(`${category} category: ${count} results`)

        // Brief pause to ensure UI updates
        await page.waitForTimeout(300)
      }
    })
  })

  test.describe('Pagination with Filter-Only Browsing', () => {
    test('should show pagination when filter returns many results', async ({ page }) => {
      // Select a category likely to have many results
      const categoryFilter = page.locator('#category-filter')
      await categoryFilter.selectOption('development')

      // Wait for results
      await waitForResults(page)

      // Check if pagination is visible (indicates >12 results)
      const pagination = page.locator('#pagination')
      const isVisible = await pagination.isVisible()

      if (isVisible) {
        // Verify pagination controls work
        const nextButton = page.locator('#next-page')
        const prevButton = page.locator('#prev-page')

        // Initially, prev should be disabled
        await expect(prevButton).toBeDisabled()

        // If there are multiple pages, next should be enabled
        if (await nextButton.isEnabled()) {
          await nextButton.click()

          // Wait for page change
          await page.waitForTimeout(500)

          // Now prev should be enabled
          await expect(prevButton).toBeEnabled()
        }
      }
    })
  })

  test.describe('Sorting with Filter-Only Browsing', () => {
    test('should sort results by popularity when using filter-only browsing', async ({ page }) => {
      // Select a category
      const categoryFilter = page.locator('#category-filter')
      await categoryFilter.selectOption('testing')

      // Wait for results
      await waitForResults(page)

      // Change sort to popularity (stars)
      const sortSelect = page.locator('#sort-select')
      await sortSelect.selectOption('stars')

      // Wait for re-render
      await page.waitForTimeout(300)

      // Verify results are still displayed
      await verifyResultsDisplayed(page)
    })
  })

  // SMI-5366 (GH #1377): the card markup now comes from the extracted
  // renderSkillCard() module. These assert the rendered output in a real
  // browser (the unit tests pin the string; these prove it mounts + behaves).
  test.describe('SkillCard renderer (SMI-5366)', () => {
    // Fixture with 6 compatibility tags: 4 visible + "+2 more" toggle rendered.
    // Injected via page.route() so the toggle is ALWAYS present in CI; no more
    // test.skip on live data shape (plan-review High-5).
    const FIXTURE_SKILL = {
      id: 'smith-horn/e2e-fixture-skill',
      name: 'E2E Fixture Skill',
      author: 'smith-horn',
      description: 'Fixture skill for deterministic compat toggle testing.',
      trust_tier: 'verified',
      stars: 42,
      categories: ['development'],
      version: '1.0.0',
      compatibility: ['claude-code', 'cursor', 'copilot', 'windsurf', 'antigravity', 'codex'],
      license: 'MIT',
    }

    test('rendered cards expose the quality dot and license row', async ({ page }) => {
      await page.locator('#category-filter').selectOption('development')
      await waitForResults(page)

      // SMI-5368: card root is now <div class="card-hover">, not an <a>.
      // Locate the card container so sub-locators reach siblings of the title link.
      const firstCard = page.locator('#results-grid .card-hover').first()
      await expect(firstCard).toBeVisible()
      // renderSkillCard always emits a quality dot (role="img") and a license row.
      await expect(firstCard.locator('[role="img"]')).toBeVisible()
      await expect(firstCard.getByText('License:')).toBeVisible()
    })

    test('"+N more" compat toggle expands without navigating away (SMI-3529/5367/5368/5369)', async ({
      page,
    }) => {
      // Intercept the skills-search edge function to guarantee a card with >4 compat
      // tags renders -- makes this test deterministic in CI regardless of live data.
      await page.route('**/skills-search**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ skills: [FIXTURE_SKILL] }),
        })
      })

      await page.locator('#category-filter').selectOption('development')
      await waitForResults(page)

      const moreBtn = page.locator('[data-compat-toggle]').first()
      await expect(moreBtn).toBeVisible()
      await expect(moreBtn).toContainText(/\+\d+ more/)

      const urlBefore = page.url()
      // aria-label is unique to compat-extra regions; .first() guards against
      // hypothetical future duplicates in the fixture grid.
      const region = page.locator('[aria-label="Additional compatibility tags"]').first()

      // SMI-5368/5369 regression net: click must NOT bubble to the stretched
      // link and navigate away from the list page.
      await moreBtn.click()
      await expect(page).toHaveURL(urlBefore)

      // Hidden region is now revealed.
      await expect(region).toBeVisible()

      // SMI-5367: focus must land INSIDE the revealed region, not dump to <body>.
      await expect(region).toBeFocused()

      // Toggle button is now hidden (delegated handler sets style.display=none).
      await expect(moreBtn).toBeHidden()
    })

    test('card stretched-link navigates to skill detail (SMI-5368 positive case)', async ({
      page,
    }) => {
      // Same fixture so we know the exact encoded id for the detail-page URL.
      await page.route('**/skills-search**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ skills: [FIXTURE_SKILL] }),
        })
      })

      await page.locator('#category-filter').selectOption('development')
      await waitForResults(page)

      // Click the card description -- it sits under the stretched ::after overlay
      // (NOT the toggle button's z-10 carve-out). force:true is required because
      // the overlay intercepts the pointer events at the description's coordinates
      // (that interception IS what we are testing). Proves the overlay makes the
      // whole card clickable and the button carves out its own area via z-10.
      const description = page.locator('#results-grid .card-hover p.text-dark-400').first()
      await expect(description).toBeVisible()

      await Promise.all([page.waitForURL(/\/skills\/.+/), description.click({ force: true })])

      // URL must contain the skill id segment -- confirms the stretched link fired.
      await expect(page).toHaveURL(/\/skills\//)
    })
  })
})

/**
 * SMI-6428: results-region ownership race.
 *
 * A SIBLING describe block, deliberately NOT nested inside the SMI-1658 block above:
 * these scenarios must register their own page.route() handlers BEFORE page.goto(),
 * and the parent's beforeEach already navigates. Inheriting it would make every
 * route registration land after navigation, where it cannot affect requests already
 * in flight.
 *
 * The bug: searchSkills() and the astro:page-load init chain
 * (initAuth() -> loadFeaturedSkills() -> showState('search-prompt')) are two
 * independent writers to one shared results region. Whichever resolved last won, so
 * a filter touched shortly after page load could have its results silently replaced
 * by the featured-examples view. The fix is a resultsGeneration ownership counter
 * plus a terminal-write guard in the init chain.
 */
test.describe('SMI-6428: results-region ownership race', () => {
  const SEARCH_FIXTURE_SKILL = {
    id: 'smith-horn/smi-6428-race-fixture',
    name: 'SMI-6428 Race Fixture Skill',
    author: 'smith-horn',
    description: 'Search-result fixture proving the results region survives the init chain.',
    trust_tier: 'verified',
    stars: 7,
    categories: ['development'],
    version: '1.0.0',
    compatibility: ['claude-code'],
    license: 'MIT',
  }

  const FEATURED_FIXTURE_SKILL = {
    id: 'smith-horn/smi-6428-featured-fixture',
    name: 'SMI-6428 Featured Fixture Skill',
    author: 'smith-horn',
    description: 'Featured-examples fixture -- must never replace an active search.',
    trust_tier: 'verified',
    stars: 3,
    categories: ['development'],
    version: '1.0.0',
    compatibility: ['claude-code'],
    license: 'MIT',
  }

  /**
   * Same SMI-5504 overlay suppression the SMI-1658 beforeEach uses. Re-declared
   * here rather than shared because this block intentionally does not inherit that
   * beforeEach (see the block comment above).
   */
  async function suppressSignedOutOverlay(page: Page): Promise<void> {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem(
          'skills_overlay_dismissed_until',
          new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        )
      } catch {
        /* localStorage unavailable -- overlay suppression falls back to the race */
      }
    })
  }

  /** skills-search always answers immediately with one deterministic card. */
  async function routeSearch(page: Page): Promise<void> {
    await page.route('**/skills-search**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ skills: [SEARCH_FIXTURE_SKILL] }),
      })
    })
  }

  /**
   * skills-get backs loadFeaturedSkills(). `delayMs` holds the init chain open so
   * its terminal write lands AFTER the search has already rendered -- the exact
   * ordering that produced the red CI check.
   */
  async function routeFeatured(page: Page, delayMs: number): Promise<void> {
    await page.route('**/skills-get/**', async (route) => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: FEATURED_FIXTURE_SKILL }),
      })
    })
  }

  test('SMI-6428 scenario 1: a slow featured-load must not stomp an active search', async ({
    page,
  }) => {
    await suppressSignedOutOverlay(page)
    // Registered BEFORE goto -- a route added after navigation starts does not
    // apply to requests already in flight.
    await routeFeatured(page, 1500)
    await routeSearch(page)

    await page.goto(`${BASE_URL}/skills`)

    // Only proves the static HTML rendered -- NOT that the astro:page-load handler
    // bound its listeners or that the init chain resolved. Interacting here is the
    // post-bind race window this scenario targets.
    await expect(page.locator('#category-filter')).toBeVisible()
    await page.locator('#category-filter').selectOption('development')

    const searchCard = page.locator('#results-grid').getByText(SEARCH_FIXTURE_SKILL.name)
    await expect(searchCard).toBeVisible({ timeout: 15000 })
    await expect(page.locator('#search-prompt-state')).toBeHidden()

    // Past the 1500ms featured-load delay: the init chain's terminal write has now
    // had its chance to fire. Before the fix it replaced the results with the
    // featured state here; it must not any more.
    await page.waitForTimeout(2000)
    await expect(searchCard).toBeVisible()
    await expect(page.locator('#search-prompt-state')).toBeHidden()
    await expect(page.locator('#results-count')).not.toHaveText('Showing featured examples')
  })

  test('SMI-6428 scenario 2: a filter changed before listeners bind is not lost', async ({
    page,
  }) => {
    await suppressSignedOutOverlay(page)

    // Natural timing cannot reliably reach the pre-bind window, so make it
    // deterministic: capture every astro:page-load listener registered on document
    // WITHOUT invoking it, and expose a release hook the test fires on demand.
    // All captured listeners are replayed in registration order (BaseLayout's
    // ClientRouter and other components register on this event too), so releasing
    // reproduces a normal page-load, just later than the interaction.
    await page.addInitScript(() => {
      const captured: Array<{ target: EventTarget; args: unknown[] }> = []
      const realAdd = EventTarget.prototype.addEventListener
      const invokeRealAdd = (target: EventTarget, args: unknown[]): void => {
        Reflect.apply(realAdd, target, args)
      }
      const patched = function (this: EventTarget, type: string, ...rest: unknown[]): void {
        if (type === 'astro:page-load' && (this as unknown) === document) {
          captured.push({ target: this, args: [type, ...rest] })
          return
        }
        invokeRealAdd(this, [type, ...rest])
      }
      EventTarget.prototype.addEventListener =
        patched as typeof EventTarget.prototype.addEventListener

      const release = (): void => {
        EventTarget.prototype.addEventListener = realAdd
        const evt = new Event('astro:page-load')
        for (const entry of captured) {
          invokeRealAdd(entry.target, entry.args)
          const listener = entry.args[1] as EventListenerOrEventListenerObject | undefined
          if (typeof listener === 'function') {
            listener.call(entry.target, evt)
          } else if (listener && typeof listener.handleEvent === 'function') {
            listener.handleEvent(evt)
          }
        }
        captured.length = 0
      }
      ;(window as unknown as { __releaseAstroPageLoad__?: () => void }).__releaseAstroPageLoad__ =
        release
    })

    await routeFeatured(page, 0)
    await routeSearch(page)

    await page.goto(`${BASE_URL}/skills`)
    await expect(page.locator('#category-filter')).toBeVisible()

    // The handler has NOT run, so no change listener exists yet. This select is the
    // user interaction the real listener would have caught -- before the fix it was
    // dropped entirely and the init chain painted the featured state over it.
    await page.locator('#category-filter').selectOption('development')

    await page.evaluate(() => {
      ;(window as unknown as { __releaseAstroPageLoad__?: () => void }).__releaseAstroPageLoad__?.()
    })

    const searchCard = page.locator('#results-grid').getByText(SEARCH_FIXTURE_SKILL.name)
    await expect(searchCard).toBeVisible({ timeout: 15000 })
    await expect(page.locator('#search-prompt-state')).toBeHidden()
    await expect(page.locator('#results-count')).not.toHaveText('Showing featured examples')
  })
})
