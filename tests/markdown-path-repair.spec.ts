import { describe, expect, it } from 'vitest'
import { isWindowsAbsolutePath, markdownPathRepairCandidates } from '../src/client/markdown-path-repair.ts'

describe('markdownPathRepairCandidates', () => {
  it('recognizes Windows drive and UNC absolute paths', () => {
    expect(isWindowsAbsolutePath('C:\\Users\\ADMIN\\report.md')).toBe(true)
    expect(isWindowsAbsolutePath('\\\\server\\share\\report.md')).toBe(true)
    expect(isWindowsAbsolutePath('/workspace/report.md')).toBe(false)
  })

  it('restores a separator before an escaped underscore in an absolute Windows path', () => {
    const candidates = markdownPathRepairCandidates('C:\\Users\\ADMIN\\workspace_analysis\\report.md')

    expect(candidates).toContain('C:\\Users\\ADMIN\\workspace\\_analysis\\report.md')
  })

  it('supports paths with multiple consumed separators', () => {
    const candidates = markdownPathRepairCandidates('C:\\workspaces\\team_project-file.md')

    expect(candidates).toContain('C:\\workspaces\\team\\_project\\-file.md')
  })

  it('does not propose repairs for POSIX paths or paths with too many punctuation positions', () => {
    expect(markdownPathRepairCandidates('/workspace/file_name.md')).toEqual([])
    expect(markdownPathRepairCandidates('C:\\a_b-c.d_e-f.g_x-h.i')).toEqual([])
  })

  it('checks paths with up to eight punctuation positions', () => {
    expect(markdownPathRepairCandidates('C:\\a_b-c.d_e-f.g_x-h')).toHaveLength(255)
  })
})
