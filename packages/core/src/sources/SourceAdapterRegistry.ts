/**
 * Source Adapter Registry
 * Manages registration and lifecycle of source adapters
 */

import type { ISourceAdapter } from './ISourceAdapter.js'
import type { SourceConfig, SourceHealth, SourceType } from './types.js'

/**
 * Factory function type for creating source adapters
 */
export type SourceAdapterFactory = (config: SourceConfig) => ISourceAdapter

/**
 * Registry entry for an adapter
 */
interface RegistryEntry {
  adapter: ISourceAdapter
  factory: SourceAdapterFactory
  initialized: boolean
}

/**
 * Registry for managing source adapters
 *
 * Features:
 * - Register adapter factories by type
 * - Create adapter instances from configuration
 * - Manage adapter lifecycle (initialize, dispose)
 * - Query adapters by type or ID
 *
 * @example
 * ```typescript
 * const registry = new SourceAdapterRegistry()
 *
 * // Register factory for GitHub adapters
 * registry.registerFactory('github', (config) => new GitHubSourceAdapter(config))
 *
 * // Create an adapter instance
 * const adapter = await registry.create({
 *   id: 'github-main',
 *   name: 'GitHub Main',
 *   type: 'github',
 *   baseUrl: 'https://api.github.com',
 *   enabled: true
 * })
 *
 * // Use the adapter
 * const results = await adapter.search({ topics: ['claude-skill'] })
 * ```
 */
export class SourceAdapterRegistry {
  private factories = new Map<SourceType | string, SourceAdapterFactory>()
  private adapters = new Map<string, RegistryEntry>()

  /**
   * Register a factory for creating adapters of a specific type
   *
   * @param type - Source type identifier
   * @param factory - Factory function to create adapters
   */
  registerFactory(type: SourceType | string, factory: SourceAdapterFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`Factory already registered for type: ${type}`)
    }
    this.factories.set(type, factory)
  }

  /**
   * Unregister a factory
   *
   * @param type - Source type to unregister
   */
  unregisterFactory(type: SourceType | string): void {
    this.factories.delete(type)
  }

  /**
   * Check if a factory is registered for a type
   *
   * @param type - Source type to check
   */
  hasFactory(type: SourceType | string): boolean {
    return this.factories.has(type)
  }

  /**
   * Get all registered factory types
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.factories.keys())
  }

  /**
   * Create and register an adapter instance
   *
   * @param config - Adapter configuration
   * @param autoInitialize - Whether to initialize immediately (default: true)
   * @returns The created adapter
   */
  async create(config: SourceConfig, autoInitialize = true): Promise<ISourceAdapter> {
    if (this.adapters.has(config.id)) {
      throw new Error(`Adapter already exists with id: ${config.id}`)
    }

    const factory = this.factories.get(config.type)
    if (!factory) {
      throw new Error(`No factory registered for type: ${config.type}`)
    }

    const adapter = factory(config)
    const entry: RegistryEntry = {
      adapter,
      factory,
      initialized: false,
    }

    this.adapters.set(config.id, entry)

    if (autoInitialize) {
      await adapter.initialize()
      entry.initialized = true
    }

    return adapter
  }

  /**
   * Get an adapter by ID
   *
   * @param id - Adapter ID
   * @returns The adapter, or undefined if not found
   */
  get(id: string): ISourceAdapter | undefined {
    return this.adapters.get(id)?.adapter
  }

  /**
   * Get an adapter by ID, throwing if not found
   *
   * @param id - Adapter ID
   * @returns The adapter
   * @throws Error if adapter not found
   */
  getOrThrow(id: string): ISourceAdapter {
    const adapter = this.get(id)
    if (!adapter) {
      throw new Error(`Adapter not found: ${id}`)
    }
    return adapter
  }

  /**
   * Get all adapters of a specific type
   *
   * @param type - Source type to filter by
   * @returns Array of matching adapters
   */
  getByType(type: SourceType | string): ISourceAdapter[] {
    return Array.from(this.adapters.values())
      .filter((entry) => entry.adapter.type === type)
      .map((entry) => entry.adapter)
  }

  /**
   * Get all enabled adapters
   */
  getEnabled(): ISourceAdapter[] {
    return Array.from(this.adapters.values())
      .filter((entry) => entry.adapter.config.enabled)
      .map((entry) => entry.adapter)
  }

  /**
   * Get all registered adapters
   */
  getAll(): ISourceAdapter[] {
    return Array.from(this.adapters.values()).map((entry) => entry.adapter)
  }

  /**
   * Check if an adapter exists
   *
   * @param id - Adapter ID to check
   */
  has(id: string): boolean {
    return this.adapters.has(id)
  }

  /**
   * Initialize an adapter if not already initialized
   *
   * @param id - Adapter ID
   */
  async initialize(id: string): Promise<void> {
    const entry = this.adapters.get(id)
    if (!entry) {
      throw new Error(`Adapter not found: ${id}`)
    }

    if (!entry.initialized) {
      await entry.adapter.initialize()
      entry.initialized = true
    }
  }

  /**
   * Initialize all registered adapters
   */
  async initializeAll(): Promise<void> {
    const promises = Array.from(this.adapters.entries()).map(async ([id, entry]) => {
      if (!entry.initialized) {
        await entry.adapter.initialize()
        entry.initialized = true
      }
    })
    await Promise.all(promises)
  }

  /**
   * Remove and dispose an adapter
   *
   * @param id - Adapter ID to remove
   */
  async remove(id: string): Promise<void> {
    const entry = this.adapters.get(id)
    if (entry) {
      await entry.adapter.dispose()
      this.adapters.delete(id)
    }
  }

  /**
   * Remove and dispose all adapters
   */
  async removeAll(): Promise<void> {
    const promises = Array.from(this.adapters.values()).map((entry) => entry.adapter.dispose())
    await Promise.all(promises)
    this.adapters.clear()
  }

  /**
   * Check health of all enabled adapters
   *
   * @returns Map of adapter ID to health status
   */
  async checkHealthAll(): Promise<Map<string, SourceHealth>> {
    const results = new Map<string, SourceHealth>()

    const promises = this.getEnabled().map(async (adapter) => {
      const health = await adapter.checkHealth()
      results.set(adapter.id, health)
    })

    await Promise.all(promises)
    return results
  }

  /**
   * Get registry statistics
   */
  getStats(): RegistryStats {
    const adapters = Array.from(this.adapters.values())
    return {
      totalFactories: this.factories.size,
      totalAdapters: adapters.length,
      enabledAdapters: adapters.filter((e) => e.adapter.config.enabled).length,
      initializedAdapters: adapters.filter((e) => e.initialized).length,
      adaptersByType: this.countByType(),
    }
  }

  private countByType(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const entry of this.adapters.values()) {
      const type = entry.adapter.type
      counts[type] = (counts[type] ?? 0) + 1
    }
    return counts
  }
}

/**
 * Registry statistics
 */
export interface RegistryStats {
  totalFactories: number
  totalAdapters: number
  enabledAdapters: number
  initializedAdapters: number
  adaptersByType: Record<string, number>
}

/**
 * Default global registry instance
 */
export const defaultRegistry = new SourceAdapterRegistry()
