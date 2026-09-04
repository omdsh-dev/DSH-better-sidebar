/**
 * Lazy chunk entry: the 19 non-zh/en dictionaries (ja/de/fr/…/zh-HK/MO/TW —
 * ~640KB of source). The sidebar's own `t()` only ever consults zh/en plus
 * the better-locale override store, so these dicts are needed ONLY when
 * @huanlin/dsh-plugin-better-locale is installed: they register into its
 * override store from there (see the client apply's better-locale
 * integration). Built as `lib/client-locale.js` and fetched from the
 * plugin's /sidebar/bundle route on first need — never import this module
 * from the core bundle: it would drag every language back into the startup
 * path (see docs/plans/2026-08-31-perf-optimization.md).
 */
import { ja } from '../locales-ja.ts'
import { de } from '../locales-de.ts'
import { fr } from '../locales-fr.ts'
import { pt } from '../locales-pt.ts'
import { ko } from '../locales-ko.ts'
import { ar } from '../locales-ar.ts'
import { hi } from '../locales-hi.ts'
import { id } from '../locales-id.ts'
import { tr } from '../locales-tr.ts'
import { vi } from '../locales-vi.ts'
import { th } from '../locales-th.ts'
import { ru } from '../locales-ru.ts'
import { it } from '../locales-it.ts'
import { nl } from '../locales-nl.ts'
import { sv } from '../locales-sv.ts'
import { pl } from '../locales-pl.ts'
import { zhHK } from '../locales-zh-HK.ts'
import { zhTW } from '../locales-zh-TW.ts'
import { zhMO } from '../locales-zh-MO.ts'
import type { CopyKey } from '../locales.ts'

/** Key-set check against zh (type-only import — erased before bundling, so
 *  this adds no runtime tie to the core bundle): a dictionary missing or
 *  adding a key fails the build instead of silently falling back to en. */
const checked = (dict: Record<CopyKey, string>): Record<string, string> => dict

/** Every non-zh/en dictionary keyed by its override id, ready for the
 *  better-locale store's `register(ns, dicts)`. */
export const localeDicts: Record<string, Record<string, string>> = {
  ja: checked(ja),
  de: checked(de),
  fr: checked(fr),
  pt: checked(pt),
  ko: checked(ko),
  ar: checked(ar),
  hi: checked(hi),
  id: checked(id),
  tr: checked(tr),
  vi: checked(vi),
  th: checked(th),
  ru: checked(ru),
  it: checked(it),
  nl: checked(nl),
  sv: checked(sv),
  pl: checked(pl),
  'zh-HK': checked(zhHK),
  'zh-TW': checked(zhTW),
  'zh-MO': checked(zhMO),
}
