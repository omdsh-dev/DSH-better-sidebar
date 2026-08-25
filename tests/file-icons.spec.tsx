import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileTypeIcon, fileIconInfo } from '../src/client/file-icons.tsx'

describe('file icon classification', () => {
  it('recognizes common code, documentation, configuration, and asset files', () => {
    expect(fileIconInfo('/repo/config/eval_gpt2.py')).toEqual({ kind: 'python', tone: 'code' })
    expect(fileIconInfo('/repo/src/App.tsx')).toEqual({ kind: 'typescript', tone: 'code' })
    expect(fileIconInfo('/repo/README.md')).toEqual({ kind: 'markdown', tone: 'document' })
    expect(fileIconInfo('/repo/package.json')).toEqual({ kind: 'package', tone: 'config' })
    expect(fileIconInfo('/repo/.gitignore')).toEqual({ kind: 'git', tone: 'config' })
    expect(fileIconInfo('/repo/.github/workflows/ci.yml')).toEqual({ kind: 'workflow', tone: 'special' })
    expect(fileIconInfo('/repo/assets/logo.svg')).toEqual({ kind: 'image', tone: 'code' })
    expect(fileIconInfo('/repo/scaling_laws.ipynb')).toEqual({ kind: 'notebook', tone: 'config' })
  })

  it('handles Windows paths, dotfiles, and unknown files', () => {
    expect(fileIconInfo('C:\\repo\\.env.local')).toEqual({ kind: 'env', tone: 'special' })
    expect(fileIconInfo('C:\\repo\\pnpm-lock.yaml')).toEqual({ kind: 'package', tone: 'config' })
    expect(fileIconInfo('/repo/LICENSE')).toEqual({ kind: 'text', tone: 'neutral' })
    expect(fileIconInfo('/repo/description')).toEqual({ kind: 'file', tone: 'neutral' })
  })

  it('renders the category as a non-text visual cue', () => {
    const html = renderToStaticMarkup(<FileTypeIcon path="/repo/model.py" size={16} />)
    expect(html).toContain('data-file-icon-kind="python"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('width:16px')
  })
})
