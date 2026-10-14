// SMI-7123 Wave 5: child entry that runs a FUNCTION STUB walker (W5_STUB names
// an export of w5-mutants.mjs) in place of prune.walk.mjs. Same stdin/stdout
// contract as the real walker child.
import fs from 'node:fs'
import { decodeJob } from '../prune.job.mjs'
import * as mutants from './w5-mutants.mjs'

const name = process.env.W5_STUB
const fn = mutants.WALKER_STUBS[name]
if (typeof fn !== 'function') {
  process.stderr.write(`w5-walker-stub: no walker stub named ${name}\n`)
  process.exit(3)
}
const job = decodeJob(JSON.parse(fs.readFileSync(0, 'utf8')))
const r = fn(job)
process.stdout.write(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? String(v) : v)) + '\n')
