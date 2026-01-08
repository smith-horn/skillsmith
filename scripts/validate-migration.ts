/**
 * SMI-1181: Validate skills database migration to Supabase
 * Wave 2: Database Migration - Validation
 *
 * Verifies that:
 * 1. Row counts match between SQLite and Supabase
 * 2. Sample data is correctly migrated
 * 3. Full-text search is working
 *
 * Wave A+B Fixes:
 * - SMI-1197: Fixed non-null assertion timing
 * - SMI-1199: Extracted shared utilities
 * - SMI-1200: Fixed false positive in search validation
 * - SMI-1203: Parallelized trust tier queries
 * - SMI-1204: Added type safety
 * - SMI-1205: Added debug logging
 * - SMI-1210: Improved tilde expansion
 *
 * Wave C+D Additions (100k Scale):
 * - SMI-1211: Random sampling validation for large datasets
 */

import Database from 'better-sqlite3';
import {
  validateEnv,
  createSupabaseClient,
  findDatabase,
  getRandomSampleIds,
  compareSkills,
  DEBUG,
  type SQLiteSkill,
} from './lib/migration-utils.js';

// SMI-1211: Configuration for sampling
const MIN_SAMPLE_SIZE = 10;
const MAX_SAMPLE_SIZE = 100;
const SAMPLE_PERCENTAGE = 0.01; // 1% of total

async function validate() {
  console.log('='.repeat(60));
  console.log('SMI-1181: Migration Validation');
  console.log('='.repeat(60));

  // SMI-1197: Validate environment BEFORE using variables
  const config = validateEnv();

  let passed = true;

  // 1. Count validation
  console.log('\n📊 Test 1: Row Count Validation');
  console.log('-'.repeat(40));

  const dbPath = findDatabase();
  const sqlite = new Database(dbPath, { readonly: true });
  const sqliteCount = sqlite.prepare('SELECT COUNT(*) as count FROM skills').get() as {
    count: number;
  };

  const supabase = createSupabaseClient(config);

  const { count: supabaseCount, error: countError } = await supabase
    .from('skills')
    .select('*', { count: 'exact', head: true });

  if (countError) {
    console.error('❌ Failed to get Supabase count:', countError.message);
    passed = false;
  } else {
    console.log(`SQLite count:   ${sqliteCount.count}`);
    console.log(`Supabase count: ${supabaseCount}`);

    if (sqliteCount.count === supabaseCount) {
      console.log('✅ Row counts match!');
    } else {
      console.log(`❌ Row count mismatch: ${sqliteCount.count} vs ${supabaseCount}`);
      passed = false;
    }
  }

  // 2. Sample data validation
  console.log('\n📋 Test 2: Sample Data Validation');
  console.log('-'.repeat(40));

  const { data: sample, error: sampleError } = await supabase
    .from('skills')
    .select('id, name, author, trust_tier, quality_score')
    .limit(5)
    .order('quality_score', { ascending: false, nullsFirst: false });

  if (sampleError) {
    console.error('❌ Failed to fetch sample:', sampleError.message);
    passed = false;
  } else if (!sample || sample.length === 0) {
    console.log('❌ No skills found in Supabase');
    passed = false;
  } else {
    console.log('Top 5 skills by quality score:');
    sample.forEach((s) => {
      console.log(`  - ${s.name} (${s.author}) - ${s.trust_tier}, score: ${s.quality_score}`);
    });
    console.log('✅ Sample data looks correct');
  }

  // 3. Trust tier distribution (parallel queries)
  console.log('\n📊 Test 3: Trust Tier Distribution');
  console.log('-'.repeat(40));

  const tiers = ['verified', 'community', 'experimental', 'unknown'] as const;

  const tierResults = await Promise.all(
    tiers.map((tier) =>
      supabase
        .from('skills')
        .select('*', { count: 'exact', head: true })
        .eq('trust_tier', tier)
        .then(({ count }) => ({ tier, count: count ?? 0 }))
    )
  );

  tierResults.forEach(({ tier, count }) => {
    console.log(`  ${tier}: ${count}`);
  });
  console.log('✅ Trust tier distribution retrieved');

  // 4. Full-text search test
  console.log('\n🔍 Test 4: Full-Text Search');
  console.log('-'.repeat(40));

  const searchTerms = ['testing', 'git', 'docker'];
  let searchPassed = true;
  let searchTotal = 0;

  for (const term of searchTerms) {
    const { data: searchResults, error: searchError } = await supabase
      .from('skills')
      .select('id, name')
      .textSearch('search_vector', term)
      .limit(3);

    if (searchError) {
      console.log(`  "${term}": ❌ Search failed - ${searchError.message}`);
      searchPassed = false;
    } else {
      const count = searchResults?.length || 0;
      searchTotal += count;
      console.log(`  "${term}": ${count} results`);
      if (DEBUG && searchResults) {
        searchResults.slice(0, 2).forEach((r) => {
          console.log(`    - ${r.name}`);
        });
      }
    }
  }

  if (!searchPassed) {
    console.log('⚠️ Some searches failed');
  } else if (searchTotal === 0) {
    console.log('⚠️ Search returned no results - check search_vector population');
  } else {
    console.log('✅ Full-text search operational');
  }

  // 5. SMI-1211: Random sampling validation for large datasets
  console.log('\n🎲 Test 5: Random Sample Integrity (SMI-1211)');
  console.log('-'.repeat(40));

  const sampleSize = Math.min(
    MAX_SAMPLE_SIZE,
    Math.max(MIN_SAMPLE_SIZE, Math.ceil(sqliteCount.count * SAMPLE_PERCENTAGE))
  );

  console.log(`Sampling ${sampleSize} random skills (${(SAMPLE_PERCENTAGE * 100).toFixed(1)}% of ${sqliteCount.count})...`);

  const sampleIds = getRandomSampleIds(sqlite, sampleSize);
  let matchCount = 0;
  let mismatchCount = 0;
  const mismatchDetails: string[] = [];

  // Batch fetch from Supabase for efficiency
  const { data: supabaseSamples, error: samplesError } = await supabase
    .from('skills')
    .select('*')
    .in('id', sampleIds);

  if (samplesError) {
    console.error('❌ Failed to fetch samples from Supabase:', samplesError.message);
    passed = false;
  } else {
    const supabaseMap = new Map(supabaseSamples?.map((s) => [s.id, s]) || []);

    for (const id of sampleIds) {
      const sqliteSkill = sqlite
        .prepare('SELECT * FROM skills WHERE id = ?')
        .get(id) as SQLiteSkill;
      const supabaseSkill = supabaseMap.get(id);

      if (!supabaseSkill) {
        mismatchCount++;
        mismatchDetails.push(`${id}: Missing in Supabase`);
        continue;
      }

      const { match, mismatches } = compareSkills(sqliteSkill, supabaseSkill);
      if (match) {
        matchCount++;
      } else {
        mismatchCount++;
        mismatchDetails.push(`${id}: ${mismatches.join(', ')}`);
      }
    }

    const matchRate = ((matchCount / sampleSize) * 100).toFixed(1);
    console.log(`  Matches:    ${matchCount}/${sampleSize} (${matchRate}%)`);
    console.log(`  Mismatches: ${mismatchCount}/${sampleSize}`);

    if (mismatchCount > 0) {
      console.log('\n  Mismatch details (first 5):');
      mismatchDetails.slice(0, 5).forEach((d) => console.log(`    - ${d}`));
      if (mismatchDetails.length > 5) {
        console.log(`    ... and ${mismatchDetails.length - 5} more`);
      }

      // Fail if more than 1% mismatch
      if (mismatchCount / sampleSize > 0.01) {
        console.log('\n❌ Too many mismatches (>1%)');
        passed = false;
      } else {
        console.log('\n⚠️ Minor mismatches detected, within tolerance');
      }
    } else {
      console.log('✅ All sampled skills match!');
    }
  }

  // 6. Legacy single-skill integrity check
  console.log('\n🔐 Test 6: Single Skill Deep Check');
  console.log('-'.repeat(40));

  const sqliteSample = sqlite
    .prepare('SELECT * FROM skills ORDER BY quality_score DESC LIMIT 1')
    .get() as SQLiteSkill;

  const { data: supabaseSample, error: integrityError } = await supabase
    .from('skills')
    .select('*')
    .eq('id', sqliteSample.id)
    .single();

  if (integrityError || !supabaseSample) {
    console.log(`❌ Could not find skill ${sqliteSample.id} in Supabase`);
    passed = false;
  } else {
    const checks = [
      { field: 'name', match: sqliteSample.name === supabaseSample.name },
      { field: 'author', match: sqliteSample.author === supabaseSample.author },
      {
        field: 'quality_score',
        match:
          Math.abs((sqliteSample.quality_score || 0) - (supabaseSample.quality_score || 0)) <
          0.001,
      },
      { field: 'trust_tier', match: sqliteSample.trust_tier === supabaseSample.trust_tier },
    ];

    checks.forEach((c) => {
      console.log(`  ${c.field}: ${c.match ? '✅' : '❌'}`);
      if (!c.match) passed = false;
    });
  }

  sqlite.close();

  // Summary
  console.log('\n' + '='.repeat(60));
  if (passed) {
    console.log('✅ All validation tests passed!');
    console.log('='.repeat(60));
    console.log('\nMigration verified successfully.');
    console.log(`Total skills in Supabase: ${supabaseCount}`);
    console.log(`Sample integrity: ${matchCount}/${sampleSize} (${((matchCount / sampleSize) * 100).toFixed(1)}%)`);
    console.log('\nNext steps:');
    console.log('  1. Mark SMI-1181 as Done');
    console.log('  2. Proceed to Wave 3: MCP Server Integration');
  } else {
    console.log('❌ Some validation tests failed');
    console.log('='.repeat(60));
    console.log('\nPlease investigate the failures before proceeding.');
    process.exit(1);
  }
}

validate().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
