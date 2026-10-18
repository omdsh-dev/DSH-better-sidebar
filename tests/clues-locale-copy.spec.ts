/**
 * S9 locale wiring for the S4/S5 client halves.
 *
 * S4 (Feishu renderers) and S5 (`@` triggers) accept their user-visible copy
 * through options. This spec pins that S9:
 * - supplies EVERY Feishu label key (no default English leaks into zh/ja);
 * - supplies the `@` copy including the content-mode notices and section
 *   heading, with placeholders intact;
 * - keeps the three shipped key sets in sync and translates the critical
 *   labels in zh and ja.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { attachLocale, en, t, zh } from '../src/client/locales.ts'
import { ja } from '../src/client/locales-ja.ts'
import {
  clueMentionsContentSection,
  clueMentionsCopy,
  feishuClientLabels,
} from '../src/client/clues/locale-copy.ts'

/** The complete FeishuClientLabels surface (labels.ts interface order). */
const FEISHU_LABEL_KEYS = [
  'docsName', 'tasksName', 'readOnly', 'xml', 'markdown', 'revision',
  'contentTruncated', 'showFullContent', 'showLess', 'limitedFragment',
  'emptyContent', 'invalidDocument', 'title', 'description', 'emptyDescription',
  'start', 'due', 'allDay', 'completed', 'save', 'saving', 'setTime',
  'titleRequired', 'docsTitleRequired', 'startAfterDue', 'allDayMismatch',
  'taskGuid', 'noTime', 'open', 'docsEditScopeNote', 'blocks', 'blockReadOnly',
  'noBlocks', 'sourceLink', 'resourceLink', 'fetchedAt', 'freshness',
  'freshnessLive', 'freshnessSnapshot', 'fragmentBlocks', 'fragmentBytes',
  'updatedAt', 'markdownReadOnly', 'invalidTask', 'invalidTime',
  'genericValidation',
] as const

/** The locale keys the labels are built from (critical ones translated). */
const CRITICAL_KEYS = [
  'windowReadOnly', 'clueFeishuShowFullContent', 'save', 'clueFeishuFetchedAt',
  'clueFeishuStart', 'clueFeishuDue', 'clueFeishuTitle',
  'clueFeishuSourceLink', 'clueFeishuDocsEditScopeNote',
] as const

class FakeLocale {
  active = 'en'
  getSnapshot(): { active: string } { return { active: this.active } }
  subscribe(): () => void { return () => {} }
  register(): () => void { return () => {} }
  switchTo(id: string): void { this.active = id }
}

afterEach(() => { attachLocale(undefined) })

describe('S9 locale copy wiring', () => {
  it('supplies every Feishu label key', () => {
    const labels = feishuClientLabels()
    for (const key of FEISHU_LABEL_KEYS) {
      expect(labels[key], key).toBeTypeOf('string')
      expect(labels[key], key).not.toBe('')
    }
    // Format names are not sentences.
    expect(labels.xml).toBe('XML')
    expect(labels.markdown).toBe('Markdown')
  })

  it('keeps zh/en/ja key sets equal and translates the critical labels', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(Object.keys(ja).sort()).toEqual(Object.keys(zh).sort())
    for (const key of CRITICAL_KEYS) {
      expect(zh[key as keyof typeof zh], key).toBeTruthy()
      expect(ja[key], key).toBeTruthy()
      expect(ja[key], key).not.toBe(en[key as keyof typeof en])
      if (key !== 'windowReadOnly' && key !== 'save') {
        expect(zh[key as keyof typeof zh], key).not.toBe(en[key as keyof typeof en])
      }
    }
  })

  it('returns Chinese labels when the locale service is on zh', () => {
    const locale = new FakeLocale()
    locale.active = 'zh'
    attachLocale(locale)
    const labels = feishuClientLabels()
    expect(labels.readOnly).toBe('只读')
    expect(labels.showFullContent).toBe('显示完整内容')
    expect(labels.save).toBe('保存')
    expect(labels.fetchedAt).toBe('获取于')
    expect(labels.start).toBe('开始')
    expect(labels.due).toBe('截止')
    expect(labels.sourceLink).toBe('在飞书中打开')
    expect(t('clueFeishuShowFullContent')).toBe('显示完整内容')
  })

  it('passes localized @ copy, content notices and section heading', () => {
    const locale = new FakeLocale()
    locale.active = 'zh'
    attachLocale(locale)
    const copy = clueMentionsCopy()
    expect(copy.includeContentSuffix).toBe('（包含内容）')
    expect(copy.clueContentDescription?.('GitHub', 'Issue')).toContain('GitHub')
    expect(copy.packContentDescription?.(2)).toContain('2')
    expect(copy.packContentDescription?.(2)).toContain('成员')
    expect(copy.packInsertFailed).not.toBe('That clue pack could not be inserted; the draft was left unchanged.')
    expect(copy.contentLimit?.(10, 5)).toContain('10')
    expect(copy.contentLimit?.(10, 5)).toContain('5')
    expect(copy.contentReferenceError?.('malformed')).toContain('草稿已保留')
    expect(copy.contentMissing?.('pack', '[[dsh-cluepack:p1]]')).toContain('[[dsh-cluepack:p1]]')
    expect(copy.packMemberMissing?.('[[dsh-cluepack:p1]]', 'c1')).toContain('c1')
    expect(copy.partialRead?.('[[dsh-clue:x]]', 9)).toContain('9')
    expect(clueMentionsContentSection()).toBe('包含当前内容')
    expect(t('cluePackMembersAdded', { name: '发布线索' })).toContain('发布线索')
    expect(t('clueBrowserSelectRow', { title: 'A note' })).toContain('A note')
  })
})
