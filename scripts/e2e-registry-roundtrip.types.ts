/**
 * e2e-registry-roundtrip.types.ts
 *
 * SMI-5922 — shared types between e2e-registry-roundtrip.ts and its
 * .mcp-live.ts companion.
 */

export interface ActorSession {
  userId: string
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export type RecordFn = (row: string, pass: boolean, detail?: string) => void
