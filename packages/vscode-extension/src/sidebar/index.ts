/**
 * Sidebar module exports
 * @module sidebar
 */
export { SkillTreeItem, type SkillItemData, type TrustTier } from './SkillTreeItem.js'
export { SkillTreeDataProvider } from './SkillTreeDataProvider.js'
export {
  type ExtensionTrustTier,
  normalizeTrustTier,
  getTrustTierIcon,
  getTrustTierEmoji,
  getTrustTierLabel,
  getTrustTierCodicon,
} from './trustTier.js'
