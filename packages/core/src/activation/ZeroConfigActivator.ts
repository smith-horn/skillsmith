/**
 * @fileoverview Zero-Config Skill Activation System
 * @module @skillsmith/core/activation/ZeroConfigActivator
 * @see Phase 4: Trigger System Architecture - Zero-Config Activation
 *
 * Enables activation of skills with configuration requirements by:
 * - Injecting safe default values
 * - Deferring configuration until first use
 * - Providing configuration prompts on demand
 *
 * @example
 * const activator = new ZeroConfigActivator(manager);
 * const result = await activator.activate('community/api-client');
 * // Skill is activated with defaults, user can configure later
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { createLogger } from '../utils/logger.js'
import type { ActivationManager, ActivationOptions, ActivationResult } from './ActivationManager.js'

const log = createLogger('ZeroConfigActivator')

/**
 * Skill configuration schema
 */
export interface SkillConfigSchema {
  /** Configuration is required for this skill */
  config_required: boolean
  /** Allow deferred configuration */
  config_defer: boolean
  /** Default configuration values */
  config_defaults?: Record<string, unknown>
  /** Configuration field definitions */
  config_fields?: ConfigField[]
}

/**
 * Configuration field definition
 */
export interface ConfigField {
  /** Field name */
  name: string
  /** Field type */
  type: 'string' | 'number' | 'boolean' | 'url' | 'secret'
  /** Field description */
  description: string
  /** Whether field is required */
  required: boolean
  /** Default value */
  default?: unknown
  /** Validation pattern (for strings) */
  pattern?: string
}

/**
 * Configuration status
 */
export interface ConfigStatus {
  /** Whether skill has required configuration */
  has_config: boolean
  /** Whether using default values */
  using_defaults: boolean
  /** Whether user has customized config */
  user_configured: boolean
  /** Configuration fields */
  fields: ConfigField[]
  /** Missing required fields */
  missing_required: string[]
}

/**
 * Zero-config activation options
 */
export interface ZeroConfigOptions extends Omit<ActivationOptions, 'auto_configure' | 'skill_id'> {
  /** Skip configuration entirely (use defaults) */
  skip_config?: boolean
}

/**
 * ZeroConfigActivator - Activates skills with automatic default configuration
 *
 * Handles skills that require configuration by:
 * 1. Checking if defaults are available
 * 2. Injecting defaults during installation
 * 3. Marking skill as "needs configuration"
 * 4. Providing configure endpoint for customization
 */
export class ZeroConfigActivator {
  constructor(private readonly activationManager: ActivationManager) {
    log.info('ZeroConfigActivator initialized')
  }

  /**
   * Activate a skill with zero-config defaults
   *
   * @param skillId - Skill ID to activate
   * @param options - Activation options
   * @returns Activation result with configuration status
   */
  async activate(
    skillId: string,
    options: ZeroConfigOptions = {}
  ): Promise<ActivationResult & { config_status?: ConfigStatus }> {
    log.info('Zero-config activation requested', { skillId })

    // Get skill configuration schema (in production, fetch from registry)
    const configSchema = await this.getConfigSchema(skillId)

    // Check if configuration is required
    if (!configSchema.config_required) {
      // No config needed, activate normally
      log.debug('Skill does not require configuration', { skillId })
      return this.activationManager.activateSkill({
        ...options,
        skill_id: skillId,
      })
    }

    // Check if config can be deferred
    if (!configSchema.config_defer) {
      // Config required upfront, cannot use zero-config
      log.warn('Skill requires configuration upfront', { skillId })
      return {
        success: false,
        skill_id: skillId,
        activation_time_ms: 0,
        requires_restart: false,
        error: 'Configuration required. Run skill_configure first.',
      }
    }

    // Activate with defaults
    log.info('Activating with default configuration', { skillId })
    const result = await this.activateWithDefaults(skillId, configSchema, options)

    // Get configuration status
    const configStatus = await this.getConfigStatus(skillId, configSchema)

    return {
      ...result,
      config_status: configStatus,
    }
  }

  /**
   * Activate skill with default configuration values
   */
  private async activateWithDefaults(
    skillId: string,
    configSchema: SkillConfigSchema,
    options: ZeroConfigOptions
  ): Promise<ActivationResult> {
    // Activate the skill first
    const result = await this.activationManager.activateSkill({
      ...options,
      skill_id: skillId,
      auto_configure: true,
    })

    if (!result.success || !result.install_path) {
      return result
    }

    // Inject default configuration
    try {
      await this.injectDefaultConfig(result.install_path, configSchema)
      log.info('Default configuration injected', { skillId })
    } catch (error) {
      log.error('Failed to inject default config', error instanceof Error ? error : undefined, {
        skillId,
      })
      // Don't fail activation, just log warning
    }

    return result
  }

  /**
   * Inject default configuration into skill directory
   */
  private async injectDefaultConfig(
    installPath: string,
    configSchema: SkillConfigSchema
  ): Promise<void> {
    const configPath = path.join(installPath, 'config.json')

    // Build config from defaults and field definitions
    const config: Record<string, unknown> = {
      ...configSchema.config_defaults,
    }

    // Add defaults from field definitions
    if (configSchema.config_fields) {
      for (const field of configSchema.config_fields) {
        if (field.default !== undefined && config[field.name] === undefined) {
          config[field.name] = field.default
        }
      }
    }

    // Add metadata
    const configWithMeta = {
      ...config,
      _meta: {
        using_defaults: true,
        configured_at: new Date().toISOString(),
        source: 'zero-config',
      },
    }

    // Write config file
    await fs.writeFile(configPath, JSON.stringify(configWithMeta, null, 2), 'utf-8')

    log.debug('Config file written', { configPath })
  }

  /**
   * Get configuration schema for a skill
   *
   * In production, this would fetch from skill registry
   * For now, returns mock schema based on skill ID
   */
  private async getConfigSchema(skillId: string): Promise<SkillConfigSchema> {
    // Mock schemas for demo skills
    const mockSchemas: Record<string, SkillConfigSchema> = {
      'community/api-client': {
        config_required: true,
        config_defer: true,
        config_defaults: {
          api_endpoint: 'https://api.example.com',
          timeout_ms: 5000,
          retry_attempts: 3,
        },
        config_fields: [
          {
            name: 'api_endpoint',
            type: 'url',
            description: 'API base endpoint URL',
            required: true,
            default: 'https://api.example.com',
          },
          {
            name: 'api_key',
            type: 'secret',
            description: 'API authentication key',
            required: true,
          },
          {
            name: 'timeout_ms',
            type: 'number',
            description: 'Request timeout in milliseconds',
            required: false,
            default: 5000,
          },
          {
            name: 'retry_attempts',
            type: 'number',
            description: 'Number of retry attempts on failure',
            required: false,
            default: 3,
          },
        ],
      },
    }

    // Return mock schema or default
    return (
      mockSchemas[skillId] || {
        config_required: false,
        config_defer: false,
      }
    )
  }

  /**
   * Get current configuration status for a skill
   */
  async getConfigStatus(skillId: string, configSchema?: SkillConfigSchema): Promise<ConfigStatus> {
    const schema = configSchema || (await this.getConfigSchema(skillId))

    if (!schema.config_required) {
      return {
        has_config: false,
        using_defaults: false,
        user_configured: false,
        fields: [],
        missing_required: [],
      }
    }

    // In production, read actual config file
    // For now, return status based on schema
    const requiredFields = schema.config_fields?.filter((f) => f.required) || []
    const missingRequired = requiredFields
      .filter((f) => !schema.config_defaults?.[f.name])
      .map((f) => f.name)

    return {
      has_config: true,
      using_defaults: true,
      user_configured: false,
      fields: schema.config_fields || [],
      missing_required: missingRequired,
    }
  }

  /**
   * Check if a skill needs configuration
   *
   * @param skillId - Skill ID to check
   * @returns Whether skill needs user configuration
   */
  async needsConfiguration(skillId: string): Promise<boolean> {
    const status = await this.getConfigStatus(skillId)
    return status.has_config && !status.user_configured && status.missing_required.length > 0
  }

  /**
   * Generate configuration prompt for user
   *
   * @param skillId - Skill ID
   * @returns Configuration instructions
   */
  async getConfigurationPrompt(skillId: string): Promise<string> {
    const configSchema = await this.getConfigSchema(skillId)

    if (!configSchema.config_required) {
      return 'This skill does not require configuration.'
    }

    const status = await this.getConfigStatus(skillId, configSchema)

    if (status.missing_required.length === 0) {
      return 'Skill is fully configured with defaults. You can customize it if needed.'
    }

    const lines: string[] = []
    lines.push(`\n=== Configuration Required: ${skillId} ===\n`)
    lines.push('The following fields need configuration:\n')

    for (const fieldName of status.missing_required) {
      const field = status.fields.find((f) => f.name === fieldName)
      if (field) {
        lines.push(`  ${field.name} (${field.type})`)
        lines.push(`    ${field.description}`)
        if (field.default) {
          lines.push(`    Default: ${field.default}`)
        }
        lines.push('')
      }
    }

    lines.push('Run: skill_configure ' + skillId)

    return lines.join('\n')
  }
}

export default ZeroConfigActivator
