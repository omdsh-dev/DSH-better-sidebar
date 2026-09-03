/**
 * Locale-following spec: the sidebar copy follows the DSH locale service
 * (`ctx.locale`, provided by @deepseek-ai/dsh-client-locale) when attached
 * through `attachLocale`, and falls back to the browser language otherwise.
 * Covers attach/detach, live switching, dictionary parity, and placeholder
 * interpolation.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { LOCALE_NS, attachBetterLocale, attachLocale, en, isZh, relativeTime, t, zh } from '../src/client/locales.ts'
import { localeDicts } from '../src/client/chunks/locale.tsx'

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
  register(_ns: string, _locale: string, _dict: Record<string, string>): () => void {
    return () => {}
  }
  switchTo(id: string): void {
    this.active = id
  }
}

/** Point the browser-language fallback at a specific language (undefined = none). */
function stubNavigatorLanguage(lang: string | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: lang === undefined ? undefined : { language: lang },
    configurable: true,
  })
}

afterEach(() => {
  attachLocale(undefined)
  attachBetterLocale(undefined)
  stubNavigatorLanguage(undefined)
})

describe('locales (DSH i18n following)', () => {
  it('falls back to the browser language without an attached service', () => {
    stubNavigatorLanguage('en-US')
    expect(t('explorer')).toBe('Explorer')
    expect(isZh()).toBe(false)

    stubNavigatorLanguage('zh-CN')
    expect(t('explorer')).toBe('资源管理器')
    expect(isZh()).toBe(true)
  })

  it('defaults to English when no locale service and no browser language are available', () => {
    expect(t('explorer')).toBe('Explorer')
    expect(isZh()).toBe(false)
  })

  it('follows the attached locale service instead of the browser language', () => {
    stubNavigatorLanguage('en-US')
    const locale = new FakeLocale()
    attachLocale(locale)

    locale.switchTo('zh')
    expect(t('changes')).toBe('文件变动')
    expect(isZh()).toBe(true)

    // Live switch: the service's active locale wins even though the
    // browser still asks for en-US.
    locale.switchTo('en')
    expect(t('changes')).toBe('Changes')
    expect(isZh()).toBe(false)
  })

  it('detaches back to the browser-language fallback', () => {
    const locale = new FakeLocale()
    locale.switchTo('zh')
    attachLocale(locale)
    expect(t('terminal')).toBe('终端')

    stubNavigatorLanguage('en-US')
    attachLocale(undefined)
    expect(t('terminal')).toBe('Terminal')
  })

  it('interpolates {name} placeholders in the active locale', () => {
    const locale = new FakeLocale()
    attachLocale(locale)
    locale.switchTo('zh')
    expect(t('timeMinutesAgo', { n: 5 })).toBe('5 分钟前')
    locale.switchTo('en')
    expect(t('timeMinutesAgo', { n: 5 })).toBe('5 min ago')
  })

  it('drives the relative-time chain through the active locale', () => {
    const locale = new FakeLocale()
    attachLocale(locale)
    locale.switchTo('zh')
    expect(relativeTime(new Date().toISOString())).toBe('刚刚')
    locale.switchTo('en')
    expect(relativeTime(new Date().toISOString())).toBe('just now')
  })

  it('registers a namespace distinct from DSH ui-sidebar\'s own \'sidebar\'', () => {
    expect(LOCALE_NS).toBe('betterSidebar')
  })

  it('keeps the zh and en dictionaries key-set-equal', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('keeps every shipped third-language dictionary key-set-equal to zh', () => {
    // The third-language dicts live in the lazy locale chunk typed as plain
    // records (the chunk boundary has no key-set type tie to zh). This test
    // catches missing/extra keys introduced when a zh key is added without
    // updating every language — a missing key silently falls back to en.
    for (const [lang, dict] of Object.entries(localeDicts)) {
      expect(Object.keys(dict).sort(), lang).toEqual(Object.keys(zh).sort())
    }
    expect(Object.keys(localeDicts), 'every shipped third language rides the locale chunk').toContain('ja')
  })
})

/** Minimal fake of the better-locale override store (the subset t()/isZh() read). */
class FakeBetterLocale {
  active: string | undefined = undefined
  private readonly dict: Record<string, Record<string, Record<string, string>>>
  constructor(dict: Record<string, Record<string, Record<string, string>>>) {
    this.dict = dict
  }
  getOverride(dshActive: string, ns: string, key: string): string | undefined {
    if (this.active === undefined) return undefined
    if (dshActive !== 'en') return undefined
    return this.dict[ns]?.[this.active]?.[key]
  }
  isOverrideActive(dshActive: string): boolean {
    return this.active !== undefined && dshActive === 'en'
  }
  subscribe(_listener: () => void): () => void {
    return () => {}
  }
}

describe('locales (better-locale override)', () => {
  it('returns the override text when an override is active and the key exists', () => {
    const locale = new FakeLocale()
    locale.switchTo('en')
    attachLocale(locale)

    const betterLocale = new FakeBetterLocale({
      [LOCALE_NS]: { ja: { explorer: 'エクスプローラー' } },
    })
    betterLocale.active = 'ja'
    attachBetterLocale(betterLocale)

    expect(t('explorer')).toBe('エクスプローラー')
    expect(isZh()).toBe(false)
  })

  it('falls back to the zh/en chain when override is active but the key is missing', () => {
    const locale = new FakeLocale()
    locale.switchTo('en')
    attachLocale(locale)

    const betterLocale = new FakeBetterLocale({
      [LOCALE_NS]: { ja: { explorer: 'エクスプローラー' } },
    })
    betterLocale.active = 'ja'
    attachBetterLocale(betterLocale)

    // 'changes' has no ja entry in this fake; should fall back to the en text.
    expect(t('changes')).toBe('Changes')
  })

  it('falls back to the zh/en chain when no override is active', () => {
    const locale = new FakeLocale()
    locale.switchTo('zh')
    attachLocale(locale)

    const betterLocale = new FakeBetterLocale({
      [LOCALE_NS]: { ja: { explorer: 'エクスプローラー' } },
    })
    // active is undefined — no override.
    attachBetterLocale(betterLocale)

    expect(t('explorer')).toBe('资源管理器')
    expect(isZh()).toBe(true)
  })

  it('override is inert while DSH is on zh (override borrows the en slot)', () => {
    const locale = new FakeLocale()
    locale.switchTo('zh')
    attachLocale(locale)

    const betterLocale = new FakeBetterLocale({
      [LOCALE_NS]: { ja: { explorer: 'エクスプローラー' } },
    })
    betterLocale.active = 'ja'
    attachBetterLocale(betterLocale)

    // Override is set to 'ja' but DSH is on zh — override is inert,
    // native zh text wins. The user must switch DSH to en to see ja.
    expect(t('explorer')).toBe('资源管理器')
    expect(isZh()).toBe(true)
  })

  it('returns to the zh/en chain after detaching the override store', () => {
    const locale = new FakeLocale()
    locale.switchTo('en')
    attachLocale(locale)

    const betterLocale = new FakeBetterLocale({
      [LOCALE_NS]: { ja: { explorer: 'エクスプローラー' } },
    })
    betterLocale.active = 'ja'
    attachBetterLocale(betterLocale)
    expect(t('explorer')).toBe('エクスプローラー')

    attachBetterLocale(undefined)
    expect(t('explorer')).toBe('Explorer')
    expect(isZh()).toBe(false)
  })

  it('interpolates {name} placeholders in the override text', () => {
    const locale = new FakeLocale()
    locale.switchTo('en')
    attachLocale(locale)

    const betterLocale = new FakeBetterLocale({
      [LOCALE_NS]: { ja: { timeMinutesAgo: '{n} 分前' } },
    })
    betterLocale.active = 'ja'
    attachBetterLocale(betterLocale)

    expect(t('timeMinutesAgo', { n: 5 })).toBe('5 分前')
  })

  it('ships a ja dictionary whose every key resolves to a non-empty string', () => {
    // Smoke-check the shipped ja dict: every key in zh must have a non-empty
    // ja entry. This catches copy-paste mistakes where a key was added to zh
    // but its ja translation was left blank or missing.
    const locale = new FakeLocale()
    locale.switchTo('en')
    attachLocale(locale)

    const betterLocale = new FakeBetterLocale({ [LOCALE_NS]: { ja: localeDicts.ja! } })
    betterLocale.active = 'ja'
    attachBetterLocale(betterLocale)

    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      const text = t(key)
      expect(text, `ja translation for "${key}"`).toBeTruthy()
      expect(text, `ja translation for "${key}"`).not.toBe(key)
    }
  })
})
