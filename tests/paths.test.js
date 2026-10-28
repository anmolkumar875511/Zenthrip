import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { isTempFile, isIgnoredFile, pathKey, getDenylist, isDeniedPath, validateFolderPath, validateDestination } from '../src/engine/paths.js'
import { tmpDir } from './helpers.js'

describe('temp and junk files', () => {
  it('half-finished downloads and lock files are temp files', () => {
    for (const n of ['a.crdownload', 'b.PART', 'c.tmp', 'd.download', '~$report.docx', 'x.pdf.zenthrip-partial']) {
      expect(isTempFile(n), n).toBe(true)
    }
    for (const n of ['a.pdf', 'tmp.txt', 'part.docx', 'notes']) expect(isTempFile(n), n).toBe(false)
  })
  it('OS junk files are ignored too', () => {
    expect(isIgnoredFile('.DS_Store')).toBe(true)
    expect(isIgnoredFile('Thumbs.db')).toBe(true)
    expect(isIgnoredFile('photo.jpg')).toBe(false)
  })
})

describe('pathKey', () => {
  it('ignores trailing slashes, and case on Windows/macOS only', () => {
    expect(pathKey('/a/b/', 'linux')).toBe(pathKey('/a/b', 'linux'))
    expect(pathKey('/a/B', 'linux')).not.toBe(pathKey('/a/b', 'linux'))
    expect(pathKey('C:\\Users\\Me\\', 'win32')).toBe(pathKey('c:\\users\\me', 'win32'))
    expect(pathKey('/A/b', 'darwin')).toBe(pathKey('/a/B', 'darwin'))
  })
})

describe('deny-list (Linux/macOS style)', () => {
  const deny = getDenylist({ platform: 'linux', home: '/home/me', env: {} })
  it('refuses the root, system folders, and anything inside them', () => {
    for (const p of ['/', '/etc', '/etc/nginx', '/usr/local/bin', '/var/log', '/System/Library', '/bin']) {
      expect(isDeniedPath(p, deny), p).toBeTruthy()
    }
  })
  it('refuses the home folder itself and the folders that contain homes, but not subfolders', () => {
    expect(isDeniedPath('/home/me', deny)).toBeTruthy()
    expect(isDeniedPath('/home', deny)).toBeTruthy()
    expect(isDeniedPath('/home/me/Downloads', deny)).toBeNull()
    expect(isDeniedPath('/home/other/stuff', deny)).toBeNull()
    expect(isDeniedPath('/srv/shared', deny)).toBeNull()
  })
})

describe('deny-list (Windows style)', () => {
  const deny = getDenylist({
    platform: 'win32',
    home: 'C:\\Users\\me',
    env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' }
  })
  it('refuses drive roots, Windows, Program Files, and is case-insensitive', () => {
    for (const p of ['C:\\', 'D:\\', 'C:\\Windows', 'c:\\windows\\system32', 'C:\\Program Files\\App', 'C:\\ProgramData', 'C:\\Users', 'C:\\Users\\me']) {
      expect(isDeniedPath(p, deny), p).toBeTruthy()
    }
  })
  it('allows normal user folders', () => {
    expect(isDeniedPath('C:\\Users\\me\\Downloads', deny)).toBeNull()
    expect(isDeniedPath('D:\\Projects\\inbox', deny)).toBeNull()
  })
})

describe('validateFolderPath', () => {
  const root = tmpDir()
  const ok = path.join(root, 'ok')
  const sys = path.join(root, 'sys')
  fs.mkdirSync(ok)
  fs.mkdirSync(sys)
  fs.writeFileSync(path.join(root, 'file.txt'), 'x')
  const denylist = { platform: process.platform, inside: [sys], equal: [root] }
  const v = (input, extra = {}) => validateFolderPath(input, { denylist, ...extra })

  it('accepts a normal folder and returns its real path', () => {
    expect(v(ok)).toEqual({ ok: true, path: ok })
  })
  it('rejects missing paths, files, empty input', () => {
    expect(v(path.join(root, 'nope')).ok).toBe(false)
    expect(v(path.join(root, 'file.txt')).ok).toBe(false)
    expect(v('').ok).toBe(false)
    expect(v(undefined).ok).toBe(false)
  })
  it('rejects protected folders and the filesystem root', () => {
    expect(v(sys).ok).toBe(false)
    expect(v(root).ok).toBe(false)
    expect(validateFolderPath(path.parse(root).root).ok).toBe(false)
  })
  it('rejects duplicates and enforces the maximum', () => {
    expect(v(ok, { existing: [ok] })).toMatchObject({ ok: false })
    expect(v(ok, { existing: ['/a', '/b', '/c'], max: 3 })).toMatchObject({ ok: false })
  })
  it.skipIf(process.platform === 'win32')('resolves symlinks first, so a link to a protected folder is refused', () => {
    const link = path.join(root, 'sneaky')
    fs.symlinkSync(sys, link)
    expect(v(link).ok).toBe(false)
  })
})

describe('validateDestination', () => {
  const denylist = getDenylist({ platform: 'linux', home: '/home/me', env: {} })
  const v = (p) => validateDestination(p, { denylist })
  it('needs an absolute, non-protected path (which does not have to exist yet)', () => {
    expect(v('relative/dir').ok).toBe(false)
    expect(v('').ok).toBe(false)
    expect(v('/etc/zenthrip').ok).toBe(false)
    expect(v('/home/me/Documents/Invoices').ok).toBe(true)
  })
})
