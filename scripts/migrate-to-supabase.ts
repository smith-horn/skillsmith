/**
 * SMI-1181: Migrate skills database from SQLite to Supabase
 * Wave 2: Database Migration
 *
 * Migrates all skills from the local SQLite database to Supabase PostgreSQL.
 *
 * Wave A+B Fixes:
 * - SMI-1197: Fixed non-null assertion timing
 * - SMI-1198: Fixed delete workaround
 * - SMI-1199: Extracted shared utilities
 * - SMI-1205: Added debug logging
 * - SMI-1206: Tags validation/sanitization
 * - SMI-1208: Added migration metrics
 * - SMI-1210: Improved tilde expansion
 * - SMI-1212: Added dry-run mode
 *
 * Wave C+D Additions (100k Scale):
 * - SMI-1201: Streaming migration (iterator-based, constant memory)
 * - SMI-1202: Parallel batch processing (concurrent batches)
 * - SMI-1207: Checkpointing for resumability
 * - SMI-1209: Rate limit handling with exponential backoff
 */

import Database from 'better-sqlite3';
import {
  validateEnv,
  createSupabaseClient,
  findDatabase,
  transformSkill,
  createMetrics,
  printMetricsReport,
  formatDuration,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  processBatchWithRetry,
  ConcurrencyLimiter,
  DEBUG,
  type SQLiteSkill,
  type MigrationMetrics,
  type MigrationCheckpoint,
  type SupabaseSkill as _SupabaseSkill,
} from './lib/migration-utils.js';

// Configuration
const BATCH_SIZE = 500;
const CONCURRENT_BATCHES = 3; // SMI-1202: Number of parallel batches
const CHECKPOINT_INTERVAL = 5; // Save checkpoint every N batches

interface MigrationOptions {
  dryRun: boolean;
  clean: boolean;
  resume: boolean;
  parallel: boolean;
}

function parseArgs(): MigrationOptions {
  return {
    dryRun: process.argv.includes('--dry-run'),
    clean: process.argv.includes('--clean'),
    resume: process.argv.includes('--resume'),
    parallel: !process.argv.includes('--no-parallel'), // Parallel by default
  };
}

async function migrate() {
  console.log('='.repeat(60));
  console.log('SMI-1181: Skills Database Migration to Supabase');
  console.log('='.repeat(60));

  const options = parseArgs();

  if (options.dryRun) {
    console.log('\n[DRY RUN MODE] No data will be written to Supabase\n');
  }

  // SMI-1197: Validate environment BEFORE using variables
  const config = validateEnv();

  // Find database
  const dbPath = findDatabase();
  const sqlite = new Database(dbPath, { readonly: true });

  // Create Supabase client
  const supabase = createSupabaseClient(config);

  // SMI-1207: Check for existing checkpoint
  let checkpoint: MigrationCheckpoint | null = null;
  let startOffset = 0;

  if (options.resume) {
    checkpoint = loadCheckpoint();
    if (checkpoint && checkpoint.dbPath === dbPath) {
      startOffset = checkpoint.lastProcessedOffset;
      console.log(`\n▶️ Resuming from offset ${startOffset}`);
    } else if (checkpoint) {
      console.log('\n⚠️ Checkpoint exists but for different database, starting fresh');
      checkpoint = null;
    }
  }

  // SMI-1198: Clear existing data if requested
  if (options.clean && !options.resume) {
    console.log('\nClearing existing skills from Supabase...');
    if (!options.dryRun) {
      const { error: deleteError } = await supabase
        .from('skills')
        .delete()
        .not('id', 'is', null);

      if (deleteError) {
        console.error('Failed to clear existing skills:', deleteError.message);
        process.exit(1);
      }
      clearCheckpoint();
    }
    console.log(options.dryRun ? '[DRY RUN] Would clear existing skills' : 'Existing skills cleared.');
  }

  // Get total count for progress
  const totalCount = sqlite.prepare('SELECT COUNT(*) as count FROM skills').get() as { count: number };
  const totalSkills = totalCount.count;
  console.log(`\nTotal skills in database: ${totalSkills}`);

  // SMI-1208: Initialize metrics
  const metrics: MigrationMetrics = createMetrics(totalSkills);
  if (checkpoint) {
    metrics.successCount = checkpoint.successCount;
    metrics.errorCount = checkpoint.errorCount;
    metrics.errors = [...checkpoint.errors];
  }

  // SMI-1201: Use streaming with LIMIT/OFFSET for constant memory
  console.log(`\nMigrating in batches of ${BATCH_SIZE}${options.parallel ? ` (${CONCURRENT_BATCHES} concurrent)` : ''}...`);

  // SMI-1202: Create concurrency limiter for parallel processing
  const limiter = new ConcurrencyLimiter(options.parallel ? CONCURRENT_BATCHES : 1);

  let currentOffset = startOffset;
  let batchesProcessed = 0;
  const pendingBatches: Promise<void>[] = [];

  // SMI-1201: Stream batches using LIMIT/OFFSET instead of loading all into memory
  while (currentOffset < totalSkills) {
    const batchOffset = currentOffset;
    const batchNum = Math.floor(batchOffset / BATCH_SIZE) + 1;

    // Query only this batch from SQLite (constant memory)
    const batch = sqlite
      .prepare('SELECT * FROM skills ORDER BY id LIMIT ? OFFSET ?')
      .all(BATCH_SIZE, batchOffset) as SQLiteSkill[];

    if (batch.length === 0) break;

    const transformed = batch.map(transformSkill);

    // SMI-1202: Process batch with concurrency control
    const batchPromise = limiter.run(async () => {
      const batchStart = Date.now();

      if (options.dryRun) {
        if (DEBUG) {
          console.log(`\n[DRY RUN] Batch ${batchNum}: ${batch.length} skills`);
          console.log(`  First: ${batch[0].id} - ${batch[0].name}`);
        }
        metrics.successCount += batch.length;
      } else {
        // SMI-1209: Use retry with exponential backoff
        const result = await processBatchWithRetry(supabase, transformed, 3, metrics);

        if (result.success) {
          metrics.successCount += batch.length;
        } else {
          console.error(`\nBatch ${batchNum} failed: ${result.error}`);
          metrics.errors.push(`Batch ${batchNum}: ${result.error}`);
          metrics.errorCount += batch.length;
        }
      }

      metrics.batchTimes.push(Date.now() - batchStart);
    });

    pendingBatches.push(batchPromise);
    currentOffset += batch.length;
    batchesProcessed++;

    // SMI-1207: Save checkpoint periodically
    if (batchesProcessed % CHECKPOINT_INTERVAL === 0) {
      // Wait for pending batches before checkpoint
      await Promise.all(pendingBatches);
      pendingBatches.length = 0;

      metrics.processedSkills = currentOffset;

      if (!options.dryRun) {
        saveCheckpoint({
          lastProcessedOffset: currentOffset,
          processedCount: currentOffset,
          successCount: metrics.successCount,
          errorCount: metrics.errorCount,
          errors: metrics.errors.slice(-20), // Keep last 20 errors
          timestamp: new Date().toISOString(),
          dbPath,
        });
      }
    }

    // Update progress
    metrics.processedSkills = currentOffset;
    const pct = ((currentOffset / totalSkills) * 100).toFixed(1);
    const avgTime = metrics.batchTimes.length > 0
      ? metrics.batchTimes.reduce((a, b) => a + b, 0) / metrics.batchTimes.length
      : 0;
    const remaining = totalSkills - currentOffset;
    const eta = avgTime > 0 ? formatDuration((remaining / BATCH_SIZE) * avgTime) : '...';

    process.stdout.write(
      `\rProgress: ${currentOffset}/${totalSkills} (${pct}%) | ` +
      `Batches: ${batchesProcessed} | ETA: ${eta}  `
    );
  }

  // Wait for any remaining batches
  await Promise.all(pendingBatches);

  console.log('\n');
  sqlite.close();

  // Clear checkpoint on successful completion
  if (!options.dryRun && metrics.errorCount === 0) {
    clearCheckpoint();
  }

  // Summary
  console.log('='.repeat(60));
  console.log('Migration Summary');
  console.log('='.repeat(60));
  console.log(`Total skills:    ${totalSkills}`);
  console.log(`Processed:       ${metrics.processedSkills}`);
  console.log(`Successful:      ${metrics.successCount}`);
  console.log(`Failed:          ${metrics.errorCount}`);
  console.log(`Retries:         ${metrics.retryCount}`);

  if (metrics.errors.length > 0) {
    console.log('\nErrors:');
    metrics.errors.slice(0, 10).forEach((e) => console.log(`  - ${e}`));
    if (metrics.errors.length > 10) {
      console.log(`  ... and ${metrics.errors.length - 10} more`);
    }
  }

  // SMI-1208: Print performance metrics
  printMetricsReport(metrics);

  // Usage hints
  console.log('\n' + '='.repeat(60));
  console.log('Usage');
  console.log('='.repeat(60));
  console.log('  --dry-run      Test without writing data');
  console.log('  --clean        Clear existing data first');
  console.log('  --resume       Resume from last checkpoint');
  console.log('  --no-parallel  Disable parallel batch processing');

  if (options.dryRun) {
    console.log('\n[DRY RUN] No data was written. Remove --dry-run to execute migration.');
  } else if (metrics.errorCount === 0) {
    console.log('\n✅ Migration completed successfully!');
    console.log('\nNext step: Run validation script');
    console.log('  npx tsx scripts/validate-migration.ts');
  } else {
    console.log('\n⚠️ Migration completed with errors');
    console.log('Use --resume to continue from last checkpoint');
    process.exit(1);
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
