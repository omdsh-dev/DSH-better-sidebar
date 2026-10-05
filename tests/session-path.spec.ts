import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSessionPath } from '../src/session-path.ts'

const WSL_CWD = '\\\\wsl.localhost\\archlinux\\home\\zdaar\\project'

describe('resolveSessionPath', () => {
  it('maps a Linux absolute path into the WSL distro root on win32', () => {
    expect(resolveSessionPath(WSL_CWD, '/home/zdaar/project/src/a.ts', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\home\\zdaar\\project\\src\\a.ts')
  })

  it('maps a path outside the workspace into the same distro before containment checks', () => {
    expect(resolveSessionPath(WSL_CWD, '/tmp/dsh-issue.md', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\tmp\\dsh-issue.md')
  })

  it('normalizes Linux dot segments without escaping the distro share root', () => {
    expect(resolveSessionPath(WSL_CWD, '/home/zdaar/project/../other/a.ts', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\home\\zdaar\\other\\a.ts')
    expect(resolveSessionPath(WSL_CWD, '/../etc/hosts', 'win32'))
      .toBe('\\\\wsl.localhost\\archlinux\\etc\\hosts')
  })

  it('preserves Windows drive paths in a WSL session', () => {
    const target = 'C:\\Users\\zdaar\\file.md'
    expect(resolveSessionPath(WSL_CWD, target, 'win32')).toBe(target)
  })

  it('preserves UNC paths in a WSL session', () => {
    const backslash = '\\\\server\\share\\file.md'
    const forwardSlash = '//server/share/file.md'
    expect(resolveSessionPath(WSL_CWD, backslash, 'win32')).toBe(backslash)
    expect(resolveSessionPath(WSL_CWD, forwardSlash, 'win32')).toBe(forwardSlash)
  })

  it('does not reinterpret slash-rooted paths for ordinary Windows sessions', () => {
    expect(resolveSessionPath('C:\\Users\\zdaar\\project', '/tmp/a.ts', 'win32')).toBe('/tmp/a.ts')
    expect(resolveSessionPath('\\\\server\\share\\project', '/tmp/a.ts', 'win32')).toBe('/tmp/a.ts')
  })

  it('does not reinterpret paths on non-Windows hosts', () => {
    expect(resolveSessionPath('/home/zdaar/project', '/tmp/a.ts', 'linux')).toBe('/tmp/a.ts')
    expect(resolveSessionPath('/Users/zdaar/project', '/tmp/a.ts', 'darwin')).toBe('/tmp/a.ts')
  })

  it('recognizes wsl.localhost case-insensitively and with forward-slash cwd spelling', () => {
    expect(resolveSessionPath('//WSL.LOCALHOST/Ubuntu/home/me/project', '/home/me/project/a.ts', 'win32'))
      .toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\project\\a.ts')
  })
})

/**
 * dsh-remote mirror sessions: the session cwd is a LOCAL directory standing
 * in for a remote POSIX workspace. A remote path must land inside the mirror,
 * never on the current drive (the `ENOENT ... realpath 'C:\\...'` symptom).
 */
describe('resolveSessionPath (dsh-remote mirror)', () => {
  let dshHome: string
  let mirrorRoot: string
  const REMOTE_PATH = '/Users/yangheng/Project/claude/CBI_CT/civiapp_main'

  // The fs-backed cases below locate the mirror meta through win32 path
  // spelling (`win32.join` inside remotePathOf), which only names a real file
  // ON WINDOWS — on POSIX hosts it points at a literal-backslash name that
  // was never created, so the lookup degrades to pass-through and the
  // mapping assertions fail. The repository's Windows lane (ci-windows) owns
  // these; the portable projection cases (outside-workspace, prefix-sibling,
  // drive paths, malformed meta, non-win32 no-op) run everywhere below.
  const fsBacked = process.platform === 'win32'
  const fsBackedIt = fsBacked ? it : it.skip

  beforeAll(() => {
    dshHome = mkdtempSync(join(tmpdir(), 'dsh-session-path-'))
    mirrorRoot = join(dshHome, '.dsh', 'remote-workspaces', '192.168.8.6-yangheng-22', 'civiapp_main')
    mkdirSync(mirrorRoot, { recursive: true })
    writeFileSync(
      join(mirrorRoot, '.dsh-remote-meta.json'),
      JSON.stringify({ host: '192.168.8.6', port: 22, username: 'yangheng', remotePath: REMOTE_PATH }),
    )
  })

  afterAll(() => {
    rmSync(dshHome, { recursive: true, force: true })
  })

  fsBackedIt('maps a remote workspace file onto the local mirror', () => {
    expect(resolveSessionPath(mirrorRoot, `${REMOTE_PATH}/src/a.ts`, 'win32'))
      .toBe(join(mirrorRoot, 'src', 'a.ts'))
  })

  fsBackedIt('maps the remote workspace root itself onto the mirror root', () => {
    expect(resolveSessionPath(mirrorRoot, REMOTE_PATH, 'win32')).toBe(mirrorRoot)
  })

  fsBackedIt('maps for a session nested inside the mirror', () => {
    const nested = join(mirrorRoot, 'packages', 'api')
    expect(resolveSessionPath(nested, `${REMOTE_PATH}/src/a.ts`, 'win32'))
      .toBe(join(mirrorRoot, 'src', 'a.ts'))
  })

  it('leaves a remote path OUTSIDE the mirrored workspace unprojected', () => {
    // Deliberately NOT mapped: projecting it would invent an unrelated local
    // file. It stays a slash-rooted path — downstream `resolve()` drive-roots
    // it (`C:\etc\hosts`) and the request fails as a missing local file.
    expect(resolveSessionPath(mirrorRoot, '/etc/hosts', 'win32')).toBe('/etc/hosts')
  })

  it('does not treat a workspace whose name merely prefixes another as inside it', () => {
    expect(resolveSessionPath(mirrorRoot, `${REMOTE_PATH}_backup/a.ts`, 'win32'))
      .toBe(`${REMOTE_PATH}_backup/a.ts`)
  })

  fsBackedIt('normalizes dot segments without escaping the mirror root', () => {
    expect(resolveSessionPath(mirrorRoot, `${REMOTE_PATH}/src/../lib/a.ts`, 'win32'))
      .toBe(join(mirrorRoot, 'lib', 'a.ts'))
  })

  it('preserves Windows drive paths in a mirror session', () => {
    const target = 'C:\\Users\\yangheng\\file.md'
    expect(resolveSessionPath(mirrorRoot, target, 'win32')).toBe(target)
  })

  it('leaves paths alone when the mirror has no metadata file', () => {
    const bare = join(dshHome, '.dsh', 'remote-workspaces', 'host-key', 'no-meta')
    mkdirSync(bare, { recursive: true })
    expect(resolveSessionPath(bare, '/srv/app/a.ts', 'win32')).toBe('/srv/app/a.ts')
  })

  it('leaves paths alone when the metadata is malformed', () => {
    const broken = join(dshHome, '.dsh', 'remote-workspaces', 'host-key', 'broken-meta')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, '.dsh-remote-meta.json'), '{ not json')
    expect(resolveSessionPath(broken, '/srv/app/a.ts', 'win32')).toBe('/srv/app/a.ts')
  })

  it('does not reinterpret paths for a mirror session on non-Windows hosts', () => {
    expect(resolveSessionPath(mirrorRoot, `${REMOTE_PATH}/src/a.ts`, 'linux'))
      .toBe(`${REMOTE_PATH}/src/a.ts`)
  })
})
