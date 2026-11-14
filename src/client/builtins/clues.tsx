/**
 * The built-in "Clues" tab (S9): the entry point of the clue collection.
 *
 * The page is registered through the same public tab registry external plugins
 * use. It is ONE instance per overlay (`single`): the pack library and the
 * source browser both address the current session's workspace, never a cwd, so
 * a second copy of the page would only duplicate the same queries.
 */
import { IconFullscreenOutlineRegular, IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CLUE_WINDOW_SURFACE_DEFAULT, CLUE_WINDOW_SURFACE_SETTING } from '../../prefs-shared.ts'
import { t } from '../locales.ts'
import { CluesTab } from '../clues/tab/CluesTab.tsx'
import { cluesTabIcon } from './tab-icons.tsx'
import type { TabDescriptor } from '../service.ts'

/** The clue tab descriptor (aggregated by `registerBuiltins`). */
export const cluesTab: TabDescriptor = {
  id: 'clues',
  title: () => t('clueTabTitle'),
  description: () => t('guideDescClues'),
  icon: cluesTabIcon,
  // Between Changes (20) and Tasks (30): the page is a working surface, not a
  // diagnostic, and the four host-facing pages keep their own order.
  order: 25,
  single: true,
  settings: {
    pluginToggles: [{
      key: CLUE_WINDOW_SURFACE_SETTING,
      type: 'select',
      title: () => t('clueWindowSurfaceTitle'),
      desc: () => t('clueWindowSurfaceDesc'),
      options: [
        {
          value: CLUE_WINDOW_SURFACE_DEFAULT,
          icon: (size: number) => <IconPanelLeftOutlineRegular size={size} />,
          title: () => t('clueWindowSurfaceSidebar'),
        },
        {
          value: 'floating',
          icon: (size: number) => <IconFullscreenOutlineRegular size={size} />,
          title: () => t('clueWindowSurfaceFloating'),
        },
      ],
    }],
  },
  component: ({ ctx, store, scope, visible }) => (
    <CluesTab ctx={ctx} store={store} scope={scope} visible={visible} />
  ),
}
