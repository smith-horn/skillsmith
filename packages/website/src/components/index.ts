// Shared components for Skillsmith marketing website
// Import these components in Astro pages as needed

// Re-export component paths for documentation
export const components = {
  Header: './Header.astro',
  Footer: './Footer.astro',
  Button: './Button.astro',
  Card: './Card.astro',
  Badge: './Badge.astro',
  SkillCard: './SkillCard.astro',
  PricingCard: './PricingCard.astro',
  FeatureCard: './FeatureCard.astro',
  // Auth components (SMI-1715)
  LoginButton: './auth/LoginButton.astro',
  UserMenu: './auth/UserMenu.astro',
} as const

// Type exports for TypeScript support
export type { TrustTier } from './types'
