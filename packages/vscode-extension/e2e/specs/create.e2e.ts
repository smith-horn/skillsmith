/**
 * Create skill — degraded-path E2E spec (SMI-5339 Phase 2b).
 *
 * `skillsmith.createSkill` opens a webview wizard only after
 * `ensureCliAvailable()` succeeds by finding the `skillsmith` binary on PATH.
 * In CI there is no `skillsmith` binary, so `ensureCliAvailable()` rejects
 * before the CreateSkillPanel is constructed and the 'Create Skill' tab never
 * opens.
 *
 * This spec asserts the degraded path:
 *   1. Invoke `skillsmith.createSkill`.
 *   2. Wait 3 s for the async `ensureCliAvailable()` call to settle (the
 *      command callback resolves immediately; the async work runs after).
 *      (governance H7 — bare assert would race the async settle).
 *   3. Assert that no 'Create Skill' tab was opened.
 *
 * The spec needs no fake-MCP connection and no additional fixtures because the
 * guard fires before any MCP call is attempted.
 */
import { browser, expect } from '@wdio/globals'
import { CreateSkillPage } from '../pageobjects/create-skill.page.js'

describe('Create skill — degraded path (no CLI binary, SMI-5339)', () => {
  const page = new CreateSkillPage()

  it('createSkill does not open a panel when the CLI binary is absent', async () => {
    // Ensure the extension host is in a known connected state before the test.
    await page.forceConnect()

    // Fire the command. In the degraded path (no `skillsmith` binary on PATH)
    // ensureCliAvailable() rejects and the panel is never created.
    await page.openCreate()

    // Pause long enough for the async ensureCliAvailable() call to settle.
    // Mirrors mcp-failure.e2e.ts which pauses before absence assertions.
    await browser.pause(3_000)

    // Assert: the 'Create Skill' tab must NOT have opened.
    const tabOpened = await page.createTabExists()
    expect(tabOpened).toBe(false)
  })
})
