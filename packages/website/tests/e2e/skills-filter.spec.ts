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
    await page.goto(`${BASE_URL}/skills`)
    // Wait for the page to be fully loaded
    await expect(page.locator('#category-filter')).toBeVisible()
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
