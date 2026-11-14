/**
 * Lazy chunk entry: the official host languages beyond zh/en. Built as
 * `lib/client-locale.js` and fetched from /sidebar/bundle only when the host
 * is on one of them — never import this module from the core bundle.
 */
import { ja } from '../locales-ja.ts'
import { de } from '../locales-de.ts'
import { es } from '../locales-es.ts'
import { fr } from '../locales-fr.ts'
import { pt } from '../locales-pt.ts'
import { ru } from '../locales-ru.ts'
import type { CopyKey } from '../locales.ts'

/** Key-set check against zh (type-only, erased before bundling). */
const checked = (dict: Record<CopyKey, string>): Record<string, string> => dict

/** Every lazily loaded dictionary, keyed by host locale id. */
export const localeDicts: Record<string, Record<string, string>> = {
  ja: checked(ja),
  de: checked(de),
  es: checked(es),
  fr: checked(fr),
  pt: checked(pt),
  ru: checked(ru),
}
