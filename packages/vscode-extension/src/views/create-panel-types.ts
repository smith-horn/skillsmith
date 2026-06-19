/**
 * Message protocol for the Create Skill webview panel (SMI-5313 / GH #1454).
 *
 * Typed host <-> webview postMessage contract. The panel renders its static form
 * once and drives all subsequent state via these messages (it does NOT re-render
 * whole HTML like SkillDetailPanel). `CreateFormFields` lives in
 * utils/createSkill.helpers.ts so the utils/ module stays free of view imports
 * (keeps the import graph acyclic).
 */
import type { CreateFormFields } from '../utils/createSkill.helpers.js'

export type { CreateFormFields }

/** webview -> host */
export type CreatePanelInbound =
  | { command: 'validateName'; value: string }
  | { command: 'submit'; fields: CreateFormFields }
  | { command: 'cancel' }

/** host -> webview */
export type CreatePanelOutbound =
  /** Result of host-side validateSkillName for the live name field. */
  | { command: 'nameValidity'; valid: boolean; message?: string }
  /** Per-field validation failures on submit (panel stays open). */
  | { command: 'submitError'; errors: Partial<Record<keyof CreateFormFields, string>> }
  /** CLI started — disable the form, set aria-busy, show "Creating…". */
  | { command: 'creating' }
  /**
   * RAW CLI stdout/stderr chunk. The webview MUST append it via
   * `element.textContent += chunk` — NEVER `innerHTML` (raw CLI output is
   * untrusted HTML). The host never pre-escapes (that would double-escape).
   */
  | { command: 'cliOutput'; chunk: string }
  /** CLI failed / overwrite declined — re-enable the form, show an error banner. */
  | { command: 'createFailed'; message: string }
