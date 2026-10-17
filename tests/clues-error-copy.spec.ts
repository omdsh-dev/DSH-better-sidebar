// @vitest-environment jsdom
/**
 * Client-side clue failure copy (S9).
 *
 * The wire already carries the stable S1 category as the envelope `code`.
 * This spec pins that the client reads BOTH the host's `SidebarApiError` (the
 * real production shape) and a direct `ClueError` (tests / in-process
 * callers), and that each actionable category renders its own next step
 * instead of the generic failure line.
 */
import { describe, expect, it } from 'vitest'
import { SidebarApiError } from '../src/client/api.ts'
import { categoryOf, clueErrorHint, clueErrorMessage } from '../src/client/clues/copy.ts'
import { ClueError } from '../src/clues/error.ts'
import { t } from '../src/client/locales.ts'

Object.defineProperty(globalThis.navigator, 'language', { configurable: true, value: 'en-US' })

describe('clue error copy', () => {
  it('reads the category from a wire SidebarApiError code', () => {
    expect(categoryOf(new SidebarApiError('conflict', 'stale'))).toBe('conflict')
    expect(categoryOf(new SidebarApiError('auth-required', 'login'))).toBe('auth-required')
  })

  it('still reads a direct ClueError category', () => {
    expect(categoryOf(new ClueError('permission-denied', 'no access'))).toBe('permission-denied')
  })

  it('treats an unknown code or plain error as a generic failure', () => {
    expect(categoryOf(new SidebarApiError('http', 'HTTP 500'))).toBe('failed')
    expect(categoryOf(new Error('boom'))).toBe('failed')
    expect(categoryOf(undefined)).toBe('failed')
  })

  it.each([
    ['auth-required', 'Not authorized'],
    ['permission-denied', 'Insufficient permissions'],
    ['dependency-missing', 'Missing dependency'],
    ['dependency-incompatible', 'Missing dependency'],
  ])('renders the actionable copy for %s', (code, hint) => {
    expect(clueErrorMessage(new SidebarApiError(code, 'wire message'), t('clueDetailFailed')))
      .toBe(`${t('error')}: ${hint}`)
  })

  it('renders the missing-source copy instead of a generic failure', () => {
    expect(clueErrorHint('source-missing')).toBe(t('clueSourcesUnavailable'))
    expect(clueErrorMessage(new SidebarApiError('source-missing', 'not installed'), 'fallback'))
      .toContain(t('clueSourcesUnavailable'))
  })

  it('leaves a conflict to the caller (it keeps the draft, not a hint line)', () => {
    expect(clueErrorHint('conflict')).toBeUndefined()
    expect(clueErrorMessage(new SidebarApiError('conflict', 'stale'), 'fallback')).toBe('fallback')
  })
})
