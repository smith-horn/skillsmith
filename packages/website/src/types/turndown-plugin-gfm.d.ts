/**
 * TypeScript declarations for turndown-plugin-gfm
 *
 * This module provides GitHub Flavored Markdown (GFM) extensions for Turndown.
 * @see https://github.com/mixmark-io/turndown-plugin-gfm
 */

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  /**
   * A Turndown plugin function that extends TurndownService with additional rules.
   */
  type TurndownPlugin = (turndownService: TurndownService) => void

  /**
   * GFM plugin that enables all GitHub Flavored Markdown extensions.
   * Includes: highlightedCodeBlock, strikethrough, tables, taskListItems.
   */
  export const gfm: TurndownPlugin

  /**
   * Plugin for converting highlighted code blocks (e.g., from GitHub).
   * Converts divs with highlight-text-* or highlight-source-* classes to fenced code blocks.
   */
  export const highlightedCodeBlock: TurndownPlugin

  /**
   * Plugin for converting strikethrough elements (del, s, strike) to GFM syntax (~text~).
   */
  export const strikethrough: TurndownPlugin

  /**
   * Plugin for converting HTML tables to GFM table syntax.
   * Only converts tables with a heading row; others are kept as HTML.
   */
  export const tables: TurndownPlugin

  /**
   * Plugin for converting checkbox inputs in list items to GFM task list syntax ([x] or [ ]).
   */
  export const taskListItems: TurndownPlugin
}
