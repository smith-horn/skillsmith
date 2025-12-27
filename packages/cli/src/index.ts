#!/usr/bin/env node
/**
 * Skillsmith CLI - Claude Skill Discovery Tools
 */

import { Command } from 'commander';
import { importSkills } from './import.js';

const program = new Command();

program
  .name('skillsmith')
  .description('Claude Skill Discovery and Management CLI')
  .version('0.1.0');

program
  .command('import')
  .description('Import skills from GitHub')
  .option('-t, --topic <topic>', 'GitHub topic to search', 'claude-skill')
  .option('-m, --max <number>', 'Maximum skills to import', '1000')
  .option('-d, --db <path>', 'Database file path', 'skillsmith.db')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
      await importSkills({
        topic: options.topic,
        maxSkills: parseInt(options.max),
        dbPath: options.db,
        verbose: options.verbose
      });
    } catch (error) {
      console.error('Import failed:', error);
      process.exit(1);
    }
  });

program.parse();
