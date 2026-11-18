/**
 * Available filesystem roots for the shell-candidate browser's breadcrumb.
 *
 * The picker starts at "This PC" and needs the machine's drives to offer.
 * Node has no portable "list volumes" call, so Windows probes every drive
 * letter with `stat` and keeps the ones that resolve to a directory — the
 * same primitive the file listing already trusts. No `wmic`/`fsutil`/
 * PowerShell subprocess: those are environment-dependent binaries and the
 * repo's cross-platform rules forbid relying on them.
 *
 * POSIX exposes one root (`/`), returned directly.
 */
import { stat } from 'node:fs/promises'
import { platform } from 'node:os'
import { sep } from 'node:path'

export interface SidebarDrive {
  /** Short label shown in the drive chooser, e.g. `C:` or `/`. */
  name: string
  /** Absolute path to list when the drive is picked, e.g. `C:` + sep or `/`. */
  path: string
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * Probe the machine's filesystem roots. Unavailable/absent letters are
 * skipped silently — a missing `A:` is normal, not an error — and an empty
 * list simply means the picker has no drive to show.
 */
export async function listDrives(): Promise<{ drives: SidebarDrive[] }> {
  if (platform() !== 'win32') {
    return { drives: [{ name: '/', path: '/' }] }
  }
  const probes = await Promise.all(
    [...DRIVE_LETTERS].map(async (letter): Promise<SidebarDrive | undefined> => {
      const path = `${letter}:${sep}`
      try {
        const info = await stat(path)
        return info.isDirectory() ? { name: `${letter}:`, path } : undefined
      } catch {
        return undefined
      }
    }),
  )
  return { drives: probes.filter((drive): drive is SidebarDrive => drive !== undefined) }
}
