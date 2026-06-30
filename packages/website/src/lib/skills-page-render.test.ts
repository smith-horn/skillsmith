/**
 * Tests for the /account/skills client-side HTML builders (SMI-5393).
 *
 * The builders assemble HTML strings assigned via innerHTML from RPC data that
 * is partly user-controlled (device labels, skill ids, versions), so the
 * security-critical assertion here is that every such value is HTML-escaped.
 */

import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  buildStateBadgeHtml,
  deviceDisplayName,
  buildDeviceCardHtml,
} from './skills-page-render'
import { SKILL_STATE_META, type DeviceView, type SkillState } from './inventory-view'

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters, ampersand first', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('neutralises a script-injection payload', () => {
    const out = escapeHtml('<img src=x onerror=alert(1)>')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('leaves a benign string unchanged', () => {
    expect(escapeHtml('acme/widget 1.2.3')).toBe('acme/widget 1.2.3')
  })
})

describe('buildStateBadgeHtml', () => {
  const states: SkillState[] = [
    'current',
    'drifted',
    'missing',
    'pinned',
    'unknown',
    'local',
    'source-identified',
    'pending',
  ]
  it('renders label + svg path + tooltip for every state', () => {
    for (const state of states) {
      const html = buildStateBadgeHtml(state)
      expect(html).toContain(SKILL_STATE_META[state].label)
      expect(html).toContain('<path')
      expect(html).toContain(`title="${escapeHtml(SKILL_STATE_META[state].description)}"`)
      expect(html).toContain('aria-hidden="true"')
    }
  })

  it('carries data-testid="skill-badge" and the correct data-state for every state', () => {
    for (const state of states) {
      const html = buildStateBadgeHtml(state)
      expect(html).toContain('data-testid="skill-badge"')
      expect(html).toContain(`data-state="${state}"`)
    }
  })
})

describe('deviceDisplayName', () => {
  const base: DeviceView = {
    deviceId: 'abcdef12-3456-4789-8abc-def012345678',
    label: null,
    hostnameDisplay: null,
    platform: null,
    lastSeen: '2026-06-26T00:00:00.000Z',
    deviceState: 'fresh',
    neverSynced: false,
    skills: [],
  }
  it('prefers label, then hostname, then a truncated device id', () => {
    expect(deviceDisplayName({ ...base, label: 'work laptop' })).toBe('work laptop')
    expect(deviceDisplayName({ ...base, hostnameDisplay: 'host-1' })).toBe('host-1')
    expect(deviceDisplayName(base)).toBe('Device abcdef12')
  })
})

describe('buildDeviceCardHtml', () => {
  it('escapes a malicious device label and skill id (no raw tags survive)', () => {
    const evil: DeviceView = {
      deviceId: 'abcdef12-3456-4789-8abc-def012345678',
      label: '<img src=x onerror=alert(1)>',
      hostnameDisplay: null,
      platform: '"><script>bad()</script>',
      lastSeen: '2026-06-26T00:00:00.000Z',
      deviceState: 'fresh',
      neverSynced: false,
      skills: [
        {
          harness: 'claude-code',
          skillId: 'evil/<b>x</b>',
          version: '"onmouseover="x',
          present: true,
          pinned: false,
          state: 'drifted',
          author: null,
          repository: null,
          license: null,
        },
      ],
    }
    const html = buildDeviceCardHtml(evil)
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>bad')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    // the drifted badge label is still rendered for the (escaped) skill
    expect(html).toContain(SKILL_STATE_META.drifted.label)
  })

  it('renders the never-synced message and no skill list for an empty device', () => {
    const empty: DeviceView = {
      deviceId: 'abcdef12-3456-4789-8abc-def012345678',
      label: 'fresh box',
      hostnameDisplay: null,
      platform: 'darwin',
      lastSeen: '2026-06-26T00:00:00.000Z',
      deviceState: 'fresh',
      neverSynced: true,
      skills: [],
    }
    const html = buildDeviceCardHtml(empty)
    expect(html).toContain('No skills synced from this device yet.')
    expect(html).not.toContain('<ul')
    expect(html).toContain('aria-label="Device: fresh box"')
  })

  it('marks a stale device with a non-color text cue', () => {
    const stale: DeviceView = {
      deviceId: 'abcdef12-3456-4789-8abc-def012345678',
      label: 'old box',
      hostnameDisplay: null,
      platform: 'linux',
      lastSeen: '2026-06-01T00:00:00.000Z',
      deviceState: 'stale',
      neverSynced: false,
      skills: [],
    }
    const html = buildDeviceCardHtml(stale)
    expect(html).toContain('device-card--stale')
    expect(html).toContain('(stale)')
  })

  it('carries data-testid="device-card" on the section element', () => {
    const device: DeviceView = {
      deviceId: 'abcdef12-3456-4789-8abc-def012345678',
      label: 'test box',
      hostnameDisplay: null,
      platform: 'darwin',
      lastSeen: '2026-06-26T00:00:00.000Z',
      deviceState: 'fresh',
      neverSynced: true,
      skills: [],
    }
    const html = buildDeviceCardHtml(device)
    expect(html).toContain('data-testid="device-card"')
  })

  it('source-identified: renders author+repository as plain text with (unverified) label — no hyperlink', () => {
    const device: DeviceView = {
      deviceId: 'abcdef12-3456-4789-8abc-def012345678',
      label: 'my-box',
      hostnameDisplay: null,
      platform: 'darwin',
      lastSeen: '2026-06-26T00:00:00.000Z',
      deviceState: 'fresh',
      neverSynced: false,
      skills: [
        {
          harness: 'zed',
          skillId: 'acme/widget',
          version: '1.0.0',
          present: true,
          pinned: false,
          state: 'source-identified',
          author: 'acme-org',
          repository: 'https://github.com/acme/widget',
          license: 'MIT',
        },
      ],
    }
    const html = buildDeviceCardHtml(device)
    // Label and badge present
    expect(html).toContain(SKILL_STATE_META['source-identified'].label)
    // Author and repository rendered as plain text
    expect(html).toContain('acme-org')
    expect(html).toContain('https://github.com/acme/widget')
    // Unverified marker present
    expect(html).toContain('(unverified)')
    // Must NOT render the repository URL as a plain href= link (trust-laundering guard)
    expect(html).not.toMatch(/href="https:\/\/github\.com\/acme\/widget"/)
  })

  it('registry-matched state: renders repository as a link with rel=noopener', () => {
    const device: DeviceView = {
      deviceId: 'abcdef12-3456-4789-8abc-def012345678',
      label: 'my-box',
      hostnameDisplay: null,
      platform: 'darwin',
      lastSeen: '2026-06-26T00:00:00.000Z',
      deviceState: 'fresh',
      neverSynced: false,
      skills: [
        {
          harness: 'zed',
          skillId: 'verified/skill',
          version: '2.0.0',
          present: true,
          pinned: false,
          state: 'current',
          author: 'verified-org',
          repository: 'https://github.com/verified/skill',
          license: 'MIT',
        },
      ],
    }
    const html = buildDeviceCardHtml(device)
    // Repository rendered as a link
    expect(html).toContain('href="https://github.com/verified/skill"')
    expect(html).toContain('rel="noopener noreferrer"')
    // No unverified label for registry-matched states
    expect(html).not.toContain('(unverified)')
  })

  it('local state: renders no source affordance', () => {
    const device: DeviceView = {
      deviceId: 'abcdef12-3456-4789-8abc-def012345678',
      label: 'my-box',
      hostnameDisplay: null,
      platform: 'darwin',
      lastSeen: '2026-06-26T00:00:00.000Z',
      deviceState: 'fresh',
      neverSynced: false,
      skills: [
        {
          harness: 'cursor',
          skillId: 'my-local/tool',
          version: null,
          present: true,
          pinned: false,
          state: 'local',
          author: null,
          repository: null,
          license: null,
        },
      ],
    }
    const html = buildDeviceCardHtml(device)
    expect(html).toContain(SKILL_STATE_META.local.label)
    expect(html).not.toContain('skill-source')
    expect(html).not.toContain('(unverified)')
  })
})
