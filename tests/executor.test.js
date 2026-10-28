import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { tmpDir, write, makeEngine, rigFs } from './helpers.js'
import * as ledger from '../src/db/ledger.js'
import * as settingsDb from '../src/db/settings.js'
import { hashScript } from '../src/engine/scripts.js'
import { AbortSweepError } from '../src/engine/errors.js'

const run = (engine, steps, extra = {}) => engine.executor.executePlan({ sweepId: 's1', ruleId: 1, steps, ...extra })

describe('executor: journal first, act second', () => {
  it('commits a "pending" ledger row BEFORE the file is touched, then marks it done', async () => {
    const dir = tmpDir()
    const src = write(dir, 'a.txt')
    const dest = path.join(tmpDir(), 'a.txt')
    let seenBefore
    const e = makeEngine({
      hooks: {
        afterJournal: (id) => {
          seenBefore = { row: ledger.getEntry(e.db, id), srcStillThere: fs.existsSync(src), destThere: fs.existsSync(dest) }
        }
      }
    })
    const [r] = await run(e, [{ op: 'move', src, dest }])
    expect(seenBefore.row).toMatchObject({ status: 'pending', op: 'move', src, dest })
    expect(seenBefore.srcStillThere).toBe(true)
    expect(seenBefore.destThere).toBe(false)
    expect(r.status).toBe('done')
    expect(ledger.getEntry(e.db, r.id).status).toBe('done')
    expect(fs.existsSync(src)).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('a.txt')
  })

  it('runs rename -> move as one chain and follows the renamed file', async () => {
    const dir = tmpDir()
    const out = tmpDir()
    const src = write(dir, 'inv.pdf', 'x')
    const renamed = path.join(dir, '2026_inv.pdf')
    const results = await run(makeEngine(), [
      { op: 'rename', src, dest: renamed },
      { op: 'move', src: renamed, dest: path.join(out, '2026_inv.pdf') }
    ])
    expect(results.map((r) => r.status)).toEqual(['done', 'done'])
    expect(fs.readdirSync(dir)).toEqual([])
    expect(fs.readdirSync(out)).toEqual(['2026_inv.pdf'])
  })

  it('never overwrites: a name that was free at planning time but is taken now gets a suffix', async () => {
    const dir = tmpDir()
    const out = tmpDir()
    const src = write(dir, 'a.txt', 'new')
    write(out, 'a.txt', 'old')
    const [r] = await run(makeEngine(), [{ op: 'move', src, dest: path.join(out, 'a.txt') }])
    expect(r.dest).toBe(path.join(out, 'a (1).txt'))
    expect(fs.readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('old')
    expect(fs.readFileSync(path.join(out, 'a (1).txt'), 'utf8')).toBe('new')
  })

  it('copy leaves the original, and a copy never appears under its real name half-written', async () => {
    const dir = tmpDir()
    const out = tmpDir()
    const src = write(dir, 'a.txt', 'data')
    const [r] = await run(makeEngine(), [{ op: 'copy', src, dest: path.join(out, 'a.txt') }])
    expect(r.status).toBe('done')
    expect(fs.existsSync(src)).toBe(true)
    expect(fs.readdirSync(out)).toEqual(['a.txt'])
  })

  it('trash moves the file into the Keeper Trash (so it can always be restored)', async () => {
    const dir = tmpDir()
    const src = write(dir, 'old.log')
    const e = makeEngine()
    const [r] = await run(e, [{ op: 'trash', src, dest: null }])
    expect(r.status).toBe('done')
    expect(fs.existsSync(src)).toBe(false)
    expect(r.dest.startsWith(path.join(e.trashRoot, 's1'))).toBe(true)
    expect(fs.existsSync(r.dest)).toBe(true)
  })

  it('stores a fingerprint after success, so the same file version is not handled twice', async () => {
    const dir = tmpDir()
    const src = write(dir, 'a.txt')
    const e = makeEngine()
    const fp = { path: src, size: 5, mtime: 123, ruleId: 1 }
    await run(e, [{ op: 'copy', src, dest: path.join(tmpDir(), 'a.txt') }], { fingerprint: fp })
    expect(ledger.hasFingerprint(e.db, fp)).toBe(true)
  })
})

describe('executor: cross-volume moves', () => {
  it('falls back to copy -> verify -> delete when rename says EXDEV', async () => {
    const dir = tmpDir()
    const out = tmpDir()
    const src = write(dir, 'big.bin', 'x'.repeat(5000))
    const e = makeEngine({
      fsx: rigFs({
        rename: async (a, b) => {
          if (a === src) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
          return fs.promises.rename(a, b)
        }
      })
    })
    const [r] = await run(e, [{ op: 'move', src, dest: path.join(out, 'big.bin') }])
    expect(r.status).toBe('done')
    expect(fs.existsSync(src)).toBe(false)
    expect(fs.readFileSync(path.join(out, 'big.bin'), 'utf8')).toHaveLength(5000)
    expect(fs.readdirSync(out)).toEqual(['big.bin']) // no .zenthrip-partial left behind
  })

  it('removes the partial file and keeps the source if the copy does not verify', async () => {
    const dir = tmpDir()
    const out = tmpDir()
    const src = write(dir, 'big.bin', 'x'.repeat(100))
    const e = makeEngine({
      fsx: rigFs({
        rename: async (a, b) => {
          if (a === src) throw Object.assign(new Error('x'), { code: 'EXDEV' })
          return fs.promises.rename(a, b)
        },
        copyFile: async (a, b, f) => {
          await fs.promises.copyFile(a, b, f)
          fs.truncateSync(b, 10) // simulate a short copy
        }
      })
    })
    const [r] = await run(e, [{ op: 'move', src, dest: path.join(out, 'big.bin') }])
    expect(r.status).toBe('failed')
    expect(fs.existsSync(src)).toBe(true)
    expect(fs.readdirSync(out)).toEqual([])
  })
})

describe('executor: errors are reported, not fatal', () => {
  const errFs = (code, times = Infinity) => {
    let n = 0
    return rigFs({
      rename: async (a, b) => {
        if (n++ < times) throw Object.assign(new Error(code), { code })
        return fs.promises.rename(a, b)
      }
    })
  }

  it('retries a locked file with back-off and succeeds when it frees up', async () => {
    const src = write(tmpDir(), 'a.txt')
    const [r] = await run(makeEngine({ fsx: errFs('EBUSY', 2) }), [{ op: 'move', src, dest: path.join(tmpDir(), 'a.txt') }])
    expect(r.status).toBe('done')
  })

  it('gives up on a file that stays locked and says why', async () => {
    const src = write(tmpDir(), 'a.txt')
    const e = makeEngine({ fsx: errFs('EBUSY'), settings: { retryCount: 2 } })
    const [r] = await run(e, [{ op: 'move', src, dest: path.join(tmpDir(), 'a.txt') }])
    expect(r).toMatchObject({ status: 'failed', kind: 'locked' })
    expect(ledger.getEntry(e.db, r.id)).toMatchObject({ status: 'failed' })
    expect(ledger.getEntry(e.db, r.id).error).toMatch(/locked/)
    expect(fs.existsSync(src)).toBe(true)
  })

  it('a file that vanished is "skipped", not an error', async () => {
    const dir = tmpDir()
    const [r] = await run(makeEngine(), [{ op: 'move', src: path.join(dir, 'ghost.txt'), dest: path.join(tmpDir(), 'ghost.txt') }])
    expect(r.status).toBe('skipped')
  })

  it('refuses an over-long destination name BEFORE touching anything', async () => {
    const dir = tmpDir()
    const src = write(dir, 'a.txt')
    const e = makeEngine()
    const [r] = await run(e, [{ op: 'rename', src, dest: path.join(dir, 'x'.repeat(300) + '.txt') }])
    expect(r).toMatchObject({ status: 'failed', kind: 'toolong' })
    expect(r.error).toMatch(/too long/)
    expect(fs.existsSync(src)).toBe(true)
  })

  it('a disk-full error stops the sweep (AbortSweepError) after recording the failure', async () => {
    const src = write(tmpDir(), 'a.txt')
    const e = makeEngine({ fsx: errFs('ENOSPC') })
    await expect(run(e, [{ op: 'move', src, dest: path.join(tmpDir(), 'a.txt') }])).rejects.toBeInstanceOf(AbortSweepError)
    expect(ledger.listLedger(e.db, {}).rows[0]).toMatchObject({ status: 'failed' })
  })

  it('when one step fails, the steps after it are recorded as skipped', async () => {
    const dir = tmpDir()
    const src = write(dir, 'a.txt')
    const e = makeEngine({ fsx: errFs('EPERM') })
    const results = await run(e, [
      { op: 'rename', src, dest: path.join(dir, 'b.txt') },
      { op: 'move', src: path.join(dir, 'b.txt'), dest: path.join(tmpDir(), 'b.txt') }
    ])
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped'])
    expect(ledger.bySweep(e.db, 's1')).toHaveLength(2)
  })
})

describe('executor: custom scripts (Advanced)', () => {
  const makeScript = (body) => write(tmpDir(), 'hook.js', body)

  it('refuses a script that was never trusted', async () => {
    const script = makeScript('process.exit(0)')
    const src = write(tmpDir(), 'a.txt')
    const [r] = await run(makeEngine(), [{ op: 'script', src, dest: null, script }])
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/not trusted/)
  })

  it('runs a trusted script with the file as an argument and stores its output', async () => {
    const script = makeScript("console.log('hello ' + require('path').basename(process.argv[2]))")
    const src = write(tmpDir(), 'a b.txt')
    const e = makeEngine()
    settingsDb.trustScript(e.db, script, hashScript(script))
    const [r] = await run(e, [{ op: 'script', src, dest: null, script }])
    expect(r.status).toBe('done')
    expect(ledger.getEntry(e.db, r.id).detail).toMatchObject({ exitCode: 0, stdout: 'hello a b.txt\n' })
  })

  it('a script that is edited after being trusted stops being trusted', async () => {
    const script = makeScript('process.exit(0)')
    const e = makeEngine()
    settingsDb.trustScript(e.db, script, hashScript(script))
    fs.appendFileSync(script, '\n// sneaky change')
    const [r] = await run(e, [{ op: 'script', src: write(tmpDir(), 'a.txt'), dest: null, script }])
    expect(r.status).toBe('failed')
  })

  it('a non-zero exit is a failure with the exit code', async () => {
    const script = makeScript('process.exit(3)')
    const e = makeEngine()
    settingsDb.trustScript(e.db, script, hashScript(script))
    const [r] = await run(e, [{ op: 'script', src: write(tmpDir(), 'a.txt'), dest: null, script }])
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/code 3/)
  })
})
