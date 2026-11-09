import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileReadError } from '../src/fs-read-error.ts'

describe('fileReadError', () => {
  it('returns a readable message for a real missing-path error', async () => {
    const path = join(process.cwd(), `missing-file-${process.pid}-${Date.now()}.txt`)
    const error = await stat(path).then(
      () => { throw new Error('Expected stat to fail for a missing path') },
      reason => reason,
    )

    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect(fileReadError(path, error).message).toBe(`File not found: "${path}"`)
  })
})
