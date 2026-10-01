/**
 * A failed save in plain words (round 5, acceptance v3 TH-2): the door's `next` sentence is written for
 * whoever calls the door ("Fix the field named in `field`…"), so a person never reads it. Each known
 * refusal says what happened and what to do; anything else says the words are kept.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_CHARS, charCount, saveErrorOf, textLength } from '../src/client/comment-errors.ts'
import { en, zh } from '../src/client/locales.ts'
import { localeDicts } from '../src/client/chunks/locale.tsx'
import { vi } from '../src/client/locales-vi.ts'

const refusal = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ ok: false as const, status, code, next: 'Fix the field named in `field` and send the request again.', ...extra })

describe('saveErrorOf — the refusal a person reads', () => {
  it('too long: the server\'s own limit when it names one, else the list\'s', () => {
    expect(saveErrorOf(refusal(400, 'COMMENT_TOO_LONG', { maxChars: 4000 }), 5000)).toEqual({ key: 'commentErrTooLong', params: { max: 4000 } })
    expect(saveErrorOf(refusal(400, 'COMMENT_TOO_LONG'), 4000)).toEqual({ key: 'commentErrTooLong', params: { max: 4000 } })
    // An older server: a bad `text` field is its only way to say it.
    expect(saveErrorOf(refusal(400, 'COMMENT_BAD_INPUT', { field: 'text' }), 4000)).toEqual({ key: 'commentErrTooLong', params: { max: 4000 } })
  })

  it('too fast, signed out, no seat, not the author, no connection', () => {
    expect(saveErrorOf(refusal(429, 'COMMENT_RATE_LIMIT'), 4000).key).toBe('commentErrRateLimit')
    expect(saveErrorOf(refusal(429, 'HTTP_429'), 4000).key).toBe('commentErrRateLimit')
    expect(saveErrorOf(refusal(401, 'NOT_SIGNED_IN'), 4000).key).toBe('commentErrSignedOut')
    expect(saveErrorOf(refusal(403, 'SEAT_NOT_AUTHORIZED'), 4000).key).toBe('commentErrNoSeat')
    expect(saveErrorOf(refusal(403, 'SEAT_REQUIRED'), 4000).key).toBe('commentErrNoSeat')
    expect(saveErrorOf(refusal(403, 'COMMENT_NOT_YOURS'), 4000).key).toBe('commentErrNotYours')
    expect(saveErrorOf(refusal(0, 'NETWORK'), 4000).key).toBe('commentErrNetwork')
    expect(saveErrorOf(refusal(503, 'ATTACHMENT_STORE_UNAVAILABLE'), 4000).key).toBe('commentErrFile')
  })

  it('anything else: "Could not save. Your words are kept." — never the door\'s sentence', () => {
    for (const r of [refusal(500, 'BROKEN'), refusal(400, 'COMMENT_BAD_INPUT', { field: 'element' }), refusal(200, 'BAD_ANSWER')]) {
      expect(saveErrorOf(r, 4000)).toEqual({ key: 'commentErrUnknown' })
    }
    expect(en.commentErrUnknown).toBe('Could not save. Your words are kept. Try again.')
  })

  it('no message is developer text, none has an em dash, and every one is translated with its holes', () => {
    const keys = ['commentErrTooLong', 'commentErrRateLimit', 'commentErrSignedOut', 'commentErrNoSeat', 'commentErrNotYours', 'commentErrNetwork', 'commentErrFile', 'commentErrUnknown', 'commentRootDeleted'] as const
    const dicts = { zh, vi, ...localeDicts } as Record<string, Record<string, string>>
    for (const key of keys) {
      expect(en[key], key).not.toMatch(/—|`|field|GET |POST |\{\w+\}\s*$/u)
      for (const [lang, dict] of Object.entries(dicts)) {
        expect(dict[key], `${lang}.${key}`).toBeTruthy()
        expect(dict[key], `${lang}.${key}`).not.toBe(en[key])
        expect(dict[key], `${lang}.${key}`).not.toContain('—')
        for (const hole of en[key].match(/\{\w+\}/g) ?? []) expect(dict[key], `${lang}.${key}`).toContain(hole)
      }
    }
  })
})

describe('the character count near the limit', () => {
  it('round 6: reads "3600 / 4000" in every language, as the Comments tab\'s box does (numbers, no words)', () => {
    const dicts = { en, zh, vi, ...localeDicts } as Record<string, Record<string, string>>
    for (const [lang, dict] of Object.entries(dicts)) expect(dict.commentCharCount, lang).toBe('{count} / {max}')
  })


  it('counts what the server counts: the trimmed words in UTF-16 units', () => {
    expect(textLength('  abc \n')).toBe(3)
    expect(textLength('😀')).toBe(2)
  })

  it('hidden well under the limit, shown from 90 %, over past it', () => {
    expect(charCount('a'.repeat(100), 4000)).toEqual({ shown: false, over: false, length: 100, max: 4000 })
    expect(charCount('a'.repeat(3600), 4000)).toEqual({ shown: true, over: false, length: 3600, max: 4000 })
    expect(charCount('a'.repeat(4000), 4000)).toEqual({ shown: true, over: false, length: 4000, max: 4000 })
    expect(charCount('a'.repeat(4001), 4000)).toEqual({ shown: true, over: true, length: 4001, max: 4000 })
  })

  it('the default when the list names no limit', () => {
    expect(DEFAULT_MAX_CHARS).toBe(4000)
  })
})
