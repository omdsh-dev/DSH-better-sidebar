import { describe, expect, it } from 'vitest'
import { defaultEditorMode, editorModesFor, restoredEditorMode } from '../src/client/editor-modes.ts'

describe('text editor modes', () => {
  it('offers only Visual and Source for Markdown files', () => {
    expect(editorModesFor('markdown')).toEqual(['visual', 'edit'])
    expect(defaultEditorMode('markdown')).toBe('visual')
  })

  it('keeps Preview available for HTML files', () => {
    expect(editorModesFor('html')).toEqual(['preview', 'edit'])
    expect(defaultEditorMode('html')).toBe('preview')
  })

  it('migrates stored Markdown Preview drafts to Visual mode', () => {
    expect(restoredEditorMode('markdown', 'preview')).toBe('visual')
    expect(restoredEditorMode('markdown', 'visual')).toBe('visual')
    expect(restoredEditorMode('markdown', 'edit')).toBe('edit')
  })
})
