// SMI-7123 Wave 5, Q7 EACCES on Linux: the park runs as a non-root uid (root
// bypasses DAC bits, so running it as root would prove nothing). argv: parent arm
import { quarantineTree } from '../quarantine.mjs'
import { countDestructive } from './w5-rows-common.mjs'
import * as M from './w5-mutants.mjs'

const [parent, arm] = process.argv.slice(2)
const fn = arm === 'candidate' ? quarantineTree : M.c4Consolation(quarantineTree, M.rmRf)
const c = countDestructive(() => fn(parent, 'target', { opId: `q7-${process.pid}` }))
process.stdout.write(JSON.stringify({ r: c.out, destructive: c.n }) + '\n')
