/**
 * CLI Commands
 *
 * Export all CLI commands for registration.
 */

// SMI-744: Interactive Search
export { createSearchCommand } from './search.js'

// SMI-745: Skill Management
export { createListCommand, createUpdateCommand, createRemoveCommand } from './manage.js'

// SMI-746: Skill Authoring
export { createInitCommand, createValidateCommand, createPublishCommand } from './author.js'
