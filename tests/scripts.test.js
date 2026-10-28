import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { runScript, interpreterFor, hashScript } from '../src/engine/scripts.js'
import { tmpDir, write, sleep } from './helpers.js'

describe('custom scripts', () => {
  it('picks an interpreter by extension', () => {
    expect(interpreterFor('/x/a.py', { platform: 'linux' }).cmd).toBe('python3')
    expect(interpreterFor('/x/a.py', { platform: 'win32' }).cmd).toBe('python')
    expect(interpreterFor('/x/a.sh').cmd).toBe('sh')
    expect(interpreterFor('/x/a.ps1').cmd).toBe('powershell.exe')
    expect(interpreterFor('C:\\a.bat').args.slice(0, 2)).toEqual(['/d', '/c'])
    expect(interpreterFor('/x/a.js', { execPath: '/bin/node' })).toMatchObject({ cmd: '/bin/node', env: { ELECTRON_RUN_AS_NODE: '1' } })
    expect(interpreterFor('/x/tool')).toMatchObject({ cmd: '/x/tool', args: [] })
  })

  it('runs with the file as an argument and in the ZENTHRIP_FILE variable; reports exit code and output', async () => {
    const script = write(tmpDir(), 's.js', "console.log(process.argv[2] + '|' + process.env.ZENTHRIP_FILE); console.error('warn'); process.exit(2)")
    const target = write(tmpDir(), 'file.txt')
    const res = await runScript(script, target)
    expect(res).toMatchObject({ exitCode: 2, timedOut: false, stderr: 'warn\n' })
    expect(res.stdout.trim()).toBe(`${target}|${target}`)
  })

  it('has NO shell: a file name full of shell syntax is just an argument', async () => {
    const dir = tmpDir()
    const script = write(dir, 's.js', "console.log(process.argv[2])")
    const nasty = path.join(dir, 'a; touch pwned.txt && echo $(id) `id`.txt')
    fs.writeFileSync(nasty, 'x')
    const res = await runScript(script, nasty)
    expect(res.stdout.trim()).toBe(nasty)
    expect(fs.existsSync(path.join(dir, 'pwned.txt'))).toBe(false)
  })

  it('kills a script that runs too long (timeout) and the child really dies', async () => {
    const dir = tmpDir()
    const pidFile = path.join(dir, 'pid.txt')
    const script = write(dir, 'hang.js', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const started = Date.now()
    const res = await runScript(script, path.join(dir, 'f.txt'), { timeoutMs: 700 })
    expect(res.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    await sleep(150)
    expect(() => process.kill(pid, 0)).toThrow() // no such process any more
  })

  it('hashes the script content (trust is lost when it changes)', () => {
    const script = write(tmpDir(), 's.js', 'a')
    const h1 = hashScript(script)
    fs.writeFileSync(script, 'b')
    expect(hashScript(script)).not.toBe(h1)
  })

  it('reports a script that cannot be started', async () => {
    const res = await runScript('/does/not/exist.sh', '/f.txt', { interpreter: { cmd: '/does/not/exist', args: [], env: {} } })
    expect(res.spawnError).toBe('ENOENT')
  })
})
