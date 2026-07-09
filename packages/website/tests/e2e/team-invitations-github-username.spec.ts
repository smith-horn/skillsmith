/**
 * SMI-5589: admin-facing github_username set path e2e.
 *
 * Split out of team-invitations.spec.ts to keep both files under the
 * 500-line audit:standards limit. Shares the /account/team/members mocking
 * harness (setupMembersPage) via team-members-page.helpers.ts.
 *
 * Run:
 *   cd packages/website
 *   npx playwright test tests/e2e/team-invitations-github-username.spec.ts
 */

import { test, expect } from '@playwright/test'

import { OWNER_USER, setupMembersPage } from './team-members-page.helpers'

test.describe('SMI-5589: admin github_username set path', () => {
  test("button is not rendered on the viewer's own row", async ({ page }) => {
    await setupMembersPage(page)
    await page.goto('/account/team/members')

    const ownerRow = page.locator('[data-member-id="tm_owner"]')
    await expect(ownerRow).toBeVisible({ timeout: 5000 })
    await expect(ownerRow.locator('[data-action="set-github-username"]')).toHaveCount(0)

    const tonyRow = page.locator('[data-member-id="tm_tony"]')
    await expect(tonyRow.locator('[data-action="set-github-username"]')).toHaveCount(1)
    await expect(tonyRow.locator('[data-action="set-github-username"]')).toHaveText(
      'Set GitHub Username'
    )
  })

  test("owner sets a teammate's GitHub username via the prompt; row updates", async ({ page }) => {
    await setupMembersPage(page)
    await page.goto('/account/team/members')

    const tonyRow = page.locator('[data-member-id="tm_tony"]')
    await expect(tonyRow.locator('.member-github')).toHaveText('GitHub: not linked')

    page.once('dialog', (dialog) => {
      dialog.accept('octocat').catch(() => undefined)
    })
    await tonyRow.locator('[data-action="set-github-username"]').click()

    await expect(tonyRow.locator('.member-github')).toHaveText('GitHub: @octocat', {
      timeout: 5000,
    })
    await expect(tonyRow.locator('[data-action="set-github-username"]')).toHaveText(
      'Edit GitHub Username'
    )
  })

  test("owner clears a teammate's GitHub username by submitting blank", async ({ page }) => {
    await setupMembersPage(page, {
      members: [
        {
          member_id: 'tm_owner',
          user_id: OWNER_USER.id,
          role: 'owner',
          joined_at: '2026-05-01T00:00:00Z',
          invited_at: null,
          full_name: 'Owner User',
          email: 'owner@example.com',
          github_username: null,
        },
        {
          member_id: 'tm_tony',
          user_id: 'user_tony',
          role: 'member',
          joined_at: '2026-05-15T00:00:00Z',
          invited_at: '2026-05-14T00:00:00Z',
          full_name: 'Tony Lee',
          email: 'tony.lee@example.com',
          github_username: 'tony-lee',
        },
      ],
    })
    await page.goto('/account/team/members')

    const tonyRow = page.locator('[data-member-id="tm_tony"]')
    await expect(tonyRow.locator('.member-github')).toHaveText('GitHub: @tony-lee')
    await expect(tonyRow.locator('[data-action="set-github-username"]')).toHaveText(
      'Edit GitHub Username'
    )

    page.once('dialog', (dialog) => {
      dialog.accept('').catch(() => undefined)
    })
    await tonyRow.locator('[data-action="set-github-username"]').click()

    await expect(tonyRow.locator('.member-github')).toHaveText('GitHub: not linked', {
      timeout: 5000,
    })
    await expect(tonyRow.locator('[data-action="set-github-username"]')).toHaveText(
      'Set GitHub Username'
    )
  })

  test('cancelling the prompt makes no RPC call and leaves the row unchanged', async ({ page }) => {
    await setupMembersPage(page)
    await page.goto('/account/team/members')

    const tonyRow = page.locator('[data-member-id="tm_tony"]')
    await expect(tonyRow.locator('.member-github')).toHaveText('GitHub: not linked')

    page.once('dialog', (dialog) => {
      dialog.dismiss().catch(() => undefined)
    })
    await tonyRow.locator('[data-action="set-github-username"]').click()

    // No mutation occurred and the button re-enabled (never disabled by a
    // cancelled prompt in the first place).
    await expect(tonyRow.locator('.member-github')).toHaveText('GitHub: not linked')
    await expect(tonyRow.locator('[data-action="set-github-username"]')).toBeEnabled()
  })

  test('RPC error shows an alert and re-enables the button', async ({ page }) => {
    await setupMembersPage(page, { setGithubUsernameError: 'invalid github_username format' })
    await page.goto('/account/team/members')

    const tonyRow = page.locator('[data-member-id="tm_tony"]')
    const button = tonyRow.locator('[data-action="set-github-username"]')

    let alertMessage: string | undefined
    page.once('dialog', (dialog) => {
      if (dialog.type() === 'prompt') {
        dialog.accept('-bad').catch(() => undefined)
        page.once('dialog', (alertDialog) => {
          alertMessage = alertDialog.message()
          alertDialog.accept().catch(() => undefined)
        })
      }
    })
    await button.click()

    await expect.poll(() => alertMessage, { timeout: 5000 }).toMatch(/valid GitHub username/i)
    await expect(button).toBeEnabled()
    await expect(tonyRow.locator('.member-github')).toHaveText('GitHub: not linked')
  })
})
