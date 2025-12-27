#!/usr/bin/env node
/**
 * @skillsmith/cli
 *
 * Command-line interface for Skillsmith skill management.
 */

import { Command } from 'commander'
import { VERSION } from '@skillsmith/core'

const program = new Command()

program
  .name('skillsmith')
  .description('CLI for Skillsmith skill discovery and management')
  .version(VERSION)

program
  .command('search <query>')
  .description('Search for skills matching a query')
  .option('-l, --limit <number>', 'Maximum results to return', '10')
  .action((query: string, options: { limit: string }) => {
    console.log(`Searching for: ${query} (limit: ${options.limit})`)
    // TODO: Implement search functionality
  })

program
  .command('info <skill-id>')
  .description('Get detailed information about a skill')
  .action((skillId: string) => {
    console.log(`Getting info for skill: ${skillId}`)
    // TODO: Implement info functionality
  })

program
  .command('list')
  .description('List installed skills')
  .option('-a, --all', 'Show all available skills')
  .action((options: { all?: boolean }) => {
    console.log(`Listing skills (all: ${options.all ?? false})`)
    // TODO: Implement list functionality
  })

program.parse()
