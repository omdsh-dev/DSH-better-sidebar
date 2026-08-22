import { describe, expect, it, vi } from 'vitest'
import { renderViewerIcon, viewerIconForPath } from '../src/client/viewer-icon.ts'

describe('viewer file icons', () => {
  it('renders static and sized descriptor icons', () => {
    expect(renderViewerIcon('static', 14)).toBe('static')
    expect(renderViewerIcon(size => `lua-${size}`, 14)).toBe('lua-14')
    expect(renderViewerIcon(undefined, 14)).toBeNull()
  })

  it('uses the matched file viewer as the icon registry', () => {
    const matchFileViewer = vi.fn(() => ({ icon: (size: number) => `lua-${size}` }))
    expect(viewerIconForPath({ matchFileViewer } as never, 'src/init.luau', 14)).toBe('lua-14')
    expect(matchFileViewer).toHaveBeenCalledWith('src/init.luau')
  })
})
