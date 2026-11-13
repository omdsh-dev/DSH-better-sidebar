/** UI19 scope projection never confuses body editing with comment creation. */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/clues/request-gate.ts', () => vi.importActual('./fixtures/clues-source-request-gate.ts'))
import { capabilitiesForScopes, scopesForCapabilities } from '../src/clues/sources/feishu/auth.ts'

describe('Feishu separate comment grants', () => {
  it('projects read and write grants independently from body scopes', () => {
    expect(capabilitiesForScopes(['docx:document', 'task:task:write'])).not.toContain('docs.comments.write')
    expect(capabilitiesForScopes(['docx:document', 'task:task:write'])).not.toContain('tasks.comments.write')
    const read = capabilitiesForScopes(['docs:document.comment:read', 'task:comment:read'])
    expect(read).toContain('docs.comments.read')
    expect(read).toContain('tasks.comments.read')
    expect(read).not.toContain('docs.comments.write')
    expect(read).not.toContain('tasks.comments.write')
    const writeOnly = capabilitiesForScopes(['docs:document.comment:create', 'task:comment:writeonly'])
    expect(writeOnly).toContain('docs.comments.write')
    expect(writeOnly).toContain('tasks.comments.write')
    expect(writeOnly).not.toContain('docs.comments.read')
    expect(writeOnly).not.toContain('tasks.comments.read')
  })
  it('requests precise incremental comment and optional people scopes', () => {
    expect(scopesForCapabilities(['docs.comments.read', 'docs.comments.write', 'tasks.comments.read', 'tasks.comments.write', 'people.read'])).toEqual([
      'docs:document.comment:read', 'docs:document.comment:create', 'task:comment:read', 'task:comment:writeonly', 'contact:contact.base:readonly', 'contact:user.base:readonly',
    ])
  })
})
