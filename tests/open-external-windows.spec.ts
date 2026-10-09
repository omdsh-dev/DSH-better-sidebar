/**
 * Windows-lane evidence for #412 ("right-click → open in app does nothing").
 *
 * The reported bug was a SILENT SUCCESS: the single `rundll32.exe` branch
 * spawned fine on every Windows box, so the route answered `{ started: true }`
 * while nothing opened. This file drives the REAL `spawn` — the only injection
 * is the two Windows opener NAMES (a test-only seam, `WindowsOpenerOptions`),
 * pointed at executables that cannot exist on any machine. On `ci-windows`
 * (`pnpm test:windows`) that exercises the real Windows runtime: Node's own
 * ENOENT for the first branch, the fallback to the second branch, and the
 * aggregated failure the UI now surfaces instead of silence.
 *
 * NOTHING IS EVER LAUNCHED — not a browser, not an editor, not a console
 * window. That is exactly why the seam exists: spawning the production
 * `cmd.exe` / `rundll32.exe` here would start a real handler (`detached: true`
 * gives the child its own console window on Windows), which would pop windows
 * on the runner or hang the lane. An executable that does not exist cannot
 * start anything.
 *
 * The file is deliberately NOT platform-gated: the same code runs on the
 * ubuntu lane and on a dev machine (real spawn, real ENOENT), and on the
 * Windows lane it is that same path on the real OS.
 */
import { describe, expect, it } from 'vitest'
import { launchExternal, urlCommands } from '../src/open-external.ts'
import { SidebarError } from '../src/wire.ts'

/** Opener names that cannot exist: nothing on PATH matches, so spawn must fail. */
const MISSING_CMD = 'dsh-missing-opener-412-cmd.exe'
const MISSING_RUNDLL32 = 'dsh-missing-opener-412-rundll32.exe'

/** The seam bag both cases below inject (platform is win32, WSL is off). */
const missingOpeners = { cmdExecutable: MISSING_CMD, rundll32Executable: MISSING_RUNDLL32 }

describe('win32 URL opener chain on the real spawn path', () => {
  it('pins the production chain these cases run against: cmd.exe first, rundll32 second', () => {
    // The injected names only replace the executables; the SHAPE under test is
    // the production one (an unskipped URL goes to `start` first).
    expect(urlCommands('vscode://file/C:/a.ts', 'win32')).toEqual([
      { command: 'cmd.exe', args: ['/d', '/c', 'start', '', 'vscode://file/C:/a.ts'] },
      { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'vscode://file/C:/a.ts'] },
    ])
  })

  it('reports both branches failing instead of a silent success', async () => {
    const pending = launchExternal('url', 'vscode://file/C:/work/a.ts', {
      platform: 'win32',
      wsl: false,
      commandOptions: missingOpeners,
    })
    const outcome = await pending.then(() => null, (reason: unknown) => reason)

    expect(outcome).toBeInstanceOf(SidebarError)
    const failure = outcome as SidebarError
    expect(failure.code).toBe('internal')
    expect(failure.status).toBe(500)
    // Each branch is named WITH the OS's own message — two distinct ENOENTs
    // prove both were attempted and both failures survived into the report.
    expect(failure.message).toContain(MISSING_CMD)
    expect(failure.message).toContain(MISSING_RUNDLL32)
    expect(failure.message.match(/ENOENT/g)).toHaveLength(2)
  })

  it('reports only the rundll32 branch when a cmd metacharacter skips `start`', async () => {
    const pending = launchExternal('url', 'myapp://file/a&b.ts', {
      platform: 'win32',
      wsl: false,
      commandOptions: missingOpeners,
    })
    const outcome = await pending.then(() => null, (reason: unknown) => reason)

    expect(outcome).toBeInstanceOf(SidebarError)
    const failure = outcome as SidebarError
    expect(failure.message).toContain(MISSING_RUNDLL32)
    expect(failure.message).not.toContain(MISSING_CMD)
  })
})
