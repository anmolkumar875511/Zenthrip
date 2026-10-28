// Runs the REAL executor and kills the whole process at a chosen moment (SIGKILL: no cleanup, like a power cut).
//   node crashChild.mjs <dbFile> <srcFile> <destFile> <afterJournal|afterAct>
import { openDb } from '../../src/db/db.js'
import { createExecutor } from '../../src/engine/executor.js'

const [, , dbFile, src, dest, point] = process.argv
const db = openDb(dbFile)
const kill = () => process.kill(process.pid, 'SIGKILL')
const executor = createExecutor({
  db,
  trashRoot: dest + '-trash',
  hooks: { [point]: kill }
})
await executor.executePlan({ sweepId: 'crash-sweep', ruleId: 1, steps: [{ op: 'move', src, dest }] })
console.log('survived?!')
