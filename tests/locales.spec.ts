/**
 * Locale-following spec: the sidebar copy follows the DSH locale service
 * (`ctx.locale`, provided by @deepseek-ai/dsh-client-locale) when attached
 * through `attachLocale`, and falls back to the browser language otherwise.
 * Covers attach/detach, live switching, dictionary parity, and placeholder
 * interpolation.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { LOCALE_NS, attachLocale, attachLocaleDicts, chatT, en, isZh, localeSignature, relativeTime, t, zh } from '../src/client/locales.ts'
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
  attachLocaleDicts({})
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
    expect(t('explorer')).toBe('资源管理器')
    expect(isZh()).toBe(true)

    // Live switch: the service's active locale wins even though the
    // browser still asks for en-US.
    locale.switchTo('en')
    expect(t('explorer')).toBe('Explorer')
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

  it('names the existing changes entry Git in every shipped locale', () => {
    // Keep the translation key (and the git tab id) stable: this is display
    // copy only. Check raw dictionaries so English fallback cannot hide a miss.
    for (const [lang, dict] of Object.entries({ zh, en, ...localeDicts })) {
      expect(dict.changes, lang).toBe('Git')
    }
  })

  it('keeps the zh and en dictionaries key-set-equal', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('keeps every lazily loaded dictionary key-set-equal to zh', () => {
    // The lazy dicts live in the lazy locale chunk typed as plain
    // records (the chunk boundary has no key-set type tie to zh). This test
    // catches missing/extra keys introduced when a zh key is added without
    // updating every language — a missing key silently falls back to en.
    for (const [lang, dict] of Object.entries(localeDicts)) {
      expect(Object.keys(dict).sort(), lang).toEqual(Object.keys(zh).sort())
    }
  })
})

/**
 * A locale service whose `bind` reads instance state, exactly like DSH's own
 * (`LocaleRuntime.bind` touches `this.bound`). A detached call — the natural
 * refactor `const bind = service.bind; bind('chat')` — throws here, which is
 * what a real host did before the mount lane caught it.
 */
class FakeLocaleWithBind {
  active = 'zh'
  private readonly dicts: Record<string, Record<string, string>> = {
    chat: { 'message.stepProcess.done.read': '已读取文件' },
  }
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string {
    // The `this` read that makes a detached call blow up.
    const dict: Record<string, string> = this.dicts[ns] ?? {}
    return (key) => dict[key] ?? key
  }
}

describe('locales (host chat namespace bridge)', () => {
  it('reads the host namespace through a METHOD call on the attached service', () => {
    attachLocale(new FakeLocaleWithBind())
    expect(chatT('message.stepProcess.done.read')).toBe('已读取文件')
  })

  it('answers undefined for a namespace or key the host does not serve', () => {
    attachLocale(new FakeLocaleWithBind())
    // An unregistered host namespace resolves to the key itself: the caller
    // must see "unavailable", never the raw `message.…` key.
    expect(chatT('message.stepProcess.read')).toBeUndefined()
  })

  it('answers undefined when the attached face has no bind at all', () => {
    attachLocale({ getSnapshot: () => ({ active: 'en' }) })
    expect(chatT('message.stepProcess.done.read')).toBeUndefined()
    attachLocale(undefined)
    expect(chatT('message.stepProcess.done.read')).toBeUndefined()
  })

  it('never lets a throwing host seam break a render', () => {
    attachLocale({
      getSnapshot: () => ({ active: 'en' }),
      bind: () => { throw new TypeError("Cannot read properties of undefined (reading 'bound')") },
    })
    expect(chatT('message.stepProcess.done.read')).toBeUndefined()
  })
})

describe('locales (official-language dictionaries)', () => {
  it('follows the host locale into a loaded dictionary and falls back to en for a missing key', () => {
    const locale = new FakeLocale()
    attachLocale(locale)
    attachLocaleDicts({ ja: { explorer: 'エクスプローラー', timeMinutesAgo: '{n} 分前' } })

    locale.switchTo('ja')
    expect(t('explorer')).toBe('エクスプローラー')
    expect(t('timeMinutesAgo', { n: 5 })).toBe('5 分前')
    expect(t('terminal')).toBe('Terminal')
    expect(isZh()).toBe(false)

    locale.switchTo('ja-JP')
    expect(t('explorer')).toBe('エクスプローラー')
  })

  it('serves en until the dictionary lands and again once it is detached', () => {
    const locale = new FakeLocale()
    attachLocale(locale)
    locale.switchTo('ja')
    expect(t('explorer')).toBe('Explorer')

    attachLocaleDicts({ ja: { explorer: 'エクスプローラー' } })
    expect(t('explorer')).toBe('エクスプローラー')

    attachLocaleDicts({})
    expect(t('explorer')).toBe('Explorer')
  })

  it('bumps the locale signature when a dictionary attaches or the locale switches', () => {
    const locale = new FakeLocale()
    attachLocale(locale)
    const before = localeSignature()
    attachLocaleDicts({ ja: {} })
    expect(localeSignature()).not.toBe(before)
    const loaded = localeSignature()
    locale.switchTo('ja')
    expect(localeSignature()).not.toBe(loaded)
  })

  it('ships exactly the official host languages beyond zh/en', () => {
    expect(Object.keys(localeDicts).sort()).toEqual(['de', 'es', 'fr', 'ja', 'pt', 'ru'])
  })

  it('keeps every shipped dictionary non-empty and placeholder-equal to en', () => {
    const placeholders = (text: string): string => (text.match(/\{\w+\}/g) ?? []).sort().join(',')
    for (const [lang, dict] of Object.entries(localeDicts)) {
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        const text = dict[key]
        expect(text, `${lang}.${key}`).toBeTruthy()
        expect(placeholders(text!), `${lang}.${key} placeholders`).toBe(placeholders(en[key]))
      }
    }
  })
})
