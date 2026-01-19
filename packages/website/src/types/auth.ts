/**
 * Authentication type definitions
 *
 * SMI-1168: User registration and login
 */

/**
 * Authenticated user information
 */
export interface AuthUser {
  id: string
  email: string
  emailVerified: boolean
  fullName: string | null
  avatarUrl: string | null
  tier: 'community' | 'individual' | 'team' | 'enterprise'
  createdAt: string
}

/**
 * Authentication session
 */
export interface AuthSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  user: AuthUser | null
}

/**
 * Login credentials
 */
export interface LoginCredentials {
  email: string
  password: string
}

/**
 * Registration credentials
 */
export interface RegisterCredentials {
  email: string
  password: string
  fullName?: string
}

/**
 * Result of authentication operation
 */
export interface AuthResult {
  success: boolean
  user?: AuthUser | null
  session?: AuthSession | null
  error?: string
  message?: string
  requiresVerification?: boolean
}

/**
 * User profile with subscription info
 */
export interface UserProfile {
  id: string
  email: string
  fullName: string | null
  company: string | null
  avatarUrl: string | null
  tier: 'community' | 'individual' | 'team' | 'enterprise'
  role: 'user' | 'admin' | 'team_admin' | 'super_admin'
  emailVerified: boolean
  createdAt: string
}

/**
 * Subscription information
 */
export interface Subscription {
  id: string
  tier: 'individual' | 'team' | 'enterprise'
  status: 'active' | 'canceled' | 'past_due' | 'paused' | 'trialing' | 'incomplete'
  billingPeriod: 'monthly' | 'annual'
  seatCount: number
  currentPeriodStart: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
}

/**
 * License key information
 */
export interface LicenseKey {
  id: string
  keyPrefix: string
  name: string
  tier: 'community' | 'individual' | 'team' | 'enterprise'
  status: 'active' | 'revoked' | 'expired'
  lastUsedAt: string | null
  usageCount: number
  expiresAt: string | null
  createdAt: string
}

/**
 * Team information
 */
export interface Team {
  id: string
  name: string
  slug: string | null
  maxMembers: number
  memberCount: number
  createdAt: string
}

/**
 * Team member information
 */
export interface TeamMember {
  id: string
  userId: string
  email: string
  fullName: string | null
  role: 'owner' | 'admin' | 'member'
  joinedAt: string | null
}
