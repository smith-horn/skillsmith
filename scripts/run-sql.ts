import { readFileSync } from 'fs'
import pg from 'pg'

const { Client } = pg

async function runSQL(filePath: string) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }

  const sql = readFileSync(filePath, 'utf-8')
  console.log('Running SQL:\n', sql.substring(0, 200) + '...\n')

  const client = new Client({ connectionString: databaseUrl })

  try {
    await client.connect()
    const result = await client.query(sql)
    console.log('Success!')
    if (result.rows?.length) {
      console.log('Result:', JSON.stringify(result.rows, null, 2))
    }
  } catch (error) {
    console.error('Error:', error)
  } finally {
    await client.end()
  }
}

const file = process.argv[2]
if (!file) {
  console.error('Usage: npx tsx scripts/run-sql.ts <file.sql>')
  process.exit(1)
}

runSQL(file)
