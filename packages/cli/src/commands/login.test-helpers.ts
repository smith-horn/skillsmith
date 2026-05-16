/**
 * @fileoverview Shared test helpers for the `login` command test files.
 *
 * Extracted so both `login.test.ts` and `login.post-login-sync.test.ts` share
 * the device-code fetch stub without duplication (and to keep each test file
 * under the 500-line limit).
 */
import { vi } from 'vitest'

/**
 * Stub `global.fetch` to simulate a successful device-code exchange: the
 * `auth-device-code` request succeeds, the first `auth-device-token` poll
 * returns 428 (authorization pending), and the second poll returns tokens.
 */
export function mockDeviceCodeSuccess(): void {
  let callCount = 0
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if ((url as string).includes('auth-device-code')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            device_code: 'dc_test',
            user_code: 'BCDFGHJK',
            verification_uri: 'https://skillsmith.app/device',
            expires_in: 900,
            interval: 5,
          }),
      })
    }
    // auth-device-token
    callCount++
    if (callCount === 1) {
      return Promise.resolve({ ok: false, status: 428, json: () => Promise.resolve({}) })
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'jwt.access',
          refresh_token: 'jwt.refresh',
          expires_in: 3600,
        }),
    })
  }) as typeof fetch
}
