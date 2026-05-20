/* eslint-disable no-console */
// SMI-5055 UAT — verifies the auth degradation fallbacks against the real
// (still-degraded) prod Supabase project. Drops into Docker, drives Chromium
// against the local Astro dev server (which injects the same prod
// __SUPABASE_CONFIG__ as the deployed website).

import { chromium } from 'playwright'

const BASE = process.env.UAT_BASE || 'http://localhost:3001'
const HEADERLESS_RESOLVE_BUDGET_MS = 5000 // 3s timeout + 2s slack
const LOGIN_BANNER_BUDGET_MS = 14000 // 10s timeout + 4s slack

const fail = (msg) => {
  console.error('❌', msg)
  process.exitCode = 1
}
const ok = (msg) => console.log('✅', msg)

async function pricingHeaderFallsBack(page) {
  console.log('--- TEST 1: /pricing header fallback (expect Log in / Get Started within ~3s)')
  const navStart = Date.now()
  await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' })

  // The skeleton is the .user-menu-loading element. Once auth times out (or
  // succeeds), it gets display:none and .user-menu-logged-out becomes visible.
  // Wait for either the logged-out state OR the logged-in state to appear.
  try {
    await page.waitForFunction(
      () => {
        const out = document.getElementById('user-menu-logged-out')
        const inn = document.getElementById('user-menu-logged-in')
        const loading = document.getElementById('user-menu-loading')
        const visible = (el) => el && el.style.display !== 'none'
        return (visible(out) || visible(inn)) && !visible(loading)
      },
      { timeout: HEADERLESS_RESOLVE_BUDGET_MS }
    )
    const elapsed = Date.now() - navStart
    ok(`Header resolved in ${elapsed} ms (budget ${HEADERLESS_RESOLVE_BUDGET_MS} ms)`)

    const loginText = await page
      .locator('#user-menu-logged-out a, #user-menu-logged-out button')
      .first()
      .textContent({ timeout: 2000 })
      .catch(() => null)
    if (loginText) {
      ok(`Logged-out CTA visible: "${loginText.trim().slice(0, 40)}…"`)
    } else {
      fail('Logged-out CTA not visible after fallback')
    }
  } catch (err) {
    fail(
      `Header still on skeleton after ${HEADERLESS_RESOLVE_BUDGET_MS} ms — degradation fix did NOT engage`
    )
    const skel = await page
      .locator('#user-menu-loading')
      .isVisible()
      .catch(() => false)
    console.log('   skeleton still visible:', skel)
    console.log('   error:', err.message)
  }

  await page.screenshot({ path: '/tmp/uat-pricing.png', fullPage: false })
  console.log('   screenshot → /tmp/uat-pricing.png')
}

async function staleTokenTriggersTimeoutFallback(page) {
  console.log(
    '\n--- TEST 3: stale auth token in localStorage → getSession refresh hits degraded GoTrue → 3s timeout fallback'
  )

  // Seed a syntactically-valid but expired Supabase auth-token entry. This
  // forces supabase-js to attempt a refresh via /auth/v1/token, which hits
  // the degraded GoTrue and hangs — exactly the user scenario where the
  // header skeleton would otherwise stick forever without our fix.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    const fakeJwt =
      btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) +
      '.' +
      btoa(JSON.stringify({ exp: 1, sub: 'stale-user' })) +
      '.signature'
    const session = {
      access_token: `header.${fakeJwt}.sig`,
      refresh_token: 'definitely-not-real',
      expires_at: 1, // long expired
      expires_in: -1,
      token_type: 'bearer',
      user: { id: 'stale-user', email: 'stale@example.com' },
    }
    localStorage.setItem('sb-vrcnzpmndtroqxxoqkzy-auth-token', JSON.stringify(session))
  })

  const navStart = Date.now()
  await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' })
  try {
    await page.waitForFunction(
      () => {
        const out = document.getElementById('user-menu-logged-out')
        const loading = document.getElementById('user-menu-loading')
        const visible = (el) => el && el.style.display !== 'none'
        return visible(out) && !visible(loading)
      },
      { timeout: HEADERLESS_RESOLVE_BUDGET_MS }
    )
    const elapsed = Date.now() - navStart
    if (elapsed >= 2500 && elapsed <= 4500) {
      ok(`Timeout fallback fired in ${elapsed} ms — within expected 3s window`)
    } else if (elapsed < 2500) {
      ok(
        `Header resolved in ${elapsed} ms (fast path — refresh succeeded or no network call needed)`
      )
    } else {
      fail(`Header took ${elapsed} ms — timeout fallback didn't engage cleanly`)
    }
  } catch (err) {
    fail(`Header skeleton stuck > ${HEADERLESS_RESOLVE_BUDGET_MS} ms with stale token`)
    console.log('   error:', err.message)
  }

  // Cleanup so subsequent tests start fresh.
  await page.evaluate(() => localStorage.clear())
  await page.screenshot({ path: '/tmp/uat-stale-token.png', fullPage: false })
  console.log('   screenshot → /tmp/uat-stale-token.png')
}

async function loginButtonSmokeCheck(page) {
  console.log('\n--- TEST 2: /login GitHub button smoke check (button renders, no JS errors)')
  // The actual OAuth-redirect 504 happens at the browser navigation level
  // (supabase-js v2.x with skipBrowserRedirect builds the URL synchronously,
  // so our withAuthTimeout wrapper around signInWithOAuth is effectively a
  // no-op for this version). The user-visible 504 page is owned by
  // Cloudflare/Supabase — not addressable from our client. We verify the
  // button still renders and doesn't throw before the redirect attempt.

  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.github-login-btn', { timeout: 5000 })

  const btnText = (await page.locator('.github-login-btn .btn-text').textContent()) || ''
  if (/Continue with GitHub/i.test(btnText)) {
    ok(`Button renders with expected label: "${btnText.trim()}"`)
  } else {
    fail(`Button text unexpected: "${btnText.trim()}"`)
  }

  // Smoke: ensure no uncaught JS errors during init.
  await page.waitForTimeout(500)
  if (errors.length === 0) {
    ok('No uncaught page errors during /login init')
  } else {
    fail(`Page errors detected: ${errors.join(' | ')}`)
  }

  await page.screenshot({ path: '/tmp/uat-login.png', fullPage: false })
  console.log('   screenshot → /tmp/uat-login.png')
  console.log(
    '   NOTE: The OAuth-redirect 504 (user clicks → browser navigates → Cloudflare 504) is not addressable client-side without UX changes (popup/new tab). Tracked as a follow-up.'
  )
}

;(async () => {
  console.log(`SMI-5055 UAT against ${BASE}`)
  console.log('Supabase Auth is currently degraded — this exercises the real fallback paths.')
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) {
      console.log(`   [browser ${m.type()}]`, m.text().slice(0, 200))
    }
  })

  try {
    // Warm Vite dep optimization so first real test isn't dominated by
    // first-hit module-graph build (~5s of slack on a cold dev server).
    console.log('--- WARMUP: priming Vite dep cache')
    await page.goto(`${BASE}/pricing`, { waitUntil: 'load' }).catch(() => {})
    await page.goto(`${BASE}/login`, { waitUntil: 'load' }).catch(() => {})
    await pricingHeaderFallsBack(page)
    await staleTokenTriggersTimeoutFallback(page)
    await loginButtonSmokeCheck(page)
  } finally {
    await browser.close()
  }

  if (process.exitCode) {
    console.log('\n❌ UAT FAILED')
  } else {
    console.log('\n✅ UAT PASSED — degradation fallbacks work as designed')
  }
})().catch((err) => {
  console.error('UAT crashed:', err)
  process.exit(1)
})
