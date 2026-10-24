/**
 * Temp-tree removal for specs that spawn real child processes or hold OS
 * handles (zip / tar / git / fd / rg / powershell / `fs.watch`) inside the
 * tree they are about to delete.
 *
 * `rmSync(path, { recursive: true, force: true })` is not enough on Windows:
 * a child that was just killed, or a watcher that was just closed, can still
 * hold a handle for a few milliseconds, and the removal then fails with
 * ENOTEMPTY / EBUSY / EPERM **from the cleanup of a test that had already
 * passed** — which is how the Windows lane went red on 2026-10-15
 * (`tests/archive.spec.ts`'s afterEach, `ENOTEMPTY: rmdir …archives-pvpAWR`,
 * on a run where only that cleanup failed and 2466 tests passed).
 *
 * `maxRetries` + `retryDelay` is Node's own remedy for exactly this, so every
 * risky cleanup goes through here instead of repeating the retry inline.
 * POSIX runs are unaffected: the first attempt succeeds and no retry happens.
 */
import { rmSync } from 'node:fs'

/**
 * Remove one file or directory tree, retrying while a just-closed handle is
 * still being released by the OS.
 * @param path - file or directory to remove (missing paths are ignored).
 */
export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
