/**
 * RawUrlSourceAdapter Security Tests (SMI-721)
 *
 * Tests SSRF prevention in RawUrlSourceAdapter
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { RawUrlSourceAdapter, type RawUrlSourceConfig } from '../src/sources/index.js'

describe('RawUrlSourceAdapter SSRF Prevention (SMI-721)', () => {
  let adapter: RawUrlSourceAdapter
  const baseConfig: RawUrlSourceConfig = {
    id: 'test-adapter',
    name: 'Test Adapter',
    type: 'raw-url',
    baseUrl: 'https://example.com',
    enabled: true,
    timeout: 1000, // Short timeout for tests
  }

  beforeEach(() => {
    adapter = new RawUrlSourceAdapter(baseConfig)
  })

  describe('Protocol Validation', () => {
    it('should block file:// protocol when provided as http-prefixed path', async () => {
      // Note: Adapter only uses path as-is when it starts with 'http'
      // So we test with a URL that starts with http but would redirect to file://
      // The actual file:// protocol would be blocked at validateUrl level
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://localhost/redirect?to=file:///etc/passwd',
        })
      ).rejects.toThrow('Access to localhost is blocked')
    })

    it('should only use http/https URLs from path parameter', async () => {
      // When path doesn't start with 'http', it falls back to base URL construction
      // This is safe because base URL is validated separately
      const result = adapter.fetchSkillContent({
        owner: 'test',
        repo: 'test-skill',
        path: 'file:///etc/passwd', // Will be ignored, base URL used
      })
      // Should fail with 404 from example.com, not file access
      await expect(result).rejects.toThrow('Failed to fetch skill content')
    })
  })

  describe('Localhost Blocking', () => {
    it('should block localhost', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://localhost/admin',
        })
      ).rejects.toThrow('Access to localhost is blocked: localhost')
    })

    it('should block localhost with port', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://localhost:8080/admin',
        })
      ).rejects.toThrow('Access to localhost is blocked: localhost')
    })

    it('should block 127.0.0.1', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://127.0.0.1/admin',
        })
      ).rejects.toThrow('Access to private/internal network blocked: 127.0.0.1')
    })

    it('should block 127.x.x.x range', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://127.255.255.255/admin',
        })
      ).rejects.toThrow('Access to private/internal network blocked: 127.255.255.255')
    })

    it('should block 0.0.0.0', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://0.0.0.0/admin',
        })
      ).rejects.toThrow('Access to localhost is blocked: 0.0.0.0')
    })
  })

  describe('Private IP Range Blocking', () => {
    describe('10.0.0.0/8 (Class A Private)', () => {
      it('should block 10.0.0.1', async () => {
        await expect(
          adapter.fetchSkillContent({
            owner: 'test',
            repo: 'test-skill',
            path: 'http://10.0.0.1/metadata',
          })
        ).rejects.toThrow('Access to private/internal network blocked: 10.0.0.1')
      })

      it('should block 10.255.255.255', async () => {
        await expect(
          adapter.fetchSkillContent({
            owner: 'test',
            repo: 'test-skill',
            path: 'http://10.255.255.255/api',
          })
        ).rejects.toThrow('Access to private/internal network blocked: 10.255.255.255')
      })
    })

    describe('172.16.0.0/12 (Class B Private)', () => {
      it('should block 172.16.0.1', async () => {
        await expect(
          adapter.fetchSkillContent({
            owner: 'test',
            repo: 'test-skill',
            path: 'http://172.16.0.1/internal',
          })
        ).rejects.toThrow('Access to private/internal network blocked: 172.16.0.1')
      })

      it('should block 172.31.255.255', async () => {
        await expect(
          adapter.fetchSkillContent({
            owner: 'test',
            repo: 'test-skill',
            path: 'http://172.31.255.255/secret',
          })
        ).rejects.toThrow('Access to private/internal network blocked: 172.31.255.255')
      })
    })

    describe('192.168.0.0/16 (Class C Private)', () => {
      it('should block 192.168.0.1', async () => {
        await expect(
          adapter.fetchSkillContent({
            owner: 'test',
            repo: 'test-skill',
            path: 'http://192.168.0.1/router',
          })
        ).rejects.toThrow('Access to private/internal network blocked: 192.168.0.1')
      })

      it('should block 192.168.255.255', async () => {
        await expect(
          adapter.fetchSkillContent({
            owner: 'test',
            repo: 'test-skill',
            path: 'http://192.168.255.255/config',
          })
        ).rejects.toThrow('Access to private/internal network blocked: 192.168.255.255')
      })
    })
  })

  describe('Link-Local Address Blocking', () => {
    it('should block 169.254.0.1 (AWS metadata endpoint range)', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://169.254.0.1/metadata',
        })
      ).rejects.toThrow('Access to private/internal network blocked: 169.254.0.1')
    })

    it('should block 169.254.169.254 (AWS/GCP/Azure metadata endpoint)', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://169.254.169.254/latest/meta-data/',
        })
      ).rejects.toThrow('Access to private/internal network blocked: 169.254.169.254')
    })

    it('should block 169.254.255.255', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://169.254.255.255/secrets',
        })
      ).rejects.toThrow('Access to private/internal network blocked: 169.254.255.255')
    })
  })

  describe('Zero Network Blocking', () => {
    it('should block 0.0.0.1', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://0.0.0.1/test',
        })
      ).rejects.toThrow('Access to private/internal network blocked: 0.0.0.1')
    })
  })

  describe('Valid Public URLs', () => {
    // These tests verify that valid public URLs are not blocked by SSRF checks
    // They will still fail due to network issues but should not throw SSRF errors

    it('should allow github.com', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'https://github.com/test/repo/SKILL.md',
        })
      ).rejects.not.toThrow('Access to private/internal network blocked')
    })

    it('should allow public IP addresses', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'https://8.8.8.8/test',
        })
      ).rejects.not.toThrow('Access to private/internal network blocked')
    })

    it('should allow https protocol', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'https://example.com/skill.md',
        })
      ).rejects.not.toThrow('Invalid protocol')
    })
  })

  describe('Health Check SSRF Prevention', () => {
    it('should fail health check for private IPs', async () => {
      const privateAdapter = new RawUrlSourceAdapter({
        ...baseConfig,
        baseUrl: 'http://192.168.1.1',
      })

      const health = await privateAdapter.checkHealth()
      expect(health.healthy).toBe(false)
      // Error message is sanitized to not leak internal details
      expect(health.error).toBeDefined()
    })

    it('should fail health check for localhost', async () => {
      const localhostAdapter = new RawUrlSourceAdapter({
        ...baseConfig,
        baseUrl: 'http://localhost:3000',
      })

      const health = await localhostAdapter.checkHealth()
      expect(health.healthy).toBe(false)
      expect(health.error).toBeDefined()
    })

    it('should fail health check for cloud metadata endpoints', async () => {
      const metadataAdapter = new RawUrlSourceAdapter({
        ...baseConfig,
        baseUrl: 'http://169.254.169.254',
      })

      const health = await metadataAdapter.checkHealth()
      expect(health.healthy).toBe(false)
      expect(health.error).toBeDefined()
    })
  })

  describe('Registry URL SSRF Prevention', () => {
    it('should not load private registry URLs during initialization', async () => {
      const privateRegistryAdapter = new RawUrlSourceAdapter({
        ...baseConfig,
        registryUrl: 'http://10.0.0.1/registry.json',
      })

      // Initialize should not throw but should log warning and not load registry
      await expect(privateRegistryAdapter.initialize()).resolves.not.toThrow()

      // The registry should not have been loaded
      expect(privateRegistryAdapter.getSkillUrls()).toHaveLength(0)
    })

    it('should not load localhost registry URLs during initialization', async () => {
      const localhostRegistryAdapter = new RawUrlSourceAdapter({
        ...baseConfig,
        registryUrl: 'http://localhost:8080/registry.json',
      })

      await expect(localhostRegistryAdapter.initialize()).resolves.not.toThrow()
      expect(localhostRegistryAdapter.getSkillUrls()).toHaveLength(0)
    })

    it('should not load metadata endpoint registry URLs during initialization', async () => {
      const metadataRegistryAdapter = new RawUrlSourceAdapter({
        ...baseConfig,
        registryUrl: 'http://169.254.169.254/registry.json',
      })

      await expect(metadataRegistryAdapter.initialize()).resolves.not.toThrow()
      expect(metadataRegistryAdapter.getSkillUrls()).toHaveLength(0)
    })
  })

  describe('Edge Cases', () => {
    it('should block internal IPs with ports', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://192.168.1.1:8080/api',
        })
      ).rejects.toThrow('Access to private/internal network blocked')
    })

    it('should block internal IPs with paths', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://10.0.0.1/very/long/path/to/resource',
        })
      ).rejects.toThrow('Access to private/internal network blocked')
    })

    it('should block internal IPs with query strings', async () => {
      await expect(
        adapter.fetchSkillContent({
          owner: 'test',
          repo: 'test-skill',
          path: 'http://172.16.0.1/api?secret=token',
        })
      ).rejects.toThrow('Access to private/internal network blocked')
    })
  })
})
