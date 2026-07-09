/**
 * Tests for the SMI-5595 suggested-action rendering in skills-page-render.ts
 * (per-skill `.skill-action` span and the device-wide `.device-batch-tip`).
 *
 * Split out of skills-page-render.test.ts to keep both files under the
 * project's 500-line-per-file standard.
 */

import { describe, it, expect } from 'vitest'
import { buildDeviceCardHtml } from './skills-page-render'
import { SKILL_STATE_META, type DeviceView, type SkillView } from './inventory-view'

describe('buildDeviceCardHtml — suggested action / device batch tip (SMI-5595)', () => {
  it('drifted: renders a .skill-action span with the skill id substituted into a <code> command, unescaped for benign chars', () => {
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
          state: 'drifted',
          author: null,
          repository: null,
          license: null,
        },
      ],
    }
    const html = buildDeviceCardHtml(device)
    expect(html).toContain('<span class="skill-action">')
    // '/' is not HTML-significant — escapeHtml leaves it unchanged.
    expect(html).toContain('<code>skillsmith update acme/widget</code>')
  })

  it('drifted: escapes a skill id containing < and & inside the rendered <code> span (XSS-safety regression)', () => {
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
          skillId: 'evil/<script>&x',
          version: '1.0.0',
          present: true,
          pinned: false,
          state: 'drifted',
          author: null,
          repository: null,
          license: null,
        },
      ],
    }
    const html = buildDeviceCardHtml(device)
    expect(html).not.toContain('<script>&x')
    expect(html).toContain('<code>skillsmith update evil/&lt;script&gt;&amp;x</code>')
  })

  it('drifted: a backtick in the skill id does not shift code-span parity (regression for the split-then-substitute order)', () => {
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
          skillId: 'acme/wid`get',
          version: '1.0.0',
          present: true,
          pinned: false,
          state: 'drifted',
          author: null,
          repository: null,
          license: null,
        },
      ],
    }
    const html = buildDeviceCardHtml(device)
    // Splitting on the (trusted) template first, then substituting <skill> only
    // inside the already-identified code segment, means a backtick carried in
    // by the skill id can't shift which parts of the surrounding sentence get
    // treated as code — the whole command stays inside one <code> span.
    expect(html).toContain('<code>skillsmith update acme/wid`get</code>')
    const actionMatch = html.match(/<span class="skill-action">(.*?)<\/span>/)
    expect(actionMatch).not.toBeNull()
    expect(actionMatch![1]).toBe('Run <code>skillsmith update acme/wid`get</code> on that machine.')
  })

  it('current: renders a .skill-action span with plain text and no <code> child for a no-command state', () => {
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
          state: 'current',
          author: null,
          repository: null,
          license: null,
        },
      ],
    }
    const html = buildDeviceCardHtml(device)
    const actionMatch = html.match(/<span class="skill-action">(.*?)<\/span>/)
    expect(actionMatch).not.toBeNull()
    expect(actionMatch![1]).toBe(SKILL_STATE_META.current.suggestedAction)
    expect(actionMatch![1]).not.toContain('<code>')
  })

  it('a11y: the .skill-action span for a skill is nested inside that skill\'s own <li class="skill-item"> (not a sibling or unattached element)', () => {
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
          state: 'drifted',
          author: null,
          repository: null,
          license: null,
        },
      ],
    }
    const html = buildDeviceCardHtml(device)
    const liMatch = html.match(/<li class="skill-item">.*?<\/li>/s)
    expect(liMatch).not.toBeNull()
    const liHtml = liMatch![0]
    expect(liHtml).toContain('acme/widget')
    expect(liHtml).toContain('<span class="skill-action">')
    expect(liHtml).toContain('<code>skillsmith update acme/widget</code>')
  })

  describe('device batch tip (computeDeviceBatchTip integration)', () => {
    function skill(overrides: Partial<SkillView>): SkillView {
      return {
        harness: 'zed',
        skillId: 'acme/widget',
        version: '1.0.0',
        present: true,
        pinned: false,
        state: 'current',
        author: null,
        repository: null,
        license: null,
        ...overrides,
      }
    }

    it('renders exactly one .device-batch-tip when 2+ skills are drifted across different harnesses', () => {
      const device: DeviceView = {
        deviceId: 'abcdef12-3456-4789-8abc-def012345678',
        label: 'my-box',
        hostnameDisplay: null,
        platform: 'darwin',
        lastSeen: '2026-06-26T00:00:00.000Z',
        deviceState: 'fresh',
        neverSynced: false,
        skills: [
          skill({ harness: 'zed', skillId: 'acme/one', state: 'drifted' }),
          skill({ harness: 'cursor', skillId: 'acme/two', state: 'drifted' }),
        ],
      }
      const html = buildDeviceCardHtml(device)
      const matches = html.match(/class="device-batch-tip"/g) ?? []
      expect(matches).toHaveLength(1)
      expect(html).toContain('<code>skillsmith update --all</code>')
    })

    it('renders no .device-batch-tip when 0 or 1 skill is drifted', () => {
      const zeroDrifted: DeviceView = {
        deviceId: 'abcdef12-3456-4789-8abc-def012345678',
        label: 'my-box',
        hostnameDisplay: null,
        platform: 'darwin',
        lastSeen: '2026-06-26T00:00:00.000Z',
        deviceState: 'fresh',
        neverSynced: false,
        skills: [skill({ state: 'current' }), skill({ skillId: 'acme/two', state: 'local' })],
      }
      expect(buildDeviceCardHtml(zeroDrifted)).not.toContain('device-batch-tip')

      const oneDrifted: DeviceView = {
        ...zeroDrifted,
        skills: [skill({ state: 'drifted' }), skill({ skillId: 'acme/two', state: 'current' })],
      }
      expect(buildDeviceCardHtml(oneDrifted)).not.toContain('device-batch-tip')
    })

    it('renders no .device-batch-tip for a neverSynced device', () => {
      const device: DeviceView = {
        deviceId: 'abcdef12-3456-4789-8abc-def012345678',
        label: 'my-box',
        hostnameDisplay: null,
        platform: 'darwin',
        lastSeen: '2026-06-26T00:00:00.000Z',
        deviceState: 'fresh',
        neverSynced: true,
        skills: [],
      }
      expect(buildDeviceCardHtml(device)).not.toContain('device-batch-tip')
    })

    it('the .device-batch-tip is a sibling of the harness lists, never nested inside a <ul>/<li>', () => {
      const device: DeviceView = {
        deviceId: 'abcdef12-3456-4789-8abc-def012345678',
        label: 'my-box',
        hostnameDisplay: null,
        platform: 'darwin',
        lastSeen: '2026-06-26T00:00:00.000Z',
        deviceState: 'fresh',
        neverSynced: false,
        skills: [
          skill({ harness: 'zed', skillId: 'acme/one', state: 'drifted' }),
          skill({ harness: 'cursor', skillId: 'acme/two', state: 'drifted' }),
        ],
      }
      const html = buildDeviceCardHtml(device)
      const tipIndex = html.indexOf('class="device-batch-tip"')
      const firstUlIndex = html.indexOf('<ul')
      expect(tipIndex).toBeGreaterThan(-1)
      expect(firstUlIndex).toBeGreaterThan(-1)
      // The tip must appear before the first harness <ul> — i.e. it's a direct
      // child of <section>, not nested inside the harness-grouped skill list.
      expect(tipIndex).toBeLessThan(firstUlIndex)

      const liMatches = html.match(/<li class="skill-item">.*?<\/li>/gs) ?? []
      expect(liMatches.length).toBeGreaterThan(0)
      for (const li of liMatches) {
        expect(li).not.toContain('device-batch-tip')
      }
    })
  })
})
