/**
 * Icons the sidebar needs beyond the primitives set: a terminal glyph (the
 * icon library has none), a diff glyph, and the two panel-toggle glyphs for
 * the top-right cluster. Per-tab icons live on the tab descriptors
 * (`descriptor.icon`), not in a type-keyed switch — the icon mapping was
 * registry-ized with the tab types.
 */
import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Right-panel toggle glyph (the "侧拉" button): a frame with a filled strip
 * along its RIGHT edge, in the app's outline style (1.5px stroke,
 * currentColor).
 */
export const IconPanelRightOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <rect x="10.5" y="3.25" width="2.75" height="9.5" rx="1" fill="currentColor" stroke="none" />
  </svg>
)

/**
 * Bottom-panel toggle glyph (the "底栏" button): a frame with a filled strip
 * along its BOTTOM edge, in the app's outline style.
 */
export const IconPanelBottomOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <rect x="3.25" y="10" width="9.5" height="2.75" rx="1" fill="currentColor" stroke="none" />
  </svg>
)

/**
 * Terminal glyph in the app's outline style (1.5px stroke, currentColor):
 * a rounded frame with a prompt chevron and underscore cursor.
 */
export const IconTerminalOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4.5 6.25 6.75 8 4.5 9.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.5 10.4h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

/** Diff glyph in the app's outline style: a file frame with a plus and a minus row. */
export const IconDiffOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4 5h3M5.5 3.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M9.5 12.5h2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

/**
 * Stop glyph for the background-job kill button: a filled square in the
 * app's outline scale (16), the universal "halt this work" mark.
 */
export const IconStopOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
)

// ── File-viewer inventory glyphs (Side card settings page) ────────────────

/** Image viewer glyph: a picture frame with a sun and a mountain. */
export const IconImageOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="5.5" cy="6" r="1.2" stroke="currentColor" strokeWidth="1.5" />
    <path d="m3.5 12 3-3 2.25 2.25L11.5 8.5 13 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** PDF viewer glyph: a document frame with the "PDF" label. */
export const IconPdfOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3.5 1.5h6.5L13.5 5v9.5h-10z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M9.5 1.5V5h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M5 13.5v-3h1.4c.75 0 1.1.32 1.1.85 0 .54-.35.85-1.1.85H5.3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.3 13.5v-3h1.05c.8 0 1.35.5 1.35 1.5s-.55 1.5-1.35 1.5z" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M11.6 13.5v-3h1.3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
  </svg>
)

/** Markdown viewer glyph: the classic "M with a down arrow" badge. */
export const IconMarkdownOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4 10.5V5.5l2 2.5 2-2.5v5M9.5 10.5v-5l2 2.5 2-2.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** HTML viewer glyph: a document frame with a "‹/›" tag pair. */
export const IconHtmlOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3.5 1.5h6.5L13.5 5v9.5h-10z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M9.5 1.5V5h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M5.6 13.2 4.2 10l1.4-3.2M7.4 6.8 8.8 10l-1.4 3.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Browser tab glyph: a globe with meridians. */
export const IconGlobeOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
    <ellipse cx="8" cy="8" rx="2.8" ry="6.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M1.5 8h13M8 1.5c-2.4 1.8-2.4 11.2 0 13M8 1.5c2.4 1.8 2.4 11.2 0 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

/** Maximize panel glyph: diagonal outward arrows. */
export const IconMaximizeOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2.5 6.5V2.5H6.5M13.5 6.5V2.5H9.5M2.5 9.5v4H6.5M13.5 9.5v4H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Restore panel glyph: diagonal inward arrows. */
export const IconRestoreOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6.5 2.5v4H2.5M9.5 2.5v4h4M6.5 13.5v-4H2.5M9.5 13.5v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

// ── File format icons for Explorer, FileTree, and Editor Tabs ──────────────

/**
 * Return a colorful vector icon for a file based on its name and extension.
 * Covers common programming languages, configuration files, documents, and media formats.
 */
export function fileIconFor(fileName: string, size = 14): ReactNode {
  const name = (fileName || '').trim()
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot !== -1 ? lower.slice(dot + 1) : ''
  const base = lower.replace(/^.*[\\/]/, '')

  // ── Special full filenames & dotfiles ───────────────────────────────────

  // Docker
  if (base === 'dockerfile' || base.startsWith('dockerfile.') || base === 'docker-compose.yml' || base === 'docker-compose.yaml' || base === '.dockerignore') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#0288d1" d="M21.81 10.25c-.06-.04-.56-.43-1.64-.43-.28 0-.56.03-.84.08-.21-1.4-1.38-2.11-1.43-2.14l-.29-.17-.18.27c-.24.36-.43.77-.51 1.19-.2.8-.08 1.56.33 2.21-.49.28-1.29.35-1.46.35H2.62c-.34 0-.62.28-.62.63 0 1.15.18 2.3.58 3.38.45 1.19 1.13 2.07 2 2.61.98.6 2.59.94 4.42.94.79 0 1.61-.07 2.42-.22 1.12-.2 2.2-.59 3.19-1.16A8.3 8.3 0 0 0 16.78 16c1.05-1.17 1.67-2.5 2.12-3.65h.19c1.14 0 1.85-.46 2.24-.85.26-.24.45-.53.59-.87l.08-.24zm-17.96.99h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H3.85c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.43 0h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H6.28c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.47 0h1.75c.1 0 .17-.07.17-.16V9.5c0-.08-.06-.16-.17-.16H8.75c-.08 0-.15.07-.15.16v1.58c0 .09.06.16.15.16m2.44 0h1.77c.08 0 .15-.07.15-.16V9.5c0-.08-.06-.16-.15-.16h-1.77c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16M6.28 9h1.76c.08 0 .16-.09.16-.18V7.25c0-.09-.07-.16-.16-.16H6.28c-.09 0-.16.06-.16.16v1.57c.01.09.07.18.16.18m2.47 0h1.75c.1 0 .17-.09.17-.18V7.25c0-.09-.06-.16-.17-.16H8.75c-.08 0-.15.06-.15.16v1.57c0 .09.06.18.15.18m2.44 0h1.77c.08 0 .15-.09.15-.18V7.25c0-.09-.07-.16-.15-.16h-1.77c-.08 0-.15.06-.15.16v1.57c0 .09.07.18.15.18m0-2.28h1.77c.08 0 .15-.07.15-.16V5c0-.1-.07-.17-.15-.17h-1.77c-.08 0-.15.06-.15.17v1.56c0 .08.07.16.15.16m2.46 4.52h1.76c.09 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16h-1.76c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16" />
      </svg>
    )
  }

  // Git files
  if (base === '.gitignore' || base === '.gitmodules' || base === '.gitattributes') {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#f4511e" d="M13.172 2.828 11.78 4.22l1.91 1.91 2 2A2.986 2.986 0 0 1 20 10.81a3.25 3.25 0 0 1-.31 1.31l2.06 2a2.68 2.68 0 0 1 3.37.57 2.86 2.86 0 0 1 .88 2.117 3.02 3.02 0 0 1-.856 2.109A2.9 2.9 0 0 1 23 19.81a2.93 2.93 0 0 1-2.13-.87 2.694 2.694 0 0 1-.56-3.38l-2-2.06a3 3 0 0 1-.31.12V20a3 3 0 0 1 1.44 1.09 2.92 2.92 0 0 1 .56 1.72 2.88 2.88 0 0 1-.878 2.128 2.98 2.98 0 0 1-2.048.871 2.981 2.981 0 0 1-2.514-4.719A3 3 0 0 1 16 20v-6.38a2.96 2.96 0 0 1-1.44-1.09 2.9 2.9 0 0 1-.56-1.72 2.9 2.9 0 0 1 .31-1.31l-3.9-3.9-7.579 7.572a4 4 0 0 0-.001 5.658l10.342 10.342a4 4 0 0 0 5.656 0l10.344-10.344a4 4 0 0 0 0-5.656L18.828 2.828a4 4 0 0 0-5.656 0" />
      </svg>
    )
  }

  // Node & Package manifests
  if (base === 'package.json' || base === 'package-lock.json' || base === 'pnpm-lock.yaml' || base === 'pnpm-workspace.yaml' || base === 'yarn.lock' || base === 'bun.lockb') {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#8bc34a" d="M16 20.003v2h4a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-2v-2h4v-2h-4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2v2Z" />
        <path fill="#8bc34a" d="m16 3.003-12 7v14l4 2h6v-13.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v11.5H8l-2-1.034V11.15l10-5.833 10 5.833v11.703l-10 5.833-1.745-1.022L13 29.253l3 1.75 12-7v-14Z" />
      </svg>
    )
  }

  // TypeScript / JavaScript config
  if (base === 'tsconfig.json' || base.startsWith('tsconfig.') || base === 'jsconfig.json') {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#0288d1" d="M2 4v24h28V4zm12 7.714v2.572h-3.429v9.428H7.714v-9.428H4.286V11.714zm13.714 8.286c0 2.229-1.886 3.714-4.286 3.714-2.8 0-4.286-1.543-4.286-3.714h2.857c0 .686.457 1.257 1.429 1.257.8 0 1.429-.4 1.429-1.086 0-1.829-4.286-1.429-4.286-4.8 0-2.171 1.657-3.657 4-3.657 2.343 0 3.943 1.257 4 3.429h-2.857c-.114-.686-.457-1.086-1.143-1.086s-1.143.4-1.143.971c0 1.657 4.286 1.314 4.286 4.971" />
      </svg>
    )
  }

  // Vite config
  if (base.startsWith('vite.config.')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#bd34fe" d="m29.5 5.5-12.7 22.3a1.5 1.5 0 0 1-2.6 0L2.5 5.5A1.5 1.5 0 0 1 3.8 3.3h24.4a1.5 1.5 0 0 1 1.3 2.2z" />
        <path fill="#ffd62e" d="M18.8 3.3 10.2 18h5.2l-3.5 10.7 11.2-15.4h-5.6l4.2-10H18.8z" />
      </svg>
    )
  }

  // Tailwind CSS config
  if (base.startsWith('tailwind.config.')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#06b6d4" d="M16 6.5C11.5 6.5 8.7 8.8 7.5 13.3c1.8-2.2 3.8-3 6.2-2.3 1.3.4 2.3 1.4 3.3 2.5C18.7 15.2 20.8 17.5 26 17.5c4.5 0 7.3-2.3 8.5-6.8-1.8 2.2-3.8 3-6.2 2.3-1.3-.4-2.3-1.4-3.3-2.5-1.7-1.7-3.8-4-9-4zM7.5 17.5c-4.5 0-7.3 2.3-8.5 6.8 1.8-2.2 3.8-3 6.2-2.3 1.3.4 2.3 1.4 3.3 2.5C10.2 26.2 12.3 28.5 17.5 28.5c4.5 0 7.3-2.3 8.5-6.8-1.8 2.2-3.8 3-6.2 2.3-1.3-.4-2.3-1.4-3.3-2.5-1.7-1.7-3.8-4-9-4z" />
      </svg>
    )
  }

  // ESLint / Prettier
  if (base.startsWith('eslint.config.') || base.startsWith('.eslintrc')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#4b32c3" d="m16 2 12.1 7v14L16 30 3.9 23V9L16 2z" />
        <path fill="#ffffff" d="M22 10.5h-8c-2 0-3.5 1.5-3.5 3.5s1.5 3.5 3.5 3.5h4c1 0 1.8.8 1.8 1.8s-.8 1.8-1.8 1.8h-4.5v2.2h4.5c2.2 0 4-1.8 4-4s-1.8-4-4-4h-4c-1 0-1.8-.8-1.8-1.8s.8-1.8 1.8-1.8h8v-2.2z" />
      </svg>
    )
  }
  if (base.startsWith('prettier.config.') || base.startsWith('.prettierrc')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <rect x="4" y="4" width="24" height="24" rx="5" fill="#1a2b34" />
        <path fill="#56b3b4" d="M12 8h8a4 4 0 0 1 4 4v0a4 4 0 0 1-4 4h-4v8h-4V8z" />
      </svg>
    )
  }

  // Rust / Cargo
  if (base === 'cargo.toml' || base === 'cargo.lock') {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#ff7043" d="m30 12-4-2V6h-4l-2-4-4 2-4-2-2 4H6v4l-4 2 2 4-2 4 4 2v4h4l2 4 4-2 4 2 2-4h4v-4l4-2-2-4ZM6 16a9.9 9.9 0 0 1 .842-4H10v8H6.842A9.9 9.9 0 0 1 6 16m10 10a9.98 9.98 0 0 1-7.978-4H16v-2h-2v-2h4c.819.819.297 2.308 1.179 3.37a1.89 1.89 0 0 0 1.46.63h3.34A9.98 9.98 0 0 1 16 26m-2-12v-2h4a1 1 0 0 1 0 2Zm11.158 6H24a2.006 2.006 0 0 1-2-2 2 2 0 0 0-2-2 3 3 0 0 0 3-3q0-.08-.004-.161A3.115 3.115 0 0 0 19.83 10H8.022a9.986 9.986 0 0 1 17.136 10" />
      </svg>
    )
  }

  // Go module
  if (base === 'go.mod' || base === 'go.sum' || base === 'go.work') {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#00acc1" d="M2 12h4v2H2zm-2 4h6v2H0zm4 4h2v2H4zm16.954-5H14v3h3.239a4.42 4.42 0 0 1-3.531 2 2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 15.292 13a2.73 2.73 0 0 1 1.749.584l2.962-1.185A5.6 5.6 0 0 0 15.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 6.4 6.4 0 0 0 .003-1.5" />
        <path fill="#00acc1" d="M26.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 5.614 5.614 0 0 0-5.659-6.5m2.681 6.137A4.515 4.515 0 0 1 24.708 20a2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 26.292 13a2.65 2.65 0 0 1 2.053.858 2.86 2.86 0 0 1 .628 2.28Z" />
      </svg>
    )
  }

  // Python manifests
  if (base === 'requirements.txt' || base === 'pipfile' || base === 'pipfile.lock' || base === 'poetry.lock' || base === 'pyproject.toml') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#0288d1" d="M9.86 2A2.86 2.86 0 0 0 7 4.86v1.68h4.29c.39 0 .71.57.71.96H4.86A2.86 2.86 0 0 0 2 10.36v3.781a2.86 2.86 0 0 0 2.86 2.86h1.18v-2.68a2.85 2.85 0 0 1 2.85-2.86h5.25c1.58 0 2.86-1.271 2.86-2.851V4.86A2.86 2.86 0 0 0 14.14 2zm-.72 1.61c.4 0 .72.12.72.71s-.32.891-.72.891c-.39 0-.71-.3-.71-.89s.32-.711.71-.711" />
        <path fill="#fdd835" d="M17.959 7v2.68a2.85 2.85 0 0 1-2.85 2.859H9.86A2.85 2.85 0 0 0 7 15.389v3.75a2.86 2.86 0 0 0 2.86 2.86h4.28A2.86 2.86 0 0 0 17 19.14v-1.68h-4.291c-.39 0-.709-.57-.709-.96h7.14A2.86 2.86 0 0 0 22 13.64V9.86A2.86 2.86 0 0 0 19.14 7zM8.32 11.513l-.004.004.038-.004zm6.54 7.276c.39 0 .71.3.71.89a.71.71 0 0 1-.71.71c-.4 0-.72-.12-.72-.71s.32-.89.72-.89" />
      </svg>
    )
  }

  // Environment variables
  if (base.startsWith('.env')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#fbc02d" d="M12 10h10v2H12zM16 4h2v8h-2zm4 18h10v2H20zm4 2h2v4h-2zm0-20h2v14h-2zM2 18h10v2H2zM6 18h2v10H6zM6 4h2v10H6zm10 12h2v12h-2z" />
      </svg>
    )
  }

  // License
  if (base === 'license' || base === 'licence' || base === 'copying' || base.startsWith('license.') || base.startsWith('licence.')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#ffb300" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z" />
      </svg>
    )
  }

  // Readme
  if (base === 'readme' || base.startsWith('readme.') || base.startsWith('changelog')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
        <path fill="#42a5f5" d="m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z" />
      </svg>
    )
  }

  // ── Extensions ─────────────────────────────────────────────────────────

  switch (ext) {
    // TypeScript
    case 'ts': case 'mts': case 'cts':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#0288d1" d="M2 4v24h28V4zm12 7.714v2.572h-3.429v9.428H7.714v-9.428H4.286V11.714zm13.714 8.286c0 2.229-1.886 3.714-4.286 3.714-2.8 0-4.286-1.543-4.286-3.714h2.857c0 .686.457 1.257 1.429 1.257.8 0 1.429-.4 1.429-1.086 0-1.829-4.286-1.429-4.286-4.8 0-2.171 1.657-3.657 4-3.657 2.343 0 3.943 1.257 4 3.429h-2.857c-.114-.686-.457-1.086-1.143-1.086s-1.143.4-1.143.971c0 1.657 4.286 1.314 4.286 4.971" />
        </svg>
      )

    // React TypeScript
    case 'tsx':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <circle cx="16" cy="16" r="2.5" fill="#00d8ff" />
          <path fill="none" stroke="#00d8ff" strokeWidth="1.8" d="M16 6.5C8.5 6.5 4 10.7 4 16s4.5 9.5 12 9.5 12-4.2 12-9.5-4.5-9.5-12-9.5z" transform="rotate(30 16 16)" />
          <path fill="none" stroke="#00d8ff" strokeWidth="1.8" d="M16 6.5C8.5 6.5 4 10.7 4 16s4.5 9.5 12 9.5 12-4.2 12-9.5-4.5-9.5-12-9.5z" transform="rotate(90 16 16)" />
          <path fill="none" stroke="#00d8ff" strokeWidth="1.8" d="M16 6.5C8.5 6.5 4 10.7 4 16s4.5 9.5 12 9.5 12-4.2 12-9.5-4.5-9.5-12-9.5z" transform="rotate(150 16 16)" />
        </svg>
      )

    // JavaScript
    case 'js': case 'mjs': case 'cjs':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#fbc02d" d="M2 4v24h28V4zm14 17.5a3.5 3.5 0 0 1-3.5 3.5H9v-3h3.5a.5.5 0 0 0 .5-.5V14h3zm10 0a3.5 3.5 0 0 1-3.5 3.5H19v-3h3.5a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5H20a3.5 3.5 0 0 1-3.5-3.5V15a3.5 3.5 0 0 1 3.5-3.5h3.5v3H20a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h2.5a3.5 3.5 0 0 1 3.5 3.5z" />
        </svg>
      )

    // React JavaScript
    case 'jsx':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <circle cx="16" cy="16" r="2.5" fill="#61dafb" />
          <path fill="none" stroke="#61dafb" strokeWidth="1.8" d="M16 6.5C8.5 6.5 4 10.7 4 16s4.5 9.5 12 9.5 12-4.2 12-9.5-4.5-9.5-12-9.5z" transform="rotate(30 16 16)" />
          <path fill="none" stroke="#61dafb" strokeWidth="1.8" d="M16 6.5C8.5 6.5 4 10.7 4 16s4.5 9.5 12 9.5 12-4.2 12-9.5-4.5-9.5-12-9.5z" transform="rotate(90 16 16)" />
          <path fill="none" stroke="#61dafb" strokeWidth="1.8" d="M16 6.5C8.5 6.5 4 10.7 4 16s4.5 9.5 12 9.5 12-4.2 12-9.5-4.5-9.5-12-9.5z" transform="rotate(150 16 16)" />
        </svg>
      )

    // Vue
    case 'vue':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#41b883" d="M19.7 3.5 16 9.8 12.3 3.5H2l14 24.2L30 3.5h-10.3z" />
          <path fill="#34495e" d="M19.7 3.5 16 9.8 12.3 3.5H7.2l8.8 15.2 8.8-15.2h-5.1z" />
        </svg>
      )

    // Svelte
    case 'svelte':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#ff3e00" d="M26.2 6.6c-2.3-3.6-7-4.7-10.6-2.5L7.9 8.7C5.3 10.2 3.8 13 4 16c.2 2.3 1.3 4.3 3.1 5.6l-2.1 1.2c-2.6 1.5-3.5 4.8-2 7.4 1.5 2.6 4.8 3.5 7.4 2l7.7-4.6c2.6-1.5 4.1-4.3 3.9-7.3-.2-2.3-1.3-4.3-3.1-5.6l2.1-1.2c2.6-1.5 3.5-4.8 2-7.4z" />
        </svg>
      )

    // Astro
    case 'astro':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#bc52ee" d="M19.3 4.2c-1.3-.9-3.3-.9-4.6 0L4.5 11.5c-1.3.9-2 2.5-1.9 4.1.2 1.6 1.1 3 2.5 3.8l10.2 5.8c1.3.8 3 .8 4.3 0l10.2-5.8c1.4-.8 2.3-2.2 2.5-3.8.1-1.6-.6-3.2-1.9-4.1L19.3 4.2z" />
          <path fill="#ff5d01" d="m16 11 3.5 7.5h-7L16 11z" />
        </svg>
      )

    // Python
    case 'py': case 'pyw': case 'ipynb':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#0288d1" d="M9.86 2A2.86 2.86 0 0 0 7 4.86v1.68h4.29c.39 0 .71.57.71.96H4.86A2.86 2.86 0 0 0 2 10.36v3.781a2.86 2.86 0 0 0 2.86 2.86h1.18v-2.68a2.85 2.85 0 0 1 2.85-2.86h5.25c1.58 0 2.86-1.271 2.86-2.851V4.86A2.86 2.86 0 0 0 14.14 2zm-.72 1.61c.4 0 .72.12.72.71s-.32.891-.72.891c-.39 0-.71-.3-.71-.89s.32-.711.71-.711" />
          <path fill="#fdd835" d="M17.959 7v2.68a2.85 2.85 0 0 1-2.85 2.859H9.86A2.85 2.85 0 0 0 7 15.389v3.75a2.86 2.86 0 0 0 2.86 2.86h4.28A2.86 2.86 0 0 0 17 19.14v-1.68h-4.291c-.39 0-.709-.57-.709-.96h7.14A2.86 2.86 0 0 0 22 13.64V9.86A2.86 2.86 0 0 0 19.14 7zM8.32 11.513l-.004.004.038-.004zm6.54 7.276c.39 0 .71.3.71.89a.71.71 0 0 1-.71.71c-.4 0-.72-.12-.72-.71s.32-.89.72-.89" />
        </svg>
      )

    // Rust
    case 'rs':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#ff7043" d="m30 12-4-2V6h-4l-2-4-4 2-4-2-2 4H6v4l-4 2 2 4-2 4 4 2v4h4l2 4 4-2 4 2 2-4h4v-4l4-2-2-4ZM6 16a9.9 9.9 0 0 1 .842-4H10v8H6.842A9.9 9.9 0 0 1 6 16m10 10a9.98 9.98 0 0 1-7.978-4H16v-2h-2v-2h4c.819.819.297 2.308 1.179 3.37a1.89 1.89 0 0 0 1.46.63h3.34A9.98 9.98 0 0 1 16 26m-2-12v-2h4a1 1 0 0 1 0 2Zm11.158 6H24a2.006 2.006 0 0 1-2-2 2 2 0 0 0-2-2 3 3 0 0 0 3-3q0-.08-.004-.161A3.115 3.115 0 0 0 19.83 10H8.022a9.986 9.986 0 0 1 17.136 10" />
        </svg>
      )

    // Go
    case 'go':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#00acc1" d="M2 12h4v2H2zm-2 4h6v2H0zm4 4h2v2H4zm16.954-5H14v3h3.239a4.42 4.42 0 0 1-3.531 2 2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 15.292 13a2.73 2.73 0 0 1 1.749.584l2.962-1.185A5.6 5.6 0 0 0 15.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 6.4 6.4 0 0 0 .003-1.5" />
          <path fill="#00acc1" d="M26.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 5.614 5.614 0 0 0-5.659-6.5m2.681 6.137A4.515 4.515 0 0 1 24.708 20a2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 26.292 13a2.65 2.65 0 0 1 2.053.858 2.86 2.86 0 0 1 .628 2.28Z" />
        </svg>
      )

    // C++
    case 'cpp': case 'hpp': case 'cc': case 'cxx': case 'c++': case 'hh': case 'hxx':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#0288d1" d="M20 18h2v2h2v-2h2v-2h-2v-2h-2v2h-2zm-6 0h2v2h2v-2h2v-2h-2v-2h-2v2h-2z" />
          <path fill="#0288d1" d="M14 6a10 10 0 1 0 7.07 17.07l-2.83-2.83A6 6 0 1 1 18.24 10l2.83-2.83A9.93 9.93 0 0 0 14 6" />
        </svg>
      )

    // C
    case 'c': case 'h':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#757575" d="M16 6a10 10 0 1 0 7.07 17.07l-2.83-2.83A6 6 0 1 1 20.24 10l2.83-2.83A9.93 9.93 0 0 0 16 6" />
        </svg>
      )

    // C#
    case 'cs': case 'csx': case 'csproj': case 'sln':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#8e24aa" d="M14 6a10 10 0 1 0 7.07 17.07l-2.83-2.83A6 6 0 1 1 18.24 10l2.83-2.83A9.93 9.93 0 0 0 14 6" />
          <path fill="#8e24aa" d="M22 13h2v-2h2v2h2v2h-2v2h2v2h-2v2h-2v-2h-2v2h-2v-2h2v-2h-2v-2h2zm2 4h2v-2h-2z" />
        </svg>
      )

    // Java
    case 'java': case 'jar': case 'class':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#e65100" d="M12.5 4c-.7 1.5.3 2.7 1.5 3.5 1.5 1 2.5 2.2 2.5 3.5 0 2-2 3.5-3.5 4.5s-2.5 2-2.5 3.5c0 1.5 1.5 2.5 3 3 2 .5 4 .5 5.5 0s2.5-1.5 2.5-2.5c0-1.5-1.5-2.5-3-3.5-1.5-1-2.5-2-2.5-3.5 0-1.5 1-2.5 2-3.5 1-1 1.5-2 1-3.5s-1.5-2-3-2.5c-1.5-.5-3 .5-3.5 2z" />
        </svg>
      )

    // Kotlin
    case 'kt': case 'kts':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#7f52ff" d="M30 2H2v28h28L16 16Z" />
          <path fill="#c757bc" d="M16 16 2 30h28Z" opacity="0.85" />
        </svg>
      )

    // Swift
    case 'swift':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#f05138" d="M29.5 17.5c-.3.7-.8 1.4-1.3 2-2.2 2.7-5.5 4.5-9.1 5-4.2.6-8.2-.8-11.3-3.7-.7-.7-1.4-1.5-2-2.3.9 1 2 1.9 3.2 2.6 3.1 1.9 6.8 2.5 10.3 1.7 3.3-.8 6.2-2.7 8.1-5.4 1-1.4 1.7-3 2.1-4.7.1 1.6 0 3.2 0 4.8zM2.5 14.5c2.5 4 6.8 6.7 11.6 7.3-3.2-1.7-5.7-4.4-7-7.7-.7-1.7-1-3.5-.9-5.3-.9 1.7-1.5 3.7-1.7 5.7zM18.8 3.5c1.8 2.6 2.8 5.7 2.8 8.9 0 2.2-.5 4.3-1.5 6.2 3.6-2.5 6.1-6.5 6.8-11-2.6-.9-5.4-1.2-8.1-.8z" />
        </svg>
      )

    // PHP
    case 'php':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#777bb4" d="M16 4C7.16 4 0 9.37 0 16s7.16 12 16 12 16-5.37 16-12S24.84 4 16 4zm-7 16H6.5l1.5-8H11c1.5 0 2.5.8 2.5 2.2 0 1.8-1.3 3.3-2.9 3.6L9.8 20H9zm1.7-5.2c.7 0 1.3-.6 1.3-1.4s-.6-1.4-1.3-1.4H8.8l-.5 2.8h1.4zm6.8 5.2h-2.5l2.9-8h2.5l-.8 2.3h2.6c1.5 0 2.5.8 2.5 2.2 0 1.8-1.3 3.3-2.9 3.6l-.8 2.2h-2.5zm1.7-5.2c.7 0 1.3-.6 1.3-1.4s-.6-1.4-1.3-1.4h-1.9l-.5 2.8h2.4z" />
        </svg>
      )

    // Ruby
    case 'rb': case 'erb': case 'gemspec':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#e53935" d="m6 10 10-8 10 8-10 20L6 10zm10-5-6 5h12l-6-5zm-7 7 7 14 7-14H9z" />
        </svg>
      )

    // Dart / Flutter
    case 'dart':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#00b4ab" d="M6 6h12l8 8-8 8H6l8-8z" />
        </svg>
      )

    // Lua
    case 'lua':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <circle cx="16" cy="16" r="10" fill="#000080" />
          <circle cx="23" cy="9" r="3.5" fill="#00a2ff" />
        </svg>
      )

    // Zig
    case 'zig':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#f7a41d" d="M4 6h24v4L12 22h16v4H4v-4l16-12H4z" />
        </svg>
      )

    // Scala
    case 'scala': case 'sc':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#dc322f" d="M6 6c10 2 16 0 20-3v7c-4 3-10 5-20 3zm0 9c10 2 16 0 20-3v7c-4 3-10 5-20 3zm0 9c10 2 16 0 20-3v7c-4 3-10 5-20 3z" />
        </svg>
      )

    // HTML
    case 'html': case 'htm': case 'xhtml':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#e65100" d="m4 4 2 22 10 2 10-2 2-22Zm19.72 7H11.28l.29 3h11.86l-.802 9.335L15.99 25l-6.635-1.646L8.93 19h3.02l.19 2 3.86.77 3.84-.77.29-4H8.84L8 8h16Z" />
        </svg>
      )

    // CSS
    case 'css':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#0288d1" d="m4 4 2 22 10 2 10-2 2-22Zm19.72 7H11.28l.29 3h11.86l-.802 9.335L15.99 25l-6.635-1.646L8.93 19h3.02l.19 2 3.86.77 3.84-.77.29-4H8.84L8 8h16Z" />
        </svg>
      )

    // Sass / SCSS
    case 'scss': case 'sass':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#ec407a" d="M16 2C8.27 2 2 8.27 2 16s6.27 14 14 14 14-6.27 14-14S23.73 2 16 2zm4.5 19.5c-2.3 0-3.5-1.2-4.1-2.1-.5-.8-.7-1.8-.9-2.8-.3-1.4-.7-2.6-1.5-2.6-.4 0-.8.3-.8.8 0 1.2 1.4 2.1 1.4 3.6 0 1.8-1.5 3.1-3.6 3.1-2.4 0-4-1.7-4-4.1 0-3.1 2.6-4.9 5.3-4.9 2.2 0 3.6 1.1 4.2 2.1.5.8.7 1.8.9 2.8.3 1.4.7 2.6 1.5 2.6.4 0 .8-.3.8-.8 0-1.2-1.4-2.1-1.4-3.6 0-1.8 1.5-3.1 3.6-3.1 2.4 0 4 1.7 4 4.1 0 3.1-2.6 4.9-5.4 4.9z" />
        </svg>
      )

    // Less
    case 'less':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <rect x="4" y="4" width="24" height="24" rx="4" fill="#1d365d" />
          <path fill="#ffffff" d="M10 10v12h9v-2.5h-6.2V10zm11 5.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
        </svg>
      )

    // JSON
    case 'json': case 'jsonc': case 'json5':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#fbc02d" d="M12 6a3 3 0 0 0-3 3v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a3 3 0 0 0 3 3h2v-3h-2v-3.5A2.5 2.5 0 0 1 9.5 16 2.5 2.5 0 0 1 12 13.5V10h2V7h-2Zm8 0a3 3 0 0 1 3 3v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a3 3 0 0 1-3 3h-2v-3h2v-3.5A2.5 2.5 0 0 0 22.5 16 2.5 2.5 0 0 0 20 13.5V10h-2V7h2Z" />
        </svg>
      )

    // YAML
    case 'yaml': case 'yml':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#ff5252" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2m12 16v-2H9v2zm-4-4v-2H6v2z" />
        </svg>
      )

    // TOML & Ini & Config
    case 'toml': case 'ini': case 'conf': case 'cfg': case 'properties':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#78909c" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
        </svg>
      )

    // XML
    case 'xml': case 'xsl': case 'xsd': case 'plist':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#ff9800" d="M10 8 3 16l7 8 2.1-2.1L6.2 16l5.9-5.9L10 8zm12 0-2.1 2.1 5.9 5.9-5.9 5.9L22 24l7-8-7-8zm-8.8 16.5 4.5-17-2.4-.6-4.5 17 2.4.6z" />
        </svg>
      )

    // Markdown
    case 'md': case 'markdown': case 'mdx':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#42a5f5" d="m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z" />
        </svg>
      )

    // Shell
    case 'sh': case 'bash': case 'zsh': case 'fish':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#4caf50" d="M2 2a1 1 0 0 0-1 1v10c0 .554.446 1 1 1h12c.554 0 1-.446 1-1V3a1 1 0 0 0-1-1zm0 3h12v8H2zm1 2 2 2-2 2 1 1 3-3-3-3zm5 3.5V12h5v-1.5z" />
        </svg>
      )

    // PowerShell / Windows Scripts
    case 'ps1': case 'bat': case 'cmd':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#0288d1" d="M2 2a1 1 0 0 0-1 1v10c0 .554.446 1 1 1h12c.554 0 1-.446 1-1V3a1 1 0 0 0-1-1zm0 3h12v8H2zm1 2 2 2-2 2 1 1 3-3-3-3zm5 3.5V12h5v-1.5z" />
        </svg>
      )

    // SQL & Database
    case 'sql': case 'db': case 'sqlite': case 'sqlite3':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#ffb300" d="M12 2C6.48 2 2 3.79 2 6v12c0 2.21 4.48 4 10 4s10-1.79 10-4V6c0-2.21-4.48-4-10-4zm0 2c4.97 0 8 1.47 8 2s-3.03 2-8 2-8-1.47-8-2 3.03-2 8-2zm0 16c-4.97 0-8-1.47-8-2v-2.12c1.78 1.3 4.71 2.12 8 2.12s6.22-.82 8-2.12V18c0 .53-3.03 2-8 2zm0-5c-4.97 0-8-1.47-8-2v-2.12c1.78 1.3 4.71 2.12 8 2.12s6.22-.82 8-2.12V13c0 .53-3.03 2-8 2z" />
        </svg>
      )

    // Prisma
    case 'prisma':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#5a67d8" d="M16 2 4 26l10 4 14-10L16 2zm-1.5 6.5 8.2 12.3-6.7 4.8L8.7 23l5.8-14.5z" />
        </svg>
      )

    // GraphQL
    case 'graphql': case 'gql':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#e10098" d="m16 2 12.12 7v14L16 30 3.88 23V9L16 2zm0 3.3L6.18 10.9v10.2L16 26.7l9.82-5.6V10.9L16 5.3z" />
          <circle cx="16" cy="4" r="2.5" fill="#e10098" />
          <circle cx="28" cy="10" r="2.5" fill="#e10098" />
          <circle cx="28" cy="22" r="2.5" fill="#e10098" />
          <circle cx="16" cy="28" r="2.5" fill="#e10098" />
          <circle cx="4" cy="22" r="2.5" fill="#e10098" />
          <circle cx="4" cy="10" r="2.5" fill="#e10098" />
        </svg>
      )

    // Protocol Buffers
    case 'proto':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#1976d2" d="M16 2 3 9.5v13L16 30l13-7.5v-13L16 2zm0 3.8 9.5 5.5L16 16.8 6.5 11.3 16 5.8zM5.5 13.5l9.5 5.5v10.2l-9.5-5.5V13.5zm11.5 15.7V19l9.5-5.5v10.2l-9.5 5.5z" />
        </svg>
      )

    // WebAssembly
    case 'wasm': case 'wat':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
          <rect x="4" y="4" width="24" height="24" rx="4" fill="#654ff0" />
          <path fill="#ffffff" d="M9 11l2.5 10 2.5-7 2.5 7 2.5-10h-2l-1.5 6.5-2.2-6.5h-1.6L10.5 17.5 9 11H9zm13.5 0v10h2v-4h1.5v-2H24.5v-2h2.5V11h-4.5z" />
        </svg>
      )

    // PDF
    case 'pdf':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#e53935" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9.5 8.5c0 .83-.67 1.5-1.5 1.5H7v2H5.5V7H8c.83 0 1.5.67 1.5 1.5v3zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H13c.83 0 1.5.67 1.5 1.5v5zm4-3.5H17v1.5h1.5V13H17v2h-1.5V7h3v1.5zM7 8.5v3h1c.28 0 .5-.22.5-.5V9c0-.28-.22-.5-.5-.5H7zm5 0v5h1c.28 0 .5-.22.5-.5V9c0-.28-.22-.5-.5-.5h-1z" />
        </svg>
      )

    // Images
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'ico': case 'bmp': case 'avif': case 'tiff':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#ab47bc" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-5.04-6.71-2.75 3.54-1.96-2.36L6.5 17h11l-3.54-4.71zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
        </svg>
      )

    // SVG
    case 'svg':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#ff9800" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14-4-6h2.5l1.5 3 1.5-3H15l-4 6zm5.5-1.5c0 .83-.67 1.5-1.5 1.5h-2.5V7H16c.83 0 1.5.67 1.5 1.5v7zm0-5.5h-1.5v4h1.5v-4z" />
        </svg>
      )

    // Microsoft Word / Document
    case 'doc': case 'docx': case 'odt': case 'rtf':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#1976d2" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3.8 14-1.7-6-1.5 6h-1.5l-2-8h1.8l1.2 5.5L13 8.5h1.5l1.5 5.5 1.2-5.5H19l-2 8h-1.8z" />
        </svg>
      )

    // Microsoft Excel / Spreadsheets / CSV / TSV
    case 'xls': case 'xlsx': case 'csv': case 'tsv': case 'ods':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#388e3c" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-4.2 14L12 12.8 9.2 17H7.5l3.6-5-3.4-4.5h1.8l2.5 3.8 2.5-3.8h1.8L12.9 12l3.6 5h-1.7z" />
        </svg>
      )

    // Microsoft PowerPoint
    case 'ppt': case 'pptx': case 'odp':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#d84315" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-6 9h-3v4H8.5V7H13c1.66 0 3 1.34 3 3s-1.34 2-3 2zm0-3.5h-3v2h3c.55 0 1-.45 1-1s-.45-1-1-1z" />
        </svg>
      )

    // Audio
    case 'mp3': case 'wav': case 'ogg': case 'flac': case 'm4a': case 'aac': case 'wma':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#ab47bc" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
        </svg>
      )

    // Video
    case 'mp4': case 'mov': case 'avi': case 'mkv': case 'webm': case 'flv': case 'wmv':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#e53935" d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
        </svg>
      )

    // Archives & Compressed
    case 'zip': case 'tar': case 'gz': case '7z': case 'rar': case 'tgz': case 'bz2': case 'xz':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#ffa000" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 2h2v2h-2V5zm-2 2h2v2h-2V7zm2 2h2v2h-2V9zm-2 2h2v2h-2v-2zm2 2h2v2h-2v-2zm-3 4v-2h4v2c0 1.1-.9 2-2 2s-2-.9-2-2z" />
        </svg>
      )

    // Plain text & Logs
    case 'txt': case 'log':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#78909c" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
        </svg>
      )

    // Fonts
    case 'ttf': case 'otf': case 'woff': case 'woff2': case 'eot':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <path fill="#e64a19" d="M9.93 13.5h4.14L12 7.98zM20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-4.05 16.5-1.14-3H9.17l-1.12 3H5.96l5.11-13h1.86l5.11 13h-2.09z" />
        </svg>
      )

    // Default file outline
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
          <path d="M3.5 1.5h6L13.5 5.5v9h-10z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
          <path d="M9.5 1.5V5.5h4" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
        </svg>
      )
  }
}
