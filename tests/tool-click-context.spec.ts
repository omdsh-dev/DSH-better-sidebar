// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  isReadTool,
  isEditTool,
  findFilePathInTool,
  findTargetLineInTool,
  trackToolClick,
  getLastToolContext,
  setLastToolContextForTest,
} from '../src/client/tool-click-context.ts'

afterEach(() => {
  document.body.innerHTML = ''
  setLastToolContextForTest(null)
})

describe('isReadTool', () => {
  it('identifies read tool variants', () => {
    expect(isReadTool('read')).toBe(true)
    expect(isReadTool('read_file')).toBe(true)
    expect(isReadTool('read_image')).toBe(true)
    expect(isReadTool('READ')).toBe(true)
  })

  it('rejects non-read tools', () => {
    expect(isReadTool('edit')).toBe(false)
    expect(isReadTool('write')).toBe(false)
    expect(isReadTool('bash')).toBe(false)
    expect(isReadTool('subagent')).toBe(false)
    expect(isReadTool(null)).toBe(false)
    expect(isReadTool(undefined)).toBe(false)
  })
})

describe('isEditTool', () => {
  it('identifies edit and write tool variants', () => {
    expect(isEditTool('edit')).toBe(true)
    expect(isEditTool('write')).toBe(true)
    expect(isEditTool('str_replace_editor')).toBe(true)
    expect(isEditTool('edit_file')).toBe(true)
  })

  it('rejects non-edit tools', () => {
    expect(isEditTool('read')).toBe(false)
    expect(isEditTool('bash')).toBe(false)
    expect(isEditTool('subagent')).toBe(false)
    expect(isEditTool(null)).toBe(false)
  })
})

describe('findFilePathInTool', () => {
  it('finds file path from fileLink button', () => {
    const el = document.createElement('div')
    const btn = document.createElement('button')
    btn.className = 'some_fileLink_class'
    btn.textContent = 'src/client/TextEditor.tsx'
    el.appendChild(btn)

    expect(findFilePathInTool(el)).toBe('src/client/TextEditor.tsx')
  })

  it('finds file path from summary span', () => {
    const el = document.createElement('div')
    const span = document.createElement('span')
    span.className = 'some_summary_class'
    span.textContent = 'src/client/DiffTab.tsx'
    el.appendChild(span)

    expect(findFilePathInTool(el)).toBe('src/client/DiffTab.tsx')
  })

  it('finds file path from JSON argument text', () => {
    const el = document.createElement('div')
    el.textContent = '{"file_path": "src/utils/math.ts", "offset": 50}'

    expect(findFilePathInTool(el)).toBe('src/utils/math.ts')
  })
})

describe('findTargetLineInTool', () => {
  it('extracts line number from element with number class', () => {
    const el = document.createElement('div')
    const numSpan = document.createElement('span')
    numSpan.className = 'row_number'
    numSpan.textContent = '42'
    el.appendChild(numSpan)

    expect(findTargetLineInTool(el)).toBe(42)
  })

  it('extracts offset from JSON arguments in text', () => {
    const el = document.createElement('div')
    el.textContent = '{"file_path": "a.ts", "offset": 128}'

    expect(findTargetLineInTool(el)).toBe(128)
  })
})

describe('trackToolClick and getLastToolContext', () => {
  it('records read tool click context accurately', () => {
    const toolEl = document.createElement('div')
    toolEl.setAttribute('data-tool', 'read')
    toolEl.setAttribute('data-variant', 'read')
    const btn = document.createElement('button')
    btn.className = 'fileLink'
    btn.textContent = 'src/test.ts'
    toolEl.appendChild(btn)
    document.body.appendChild(toolEl)

    const event = new MouseEvent('click', { bubbles: true })
    Object.defineProperty(event, 'target', { value: btn })

    trackToolClick(event)

    const ctx = getLastToolContext()
    expect(ctx).not.toBeNull()
    expect(ctx?.isRead).toBe(true)
    expect(ctx?.isEdit).toBe(false)
    expect(ctx?.tool).toBe('read')
  })

  it('records edit tool click context accurately', () => {
    const toolEl = document.createElement('div')
    toolEl.setAttribute('data-tool', 'edit')
    toolEl.setAttribute('data-variant', 'edit')
    const btn = document.createElement('button')
    toolEl.appendChild(btn)
    document.body.appendChild(toolEl)

    const event = new MouseEvent('click', { bubbles: true })
    Object.defineProperty(event, 'target', { value: btn })

    trackToolClick(event)

    const ctx = getLastToolContext()
    expect(ctx).not.toBeNull()
    expect(ctx?.isRead).toBe(false)
    expect(ctx?.isEdit).toBe(true)
    expect(ctx?.tool).toBe('edit')
  })
})
