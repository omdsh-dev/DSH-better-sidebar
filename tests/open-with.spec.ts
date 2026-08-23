/**
 * The file tree "open with" pure logic: config parsing (tolerant), target
 * resolution (built-ins + custom, SSH filtering), URL building (local file
 * URLs and VSCode-family SSH-remote URLs) and the custom-editor validators.
 */
import { describe, expect, it } from 'vitest'
import {
  isValidCustomEditor,
  newCustomEditorId,
  normalizeUrlPath,
  openWithSshActive,
  openWithUrl,
  parseOpenWithConfig,
  resolveOpenWithTargets,
  type CustomEditor,
  type OpenWithTarget,
} from '../src/client/open-with.ts'

describe('parseOpenWithConfig', () => {
  it('returns the defaults for null / non-object / array values', () => {
    expect(parseOpenWithConfig(null)).toEqual({ sshHost: '', customEditors: [], pinned: [] })
    expect(parseOpenWithConfig('junk')).toEqual({ sshHost: '', customEditors: [], pinned: [] })
    expect(parseOpenWithConfig([])).toEqual({ sshHost: '', customEditors: [], pinned: [] })
  })

  it('keeps structurally valid custom editors (incl. in-progress rows) and drops junk', () => {
    const config = parseOpenWithConfig({
      sshHost: 'dev',
      customEditors: [
        { id: 'a', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false },
        { id: 'b', name: '', urlTemplate: 'b://file/{path}', isVscodeFamily: true },
        { id: 'c', name: 'Trae', urlTemplate: 'trae://file/{path}', isVscodeFamily: true },
        'junk',
        null,
        42,
      ],
      pinned: ['vscode', 'custom:a', 42, '', 'custom:c'],
    })
    expect(config.sshHost).toBe('dev')
    expect(config.customEditors.map(editor => editor.id)).toEqual(['a', 'b', 'c'])
    expect(config.pinned).toEqual(['vscode', 'custom:a', 'custom:c'])
  })
})

describe('resolveOpenWithTargets', () => {
  const localCustom: CustomEditor = { id: 'e1', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false }
  const familyCustom: CustomEditor = { id: 'e2', name: 'Zed-like fork', urlTemplate: 'x-zed://file/{path}', isVscodeFamily: true }

  it('lists built-ins first, then custom editors (local mode)', () => {
    const targets = resolveOpenWithTargets(parseOpenWithConfig({ customEditors: [localCustom] }))
    expect(targets.map(target => target.id)).toEqual(['explorer', 'vscode', 'cursor', 'zed', 'custom:e1'])
    expect(targets[0]?.kind).toBe('reveal')
    expect(targets[1]?.urlTemplate).toBe('vscode://file/{path}')
  })

  it('excludes incomplete custom-editor rows from the menu (they stay in the blob)', () => {
    const targets = resolveOpenWithTargets(parseOpenWithConfig({
      customEditors: [
        { id: 'e1', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false },
        { id: 'e2', name: '', urlTemplate: 'incomplete://file/{path}', isVscodeFamily: true },
      ],
    }))
    expect(targets.map(target => target.id)).toEqual(['explorer', 'vscode', 'cursor', 'zed', 'custom:e1'])
  })

  it('drops local-only targets in SSH mode (file manager, Zed, non-VSCode custom)', () => {
    const config = parseOpenWithConfig({ sshHost: 'dev', customEditors: [localCustom, familyCustom] })
    const targets = resolveOpenWithTargets(config)
    expect(targets.map(target => target.id)).toEqual(['vscode', 'cursor', 'custom:e2'])
  })

  it('prunes unknown pinned ids only when resolving (the parse keeps them)', () => {
    const config = parseOpenWithConfig({ pinned: ['ghost'] })
    expect(config.pinned).toEqual(['ghost'])
    expect(resolveOpenWithTargets(config).map(target => target.id)).toContain('vscode')
  })
})

describe('openWithUrl', () => {
  const targets = resolveOpenWithTargets(parseOpenWithConfig({}))
  const byId = (id: string): OpenWithTarget => {
    const target = targets.find(item => item.id === id)
    if (target === undefined) throw new Error(`no target ${id}`)
    return target
  }

  it('builds local file URLs with the raw path (backslashes normalized)', () => {
    expect(openWithUrl(byId('vscode'), '/home/u/f.ts', parseOpenWithConfig({}))).toBe('vscode://file//home/u/f.ts')
    expect(openWithUrl(byId('vscode'), 'C:\\Users\\u\\f.ts', parseOpenWithConfig({}))).toBe('vscode://file/C:/Users/u/f.ts')
    expect(openWithUrl(byId('zed'), '/x/y', parseOpenWithConfig({}))).toBe('zed://file//x/y')
  })

  it('builds SSH-remote URLs for VSCode-family targets in SSH mode', () => {
    const config = parseOpenWithConfig({ sshHost: 'dev' })
    expect(openWithUrl(byId('vscode'), '/home/u/f.ts', config))
      .toBe('vscode://vscode-remote/ssh-remote+dev/home/u/f.ts')
    expect(openWithUrl(byId('cursor'), '/home/u/f.ts', config))
      .toBe('cursor://vscode-remote/ssh-remote+dev/home/u/f.ts')
  })

  it('keeps the local URL form for non-VSCode-family targets even in SSH mode', () => {
    // (Such targets are hidden from the SSH menu; the URL builder stays honest.)
    expect(openWithUrl(byId('zed'), '/x', parseOpenWithConfig({ sshHost: 'dev' }))).toBe('zed://file//x')
  })

  it('returns undefined for reveal targets and malformed templates', () => {
    expect(openWithUrl(byId('explorer'), '/x', parseOpenWithConfig({}))).toBeUndefined()
    const noScheme: OpenWithTarget = { id: 'x', name: '', kind: 'url', urlTemplate: 'not-a-url {path}', isVscodeFamily: false, localOnly: false }
    expect(openWithUrl(noScheme, '/x', parseOpenWithConfig({}))).toBeUndefined()
    const noSlash: OpenWithTarget = { id: 'y', name: '', kind: 'url', urlTemplate: 'a:file/{path}', isVscodeFamily: false, localOnly: false }
    expect(openWithUrl(noSlash, '/x', parseOpenWithConfig({}))).toBeUndefined()
  })

  it('uses the custom template scheme for SSH URLs of VSCode-family custom editors', () => {
    const config = parseOpenWithConfig({
      sshHost: 'dev',
      customEditors: [
        { id: 'e', name: 'Fork', urlTemplate: 'myfork://file/{path}', isVscodeFamily: true },
      ],
    })
    const targets = resolveOpenWithTargets(config)
    expect(openWithUrl(targets[targets.length - 1]!, '/r/f.ts', config))
      .toBe('myfork://vscode-remote/ssh-remote+dev/r/f.ts')
  })
})

describe('helpers', () => {
  it('normalizeUrlPath converts backslashes to slashes', () => {
    expect(normalizeUrlPath('a\\b\\c')).toBe('a/b/c')
  })

  it('openWithSshActive trims the host', () => {
    expect(openWithSshActive(parseOpenWithConfig({ sshHost: '  ' }))).toBe(false)
    expect(openWithSshActive(parseOpenWithConfig({ sshHost: ' dev ' }))).toBe(true)
  })

  it('isValidCustomEditor requires a name, a {path} placeholder and a scheme:// prefix', () => {
    expect(isValidCustomEditor({ name: 'A', urlTemplate: 'a://file/{path}' })).toBe(true)
    expect(isValidCustomEditor({ name: '', urlTemplate: 'a://file/{path}' })).toBe(false)
    expect(isValidCustomEditor({ name: 'A', urlTemplate: 'a://file/x' })).toBe(false)
    expect(isValidCustomEditor({ name: 'A', urlTemplate: 'a:file/{path}' })).toBe(false)
  })

  it('newCustomEditorId yields unique non-empty ids', () => {
    const first = newCustomEditorId()
    const second = newCustomEditorId()
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThan(0)
  })
})
