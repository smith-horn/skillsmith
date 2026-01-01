/**
 * @fileoverview Skill Activation System
 * @module @skillsmith/core/activation
 * @see Phase 4: Trigger System Architecture
 */

export {
  ActivationManager,
  type ActivationOptions,
  type ActivationResult,
} from './ActivationManager.js'

export {
  ZeroConfigActivator,
  type SkillConfigSchema,
  type ConfigField,
  type ConfigStatus,
  type ZeroConfigOptions,
} from './ZeroConfigActivator.js'
