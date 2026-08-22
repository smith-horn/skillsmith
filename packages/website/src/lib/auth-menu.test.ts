import { describe, it, expect } from 'vitest'
import { USER_MENU_LINK_ITEMS, AUTH_MENU_SIGN_OUT_LABEL, renderMobileAuthMenu } from './auth-menu'

describe('USER_MENU_LINK_ITEMS', () => {
  it('contains exactly the Account link and no Dashboard/Subscription/Email Address items', () => {
    const labels = USER_MENU_LINK_ITEMS.map((item) => item.label)
    expect(labels).toEqual(['Account'])
    expect(labels).not.toContain('Dashboard')
    expect(labels).not.toContain('Subscription')
    expect(labels).not.toContain('Email Address')
  })

  it('points the Account link at /account', () => {
    expect(USER_MENU_LINK_ITEMS.find((item) => item.label === 'Account')?.href).toBe('/account')
  })
})

describe('AUTH_MENU_SIGN_OUT_LABEL', () => {
  it('is exactly "Sign out"', () => {
    expect(AUTH_MENU_SIGN_OUT_LABEL).toBe('Sign out')
  })
})

describe('renderMobileAuthMenu', () => {
  it('renders exactly one Account link and one Sign out control', () => {
    const html = renderMobileAuthMenu()
    expect(html.match(/nav-mobile-link/g)).toHaveLength(2)
    expect(html).toContain('href="/account"')
    expect(html).toContain('>Account<')
    expect(html).toContain('id="nav-mobile-logout"')
    expect(html).toContain('>Sign out<')
  })

  it('does not include Dashboard, Subscription, or Email Address', () => {
    const html = renderMobileAuthMenu()
    expect(html).not.toContain('Dashboard')
    expect(html).not.toContain('Subscription')
    expect(html).not.toContain('Email Address')
  })

  it('is idempotent — repeated calls return byte-identical output', () => {
    expect(renderMobileAuthMenu()).toBe(renderMobileAuthMenu())
  })
})
