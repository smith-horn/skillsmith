/**
 * HTML generation for the Create Skill webview panel (SMI-5313 / GH #1454).
 *
 * Single static document rendered once; all subsequent state is driven by the
 * typed postMessage protocol (create-panel-types.ts). No user data is present at
 * first render, so there is nothing dynamic to escape here — escapeHtml is used
 * on every interpolated literal anyway (defense-in-depth, per the design).
 */

import { escapeHtml } from '../utils/security.js'
import { getCreateStyles } from './create-panel-styles.js'
import { getCreateScript } from './create-panel-script.js'

/** A skill-type radio option with its human description (from the design doc). */
interface TypeOption {
  value: 'basic' | 'intermediate' | 'advanced'
  label: string
  description: string
}

const TYPE_OPTIONS: readonly TypeOption[] = [
  { value: 'basic', label: 'Basic', description: 'Minimal skill scaffold (SKILL.md + README)' },
  {
    value: 'intermediate',
    label: 'Intermediate',
    description: 'Adds CHANGELOG and examples',
  },
  {
    value: 'advanced',
    label: 'Advanced',
    description: 'Full layout with scripts/ and tests/',
  },
]

/** Render the type radio cards (basic selected by default). */
function getTypeCardsHtml(): string {
  return TYPE_OPTIONS.map((opt, i) => {
    const checked = i === 0 ? ' checked' : ''
    return `
            <label class="type-card">
                <input type="radio" name="type" value="${escapeHtml(opt.value)}"${checked} />
                <span class="type-meta">
                    <span class="type-name">${escapeHtml(opt.label)}</span>
                    <span class="type-desc">${escapeHtml(opt.description)}</span>
                </span>
            </label>`
  }).join('')
}

/**
 * Build the full Create Skill HTML document.
 * @param nonce CSP nonce for the inline `<script>`.
 * @param csp   CSP header value (from getCreateSkillCsp).
 */
export function getCreateSkillHtml(nonce: string, csp: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Create Skill</title>
    <style>${getCreateStyles()}</style>
</head>
<body>
    <h1>Create a new skill</h1>
    <p class="subtitle">Scaffold a skill via the Skillsmith CLI. Fields are validated before creation.</p>

    <form id="createForm" aria-busy="false">
        <div class="field">
            <label for="author">Author</label>
            <input type="text" id="author" name="author" autocomplete="off"
                placeholder="your-handle" aria-describedby="authorError" />
            <span class="error" id="authorError" aria-live="polite"></span>
        </div>

        <div class="field">
            <label for="name">Name</label>
            <input type="text" id="name" name="name" autocomplete="off"
                placeholder="my-skill" aria-describedby="nameValidity nameError" />
            <span class="name-validity" id="nameValidity" aria-live="polite"></span>
            <span class="error" id="nameError" aria-live="polite"></span>
        </div>

        <div class="field">
            <label for="description">Description</label>
            <input type="text" id="description" name="description" autocomplete="off"
                placeholder="What this skill does" aria-describedby="descriptionError" />
            <span class="error" id="descriptionError" aria-live="polite"></span>
        </div>

        <div class="field">
            <fieldset>
                <legend>Type</legend>
                <div class="type-cards">${getTypeCardsHtml()}
                </div>
                <span class="error" id="typeError" aria-live="polite"></span>
            </fieldset>
        </div>

        <div class="actions">
            <button type="button" class="btn-primary" id="createBtn">Create Skill</button>
        </div>

        <div class="failed-banner" id="failedBanner" aria-live="polite"></div>
        <pre id="cliLog" aria-live="off"></pre>
    </form>

    <script nonce="${nonce}">${getCreateScript(nonce)}</script>
</body>
</html>`
}
