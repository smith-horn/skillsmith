/**
 * Authentication client for Skillsmith
 *
 * SMI-1168: User registration and login
 * SMI-1169: Email verification flow
 *
 * Uses Supabase Auth for identity management.
 */

import { createClient, type SupabaseClient, type User, type Session } from '@supabase/supabase-js'
import type {
  AuthUser,
  AuthSession,
  LoginCredentials,
  RegisterCredentials,
  AuthResult,
} from '../types/auth'

// Environment variables (set in Astro config or .env)
const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL || ''
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || ''

// Singleton client instance
let supabaseClient: SupabaseClient | null = null

/**
 * Get or create the Supabase client
 * Uses singleton pattern for client-side usage
 */
export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Supabase URL and Anon Key must be configured')
    }
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  }
  return supabaseClient
}

/**
 * Create a new Supabase client for server-side usage
 * Does not persist session
 */
export function createServerClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase URL and Anon Key must be configured')
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

/**
 * Transform Supabase User to AuthUser
 */
function transformUser(user: User | null): AuthUser | null {
  if (!user) return null
  return {
    id: user.id,
    email: user.email || '',
    emailVerified: user.email_confirmed_at !== null,
    fullName: user.user_metadata?.full_name || null,
    avatarUrl: user.user_metadata?.avatar_url || null,
    tier: user.user_metadata?.tier || 'community',
    createdAt: user.created_at,
  }
}

/**
 * Transform Supabase Session to AuthSession
 */
function transformSession(session: Session | null): AuthSession | null {
  if (!session) return null
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at || 0,
    user: transformUser(session.user),
  }
}

/**
 * Register a new user account
 *
 * @param credentials - Email, password, and optional full name
 * @returns AuthResult with user data or error
 */
export async function register(credentials: RegisterCredentials): Promise<AuthResult> {
  const client = getSupabaseClient()

  const { data, error } = await client.auth.signUp({
    email: credentials.email,
    password: credentials.password,
    options: {
      data: {
        full_name: credentials.fullName || '',
      },
      emailRedirectTo: `${window.location.origin}/auth/callback`,
    },
  })

  if (error) {
    return {
      success: false,
      error: error.message,
    }
  }

  // Check if email confirmation is required
  if (data.user && !data.user.email_confirmed_at) {
    return {
      success: true,
      user: transformUser(data.user),
      session: transformSession(data.session),
      requiresVerification: true,
      message: 'Please check your email to verify your account.',
    }
  }

  return {
    success: true,
    user: transformUser(data.user),
    session: transformSession(data.session),
  }
}

/**
 * Login with email and password
 *
 * @param credentials - Email and password
 * @returns AuthResult with session or error
 */
export async function login(credentials: LoginCredentials): Promise<AuthResult> {
  const client = getSupabaseClient()

  const { data, error } = await client.auth.signInWithPassword({
    email: credentials.email,
    password: credentials.password,
  })

  if (error) {
    // Handle specific error cases
    if (error.message.includes('Email not confirmed')) {
      return {
        success: false,
        error: 'Please verify your email before logging in.',
        requiresVerification: true,
      }
    }
    if (error.message.includes('Invalid login credentials')) {
      return {
        success: false,
        error: 'Invalid email or password.',
      }
    }
    return {
      success: false,
      error: error.message,
    }
  }

  return {
    success: true,
    user: transformUser(data.user),
    session: transformSession(data.session),
  }
}

/**
 * Logout the current user
 */
export async function logout(): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseClient()

  const { error } = await client.auth.signOut()

  if (error) {
    return {
      success: false,
      error: error.message,
    }
  }

  return { success: true }
}

/**
 * Get the current session
 */
export async function getSession(): Promise<AuthSession | null> {
  const client = getSupabaseClient()

  const { data } = await client.auth.getSession()

  return transformSession(data.session)
}

/**
 * Get the current user
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const client = getSupabaseClient()

  const { data } = await client.auth.getUser()

  return transformUser(data.user)
}

/**
 * Refresh the current session
 */
export async function refreshSession(): Promise<AuthSession | null> {
  const client = getSupabaseClient()

  const { data, error } = await client.auth.refreshSession()

  if (error) {
    console.error('Session refresh failed:', error.message)
    return null
  }

  return transformSession(data.session)
}

/**
 * Request password reset email
 *
 * @param email - User's email address
 */
export async function requestPasswordReset(
  email: string
): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseClient()

  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/auth/reset-password`,
  })

  if (error) {
    return {
      success: false,
      error: error.message,
    }
  }

  return { success: true }
}

/**
 * Update user's password
 *
 * @param newPassword - New password
 */
export async function updatePassword(
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseClient()

  const { error } = await client.auth.updateUser({
    password: newPassword,
  })

  if (error) {
    return {
      success: false,
      error: error.message,
    }
  }

  return { success: true }
}

/**
 * Resend email verification
 *
 * @param email - User's email address
 */
export async function resendVerificationEmail(
  email: string
): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseClient()

  const { error } = await client.auth.resend({
    type: 'signup',
    email,
    options: {
      emailRedirectTo: `${window.location.origin}/auth/callback`,
    },
  })

  if (error) {
    return {
      success: false,
      error: error.message,
    }
  }

  return { success: true }
}

/**
 * Subscribe to auth state changes
 *
 * @param callback - Function called when auth state changes
 * @returns Unsubscribe function
 */
export function onAuthStateChange(callback: (session: AuthSession | null) => void): {
  unsubscribe: () => void
} {
  const client = getSupabaseClient()

  const {
    data: { subscription },
  } = client.auth.onAuthStateChange((_event, session) => {
    callback(transformSession(session))
  })

  return {
    unsubscribe: () => subscription.unsubscribe(),
  }
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
  const session = await getSession()
  return session !== null
}

/**
 * Get user's profile from database
 */
export async function getUserProfile(): Promise<{
  tier: string
  subscription?: {
    id: string
    status: string
    currentPeriodEnd: string
  } | null
} | null> {
  const client = getSupabaseClient()

  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) return null

  // Get profile with subscription
  const { data: profile } = await client.from('profiles').select('tier').eq('id', user.id).single()

  if (!profile) return null

  // Get active subscription
  const { data: subscription } = await client.rpc('get_user_subscription', { user_uuid: user.id })

  return {
    tier: profile.tier,
    subscription: subscription?.[0]
      ? {
          id: subscription[0].subscription_id,
          status: subscription[0].status,
          currentPeriodEnd: subscription[0].current_period_end,
        }
      : null,
  }
}
