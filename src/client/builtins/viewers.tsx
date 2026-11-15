/**
 * The 6 built-in file viewer descriptors (markdown / html / jsonl / image /
 * media / code), exactly like external plugins register theirs.
 *
 * DSH 0.1.7 ships `ui-sidebar-documentpreview`, its own code / spreadsheet /
 * office / pdf / image / html / markdown / text previews with zoom and
 * auto-refresh, so this plugin yields every READ-ONLY preview it used to own
 * and keeps only the surfaces where it is not equivalent:
 *  - `markdown` — this plugin's own renderer (front matter, embedded HTML
 *    sanitation, floating TOC), which the user prefers to the host's;
 *  - `html` — the sandboxed iframe preview plus the host-less
 *    `htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe` escape hatches;
 *  - `jsonl` — a record-per-row preview (the host maps `.jsonl` to its JSON
 *    highlighter but renders it as one long text document) with the JSONL
 *    editor behind the mode toggle;
 *  - `image` — raster images (this release): the host viewport zooms, but it has no
 *    pixel boundary, no pixel grid and no way to say how many pixels a line or
 *    a rectangle spans. This viewer does, and it keeps the bitmap
 *    nearest-neighbour so "100%" really is one image pixel per CSS pixel. SVG
 *    stays with the host: it is vector artwork, where a pixel count means
 *    nothing;
 *  - `media` — the bare `<video>` / `<audio>` player on the file route;
 *  - `code` — the catch-all (`exts: []`, lowest priority) that claims any
 *    file no other viewer did, and it is an EDITABLE CodeMirror with save —
 *    the host's equivalents are read-only previews.
 * The yielded ids (pdf / binary-download) are deliberately NOT registered
 * here; an external plugin may still claim them through this service. Office
 * previews (.docx / .xlsx / .pptx) were already not built in — they live in
 * the recommended office plugin (see plugins-viewers.ts), which registers the
 * same ids through this service.
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
import { IconCodeOutlineRegular, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { lazyChunkComponent } from '../lazy-chunk.tsx'
import {
  IconMarkdownOutline16,
  IconHtmlOutline16,
  IconImageOutline16,
} from '../icons.tsx'
import type { ComponentType } from 'react'
import type { FileViewerDescriptor, FileViewerProps } from '../service.ts'
import { t } from '../locales.ts'
import { MediaPreview } from './media-preview.tsx'
import { ImagePreview } from './image-preview.tsx'

/**
 * Lazy wrapper over the chunk-resident viewer component. The `pick`
 * function is module-level (stable identity — the wrapper effect depends
 * on it); the cast bridges the chunk exports record to the descriptor prop
 * shape (the view reads only its own subset of FileViewerProps).
 */
const LazyTextEditor = lazyChunkComponent<FileViewerProps>('editor', (mod) => mod.TextEditor as ComponentType<FileViewerProps> | undefined)

/** The 6 built-in file viewer descriptors. */
export function builtinViewers(): readonly FileViewerDescriptor[] {
  return [
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
      id: 'jsonl',
      title: () => t('viewerJsonl'),
      icon: (size: number) => <IconCodeOutlineRegular size={size} />,
      // Newline-delimited JSON. It gets its own descriptor rather than riding
      // the `code` catch-all so an external plugin can shadow exactly this
      // format, and so the settings page can switch it off on its own.
      exts: ['jsonl', 'ndjson'],
      priority: 0,
      fetchStrategy: 'fsRead',
      // Same single gutter switch as the code viewer: the editor mode of a
      // JSONL file is still an editable text surface.
      settings: {
        toggles: [{
          key: 'editorGitGutter',
          title: () => t('settingsEditorGitGutterTitle'),
          desc: () => t('settingsEditorGitGutterDesc'),
        }],
      },
      component: (props) => <LazyTextEditor {...props} />,
    },
    {
      // Raster images. The host's document preview zooms, but only this
      // viewer snaps measurements to pixel borders and reports how many
      // pixels a span covers. `mediaUrl` streams through the file route with
      // Range support, so a huge PNG is never copied into a Blob.
      id: 'image',
      title: () => t('viewerImage'),
      icon: (size: number) => <IconImageOutline16 size={size} />,
      exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'],
      fetchStrategy: 'mediaUrl',
      component: (props) => <ImagePreview {...props} />,
    },
    {
      // Media containers. `mediaUrl` (not `fsRead`) is the whole point: the
      // element streams the route and seeks through `Range`, while an fsRead
      // viewer would first pay for a document read it cannot use.
      id: 'media',
      title: () => t('viewerMedia'),
      icon: (size: number) => <IconPlayOutlineRegular size={size} />,
      exts: ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus'],
      fetchStrategy: 'mediaUrl',
      component: (props) => <MediaPreview {...props} />,
    },
    {
      id: 'code',
      title: () => t('viewerCode'),
      icon: (size: number) => <IconCodeOutlineRegular size={size} />,
      exts: [],
      priority: -100,
      fetchStrategy: 'fsRead',
      // Declarative settings: ONE switch for the whole uncommitted-change
      // gutter (line tint + left bar + hover blame). Deliberately no
      // per-part switches.
      settings: {
        toggles: [{
          key: 'editorGitGutter',
          title: () => t('settingsEditorGitGutterTitle'),
          desc: () => t('settingsEditorGitGutterDesc'),
        }],
      },
      component: (props) => <LazyTextEditor {...props} />,
    },
  ]
}
