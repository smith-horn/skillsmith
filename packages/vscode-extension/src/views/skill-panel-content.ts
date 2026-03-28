/**
 * SMI-3672: Content rendering for SkillDetailPanel
 * Renders SKILL.md markdown as sanitized HTML for the webview.
 * Extracted from skill-panel-html.ts to stay under 500-line limit.
 */

import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

/** Maximum content length before truncation (10KB) */
const MAX_CONTENT_LENGTH = 10_240

/**
 * Render SKILL.md content as sanitized HTML.
 * Returns empty string if content is undefined/empty (no placeholder).
 * Sanitization order: marked(content) → sanitize-html(result).
 */
export function getContentHtml(content: string | undefined, showFullContent = false): string {
  if (!content) {
    return ''
  }

  const truncated = !showFullContent && content.length > MAX_CONTENT_LENGTH
  const displayContent = truncated ? content.slice(0, MAX_CONTENT_LENGTH) : content

  const rawHtml = marked.parse(displayContent, { async: false }) as string
  const safeHtml = sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'img',
      'pre',
      'code',
      'details',
      'summary',
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt', 'title', 'width', 'height'],
      code: ['class'],
      a: ['href', 'title', 'target', 'rel'],
    },
    allowedSchemes: ['https', 'http'],
  })

  const truncatedNotice = truncated
    ? `<p class="content-truncated"><em>Content truncated (${content.length} chars). <button class="btn-expand" id="expandContentBtn">Show full content</button></em></p>`
    : ''

  return `
    <div class="section">
        <h2>Skill Content</h2>
        <div class="skill-content" id="skillContent">
            ${safeHtml}
        </div>
        ${truncatedNotice}
    </div>
    `
}

/**
 * Get CSS styles for the skill content section.
 * Appended to the main styles in skill-panel-html.ts.
 */
export function getContentStyles(): string {
  return `
        .skill-content {
            font-size: 14px;
            line-height: 1.7;
        }
        .skill-content h1,
        .skill-content h2,
        .skill-content h3 {
            margin-top: 16px;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }
        .skill-content pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
        }
        .skill-content code {
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
        }
        .skill-content p code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
        }
        .skill-content a {
            color: var(--vscode-textLink-foreground);
        }
        .skill-content a:hover {
            text-decoration: underline;
        }
        .skill-content ul, .skill-content ol {
            padding-left: 24px;
        }
        .skill-content table {
            border-collapse: collapse;
            width: 100%;
            margin: 12px 0;
        }
        .skill-content th, .skill-content td {
            border: 1px solid var(--vscode-panel-border);
            padding: 8px;
            text-align: left;
        }
        .skill-content th {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        .content-truncated {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            margin-top: 8px;
        }
        .btn-expand {
            background: none;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            padding: 0;
            font-size: 13px;
        }
        .btn-expand:hover {
            text-decoration: underline;
        }
    `
}
