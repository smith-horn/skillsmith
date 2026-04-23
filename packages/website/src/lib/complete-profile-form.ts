/**
 * complete-profile-form.ts
 *
 * SMI-4401 Wave 2 — DOM interaction layer for /complete-profile.astro.
 * Extracted to keep the .astro file under 500 lines (CLAUDE.md CI limit).
 *
 * Exports a single `initCompleteProfileForm()` function that wires the
 * `astro:page-load` handler. Keep this module free of Astro / SSR imports.
 */

import { getSupabaseClient } from './supabase-client'
import { validateNextParam } from './validate-next-redirect'
import {
  COPY,
  resolveSubhead,
  validateName,
  type CompleteProfileContext,
} from './complete-profile-copy'

export function initCompleteProfileForm(): void {
  document.addEventListener('astro:page-load', async () => {
    const ctx = (window as unknown as { __COMPLETE_PROFILE_CONTEXT__?: CompleteProfileContext })
      .__COMPLETE_PROFILE_CONTEXT__ ?? { source: '', next: '' }

    const main = document.getElementById('profile-main')
    const loading = document.getElementById('state-loading')
    const ready = document.getElementById('state-ready')
    const subhead = document.getElementById('profile-subhead')
    const githubHelper = document.getElementById('github-helper')
    const banner = document.getElementById('profile-error-banner')
    const form = document.getElementById('profile-form') as HTMLFormElement | null
    const firstInput = document.getElementById('first-name') as HTMLInputElement | null
    const lastInput = document.getElementById('last-name') as HTMLInputElement | null
    const firstErr = document.getElementById('first-name-error')
    const lastErr = document.getElementById('last-name-error')
    const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement | null
    const submitLabel = document.getElementById('submit-label')
    const submitSpinner = document.getElementById('submit-spinner')
    const toast = document.getElementById('profile-toast')

    if (
      !main ||
      !loading ||
      !ready ||
      !subhead ||
      !githubHelper ||
      !banner ||
      !form ||
      !firstInput ||
      !lastInput ||
      !firstErr ||
      !lastErr ||
      !submitBtn ||
      !submitLabel ||
      !submitSpinner ||
      !toast
    ) {
      return
    }

    // Resolve the effective next path client-side through the validator.
    // Precedence (H6): source=cli wins over bare next; else validated next; else no-params default.
    const validatedNext = validateNextParam(ctx.next, ctx.source)

    // Copy selection matrix per spec §5.1 — precedence: source=cli > bare next > no-params default.
    const subheadCopy = resolveSubhead(ctx, validatedNext)
    if (subheadCopy.text) {
      subhead.textContent = subheadCopy.text
    } else if (subheadCopy.html) {
      subhead.innerHTML = subheadCopy.html
    }

    const supabase = getSupabaseClient()
    if (!supabase) {
      showError(COPY.errorSupabaseInit)
      revealReady()
      return
    }

    const {
      data: { session },
    } = await supabase.auth.getSession()

    // No session: bounce to /login preserving context through next=.
    if (!session) {
      const preserved = new URLSearchParams()
      preserved.set('next', '/complete-profile')
      if (ctx.source) preserved.set('source', ctx.source)
      if (ctx.next) preserved.set('next_after', ctx.next)
      window.location.href = `/login?${preserved.toString()}`
      return
    }

    // Fetch existing profile for pre-fill.
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('first_name, last_name, tier')
      .eq('id', session.user.id)
      .single()

    if (profileError) {
      showError(COPY.errorProfileLoad)
      revealReady()
      return
    }

    // Pre-fill from existing profile (binds via `value=`, not `placeholder=`).
    if (profile?.first_name) firstInput.value = profile.first_name
    if (profile?.last_name) lastInput.value = profile.last_name

    // GitHub helper row (A-GH-3): only when session provider is github.
    const provider = session.user?.app_metadata?.provider
    if (provider === 'github' && (firstInput.value || lastInput.value)) {
      githubHelper.style.display = 'block'
    }

    revealReady()

    // Focus management: first empty field, else first field.
    if (!firstInput.value) {
      firstInput.focus()
    } else if (!lastInput.value) {
      lastInput.focus()
    } else {
      firstInput.focus()
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void handleSubmit()
    })

    function revealReady() {
      if (!main || !loading || !ready) return
      loading.style.display = 'none'
      ready.style.display = ''
      main.setAttribute('aria-busy', 'false')
    }

    function showError(html: string) {
      if (!banner) return
      banner.innerHTML = html
      banner.style.display = 'block'
      // Focus moves to the banner for screen-reader announce.
      try {
        banner.setAttribute('tabindex', '-1')
        ;(banner as HTMLElement).focus({ preventScroll: false })
      } catch {
        /* non-critical */
      }
    }

    function clearBanner() {
      if (!banner) return
      banner.style.display = 'none'
      banner.innerHTML = ''
    }

    function setFieldError(input: HTMLInputElement, errEl: HTMLElement, message: string | null) {
      if (message) {
        input.setAttribute('aria-invalid', 'true')
        errEl.textContent = message
        errEl.style.display = 'block'
      } else {
        input.removeAttribute('aria-invalid')
        errEl.textContent = ''
        errEl.style.display = 'none'
      }
    }

    function setSubmitting(isSubmitting: boolean) {
      if (!submitBtn || !submitLabel || !submitSpinner || !firstInput || !lastInput) return
      submitBtn.disabled = isSubmitting
      firstInput.disabled = isSubmitting
      lastInput.disabled = isSubmitting
      if (isSubmitting) {
        submitBtn.setAttribute('aria-busy', 'true')
        submitLabel.textContent = COPY.submittingLabel
        submitSpinner.style.display = 'inline-flex'
      } else {
        submitBtn.removeAttribute('aria-busy')
        submitLabel.textContent = COPY.submitLabel
        submitSpinner.style.display = 'none'
      }
    }

    async function handleSubmit() {
      if (!firstInput || !lastInput || !firstErr || !lastErr) return
      clearBanner()

      const firstName = firstInput.value.trim()
      const lastName = lastInput.value.trim()

      // Client-side validation (parity with Wave 1 SQL gate — M2).
      const firstMsg = validateName(firstName)
      const lastMsg = validateName(lastName)
      setFieldError(firstInput, firstErr, firstMsg)
      setFieldError(lastInput, lastErr, lastMsg)

      if (firstMsg) {
        firstInput.focus()
        return
      }
      if (lastMsg) {
        lastInput.focus()
        return
      }

      if (!supabase || !session) {
        showError(COPY.errorSessionLost)
        return
      }

      setSubmitting(true)

      try {
        // Step 2: update profile (RLS permits self-update per migration 011).
        const nowIso = new Date().toISOString()
        const { error: updateError } = await supabase
          .from('profiles')
          .update({
            first_name: firstName,
            last_name: lastName,
            profile_completed_at: nowIso,
          })
          .eq('id', session.user.id)

        if (updateError) {
          showError(COPY.errorGeneric)
          setSubmitting(false)
          return
        }

        // Step 3: issue license key via Wave 1 RPC.
        const { data: rpcData, error: rpcError } = await supabase.rpc(
          'issue_license_key_if_profile_complete',
          { user_id_input: session.user.id }
        )

        if (rpcError) {
          showError(COPY.errorKeyIssuance)
          setSubmitting(false)
          return
        }

        // Wave 1 RPC returns TABLE(issued_now BOOLEAN, reason TEXT). Unpack defensively.
        const row = Array.isArray(rpcData) ? rpcData[0] : rpcData
        const issuedNow = row?.issued_now === true
        const reason: string | null = row?.reason ?? null

        // Resolve RPC response: success branches fall through; error branches bail early.
        // - { issued_now: true, reason: null }    → first-time issuance (happy path)
        // - { issued_now: false, reason: 'already_issued' } → legacy user with an active key (happy path)
        // - { issued_now: false, reason: 'concurrent_call' } → race w/ retry webhook; probe keys
        // - { issued_now: false, reason: 'profile_incomplete' } → server-side re-validation failed
        const happyPath = issuedNow || reason === 'already_issued'
        if (!happyPath && reason === 'concurrent_call') {
          await new Promise((resolve) => setTimeout(resolve, 500))
          const { data: keys } = await supabase
            .from('license_keys')
            .select('status')
            .eq('user_id', session.user.id)
            .eq('status', 'active')
            .limit(1)
          if (!Array.isArray(keys) || keys.length === 0) {
            showError(COPY.errorConcurrent)
            setSubmitting(false)
            return
          }
        } else if (!happyPath && reason === 'profile_incomplete') {
          showError(COPY.errorProfileIncomplete)
          setSubmitting(false)
          return
        } else if (!happyPath) {
          showError(COPY.errorUnexpected)
          setSubmitting(false)
          return
        }

        // Step 4: tier-cache invalidation interim.
        // TODO(SMI-4405): once invalidate_tier_cache(user_id) RPC ships in Wave 3, call it here.
        // Wave 2 relies on the TIER_CACHE_TTL_SECONDS=60 env bump (Wave 1 spec §7 E1, H9) — no action required.

        // Step 5: success toast + redirect.
        if (toast) {
          toast.style.display = 'block'
        }
        setTimeout(() => {
          window.location.href = validatedNext
        }, 2000)
      } catch {
        showError(COPY.errorGeneric)
        setSubmitting(false)
      }
    }
  })
}
