import { test, expect } from "@playwright/test";

/**
 * Visual regression baseline snapshots for the Skillsmith website.
 *
 * Captures full-page screenshots of key public pages at two viewport
 * sizes (desktop 1440x900, mobile 375x812) defined in playwright.config.ts.
 *
 * First run generates baseline snapshots in __snapshots__/.
 * Subsequent runs compare against baselines and flag visual regressions.
 *
 * Usage:
 *   npm run test:visual              # Compare against baselines
 *   npm run test:visual:update       # Regenerate baselines
 */

/** Pages to capture baselines for */
const pages = [
  { name: "homepage", path: "/" },
  { name: "skills", path: "/skills" },
  { name: "docs", path: "/docs" },
  { name: "pricing", path: "/pricing" },
  { name: "contact", path: "/contact" },
  { name: "faq", path: "/faq" },
] as const;

for (const { name, path } of pages) {
  test(`${name} visual baseline`, async ({ page }) => {
    const response = await page.goto(path, {
      waitUntil: "networkidle",
      timeout: 15_000,
    });

    // Skip pages that return non-200 (e.g., not yet deployed)
    if (!response || response.status() >= 400) {
      test.skip(true, `${path} returned status ${response?.status() ?? "no response"}`);
      return;
    }

    // Wait for web fonts to finish loading before capturing snapshot
    await page.waitForFunction(() => document.fonts.ready.then(() => true));

    await expect(page).toHaveScreenshot(`${name}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });
}
