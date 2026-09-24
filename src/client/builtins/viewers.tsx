/**
 * The 4 built-in file viewer descriptors (video / markdown / html / code),
 * exactly like external plugins register theirs.
 *
 * DSH 0.1.7 ships `ui-sidebar-documentpreview`, its own code / spreadsheet /
 * office / pdf / image / html / markdown / text previews with zoom and
 * auto-refresh, so this plugin yields every READ-ONLY preview it used to own
 * and keeps only the surfaces where it is not equivalent:
 *  - `markdown` — this plugin's own renderer (front matter, embedded HTML
 *    sanitation, floating TOC), which the user prefers to the host's;
 *  - `html` — the sandboxed iframe preview plus the host-less
 *    `htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe` escape hatches;
 *  - `code` — the catch-all (`exts: []`, lowest priority) that claims any
 *    file no other viewer did, and it is an EDITABLE CodeMirror with save —
 *    the host's equivalents are read-only previews.
 * The yielded ids (image / pdf / binary-download) are deliberately NOT
 * registered here; an external plugin may still claim them through this
 * service. VIDEO is the exception that earns its place: the host ships no
 * video preview, so the plugin keeps a `video` viewer (a native `<video>`
 * playing through the byte-range `/sidebar/file` route) rather than pointing
 * readers at an ecosystem plugin for it. Office previews (.docx / .xlsx / .pptx) were already not built
 * in — they live in the recommended office plugin (see plugins-viewers.ts),
 * which registers the same ids through this service.
 *
 * The heavy viewers (the CodeMirror-backed markdown/html/code) render
 * through {@link lazyChunkComponent} wrappers — their libraries are fetched
 * only when such a file is first opened (see chunk-loader.ts). The
 * descriptor metadata (id/exts/priority) is identical either way, so
 * matching semantics and external-plugin overrides are unaffected; the
 * `component` wrapper keeps the descriptor contract `(props) => ReactNode`.
 *
 * Every viewer carries the declarative settings-surface fields — `title`
 * and `icon` — so the Side card settings page can render the enable/disable
 * inventory without hardcoding (eating our own dogfood).
 */
import { IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { lazyChunkComponent } from '../lazy-chunk.tsx'
import { VideoView } from '../VideoView.tsx'
import {
  IconMarkdownOutline16,
  IconHtmlOutline16,
  IconVideoOutline16,
} from '../icons.tsx'
import type { ComponentType } from 'react'
import type { FileViewerDescriptor, FileViewerProps } from '../service.ts'
import { t } from '../locales.ts'

/**
 * Lazy wrapper over the chunk-resident viewer component. The `pick`
 * function is module-level (stable identity — the wrapper effect depends
 * on it); the cast bridges the chunk exports record to the descriptor prop
 * shape (the view reads only its own subset of FileViewerProps).
 */
const LazyTextEditor = lazyChunkComponent<FileViewerProps>('editor', (mod) => mod.TextEditor as ComponentType<FileViewerProps> | undefined)

/**
 * Extensions the built-in video viewer claims (lowercase, no leading dot).
 * Container support is the engine's business — a codec the browser cannot
 * decode renders the pane's own fallback instead of a dead player.
 */
const VIDEO_EXTS: readonly string[] = [
  'mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov', 'qt', 'mkv',
  'avi', 'wmv', 'flv', 'm2ts', 'mpeg', 'mpg', '3gp', '3g2',
]

/** The 4 built-in file viewer descriptors. */
export function builtinViewers(): readonly FileViewerDescriptor[] {
  return [
    {
      id: 'video',
      title: () => t('viewerVideo'),
      icon: (size: number) => <IconVideoOutline16 size={size} />,
      exts: VIDEO_EXTS,
      fetchStrategy: 'mediaUrl',
      component: ({ scope, path, title, mediaUrl }) => (
        <VideoView scope={scope} path={path} title={title} mediaUrl={mediaUrl} />
      ),
    },
    {
      id: 'markdown',
      title: () => t('viewerMarkdown'),
      icon: (size: number) => <IconMarkdownOutline16 size={size} />,
      exts: ['md', 'markdown'],
      fetchStrategy: 'fsRead',
      component: (props) => <LazyTextEditor {...props} />,
    },
    {
      id: 'html',
      title: () => t('viewerHtml'),
      icon: (size: number) => <IconHtmlOutline16 size={size} />,
      exts: ['html', 'htm'],
      fetchStrategy: 'fsRead',
      // Declarative settings: the sandbox escape hatch and the default-unsafe
      // start state render under this viewer's row in the Side card settings
      // page (both warned on).
      settings: {
        toggles: [{
          key: 'htmlViewerNoSandbox',
          title: () => t('settingsHtmlSandboxTitle'),
          desc: () => t('settingsHtmlSandboxDesc'),
        }, {
          key: 'htmlViewerDefaultUnsafe',
          title: () => t('settingsHtmlDefaultUnsafeTitle'),
          desc: () => t('settingsHtmlDefaultUnsafeDesc'),
        }],
      },
      component: (props) => <LazyTextEditor {...props} />,
    },
    {
      id: 'code',
      title: () => t('viewerCode'),
      icon: (size: number) => <IconCodeOutlineRegular size={size} />,
      exts: [],
      priority: -100,
      fetchStrategy: 'fsRead',
      component: (props) => <LazyTextEditor {...props} />,
    },
  ]
}
