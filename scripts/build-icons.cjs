const fs = require('fs');
const path = require('path');
const iconDir = 'node_modules/material-icon-theme/icons';

function parseSvg(svgStr) {
  const vbMatch = svgStr.match(/viewBox="([^"]+)"/);
  const viewBox = vbMatch ? vbMatch[1] : '0 0 24 24';
  const xmlSpace = svgStr.includes('xml:space="preserve"') ? ' xmlSpace="preserve"' : '';
  const inner = svgStr.replace(/<svg[^>]*>/, '').replace(/<\/svg>/, '').trim();
  const jsxInner = inner
    .replace(/stop-color=/g, 'stopColor=')
    .replace(/stop-opacity=/g, 'stopOpacity=')
    .replace(/stroke-width=/g, 'strokeWidth=')
    .replace(/stroke-linecap=/g, 'strokeLinecap=')
    .replace(/stroke-linejoin=/g, 'strokeLinejoin=')
    .replace(/stroke-miterlimit=/g, 'strokeMiterlimit=')
    .replace(/stroke-dasharray=/g, 'strokeDasharray=')
    .replace(/stroke-dashoffset=/g, 'strokeDashoffset=')
    .replace(/stroke-opacity=/g, 'strokeOpacity=')
    .replace(/fill-rule=/g, 'fillRule=')
    .replace(/clip-rule=/g, 'clipRule=')
    .replace(/fill-opacity=/g, 'fillOpacity=')
    .replace(/gradientTransform=/g, 'gradientTransform=')
    .replace(/gradientUnits=/g, 'gradientUnits=')
    .replace(/data-mit-no-recolor="true"/g, '');
  return { viewBox, xmlSpace, jsxInner };
}

const iconNames = [
  'typescript', 'react_ts', 'javascript', 'react', 'vue', 'svelte', 'python', 'rust', 'go',
  'cpp', 'c', 'csharp', 'java', 'kotlin', 'swift', 'php', 'ruby', 'dart', 'lua', 'zig',
  'html', 'css', 'sass', 'less', 'json', 'yaml', 'toml', 'markdown', 'console', 'powershell',
  'database', 'docker', 'git', 'nodejs', 'npm', 'pnpm', 'yarn', 'bun', 'playwright', 'vite',
  'vitest', 'tailwindcss', 'eslint', 'prettier', 'tsconfig', 'readme', 'certificate', 'pdf',
  'image', 'svg', 'table', 'word', 'powerpoint', 'zip', 'font', 'tune', 'document', 'settings',
  'graphql', 'proto', 'webassembly', 'audio', 'video', 'file'
];

let out = '';
out += '/**\n';
out += ' * Icons the sidebar needs beyond the primitives set: a terminal glyph (the\n';
out += ' * icon library has none), a diff glyph, and the two panel-toggle glyphs for\n';
out += ' * the top-right cluster. Per-tab icons live on the tab descriptors\n';
out += ' * (`descriptor.icon`), not in a type-keyed switch — the icon mapping was\n';
out += ' * registry-ized with the tab types.\n';
out += ' */\n';
out += "import type { ReactNode } from 'react'\n";
out += "import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'\n\n";

out += `export const IconPanelRightOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <rect x="10.5" y="3.25" width="2.75" height="9.5" rx="1" fill="currentColor" stroke="none" />
  </svg>
)

export const IconPanelBottomOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <rect x="3.25" y="10" width="9.5" height="2.75" rx="1" fill="currentColor" stroke="none" />
  </svg>
)

export const IconTerminalOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4.5 6.25 6.75 8 4.5 9.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.5 10.4h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

export const IconDiffOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4 5h3M5.5 3.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M9.5 12.5h2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

export const IconStopOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
)

export const IconImageOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="5.5" cy="6" r="1.2" stroke="currentColor" strokeWidth="1.5" />
    <path d="m3.5 12 3-3 2.25 2.25L11.5 8.5 13 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const IconPdfOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3.5 1.5h6.5L13.5 5v9.5h-10z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M9.5 1.5V5h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M5 13.5v-3h1.4c.75 0 1.1.32 1.1.85 0 .54-.35.85-1.1.85H5.3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.3 13.5v-3h1.05c.8 0 1.35.5 1.35 1.5s-.55 1.5-1.35 1.5z" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M11.6 13.5v-3h1.3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
  </svg>
)

export const IconMarkdownOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4 10.5V5.5l2 2.5 2-2.5v5M9.5 10.5v-5l2 2.5 2-2.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const IconHtmlOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3.5 1.5h6.5L13.5 5v9.5h-10z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M9.5 1.5V5h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M5.6 13.2 4.2 10l1.4-3.2M7.4 6.8 8.8 10l-1.4 3.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const IconGlobeOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
    <ellipse cx="8" cy="8" rx="2.8" ry="6.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M1.5 8h13M8 1.5c-2.4 1.8-2.4 11.2 0 13M8 1.5c2.4 1.8 2.4 11.2 0 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

export const IconMaximizeOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2.5 6.5V2.5H6.5M13.5 6.5V2.5H9.5M2.5 9.5v4H6.5M13.5 9.5v4H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const IconRestoreOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6.5 2.5v4H2.5M9.5 2.5v4h4M6.5 13.5v-4H2.5M9.5 13.5v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
`;

out += '// ── Official Material Icon Theme SVGs ──────────────────────────────────\n\n';
out += 'const MATERIAL_ICONS: Record<string, (size: number) => ReactNode> = {\n';

for (const name of iconNames) {
  const p = path.join(iconDir, name + '.svg');
  const raw = fs.readFileSync(p, 'utf8');
  const { viewBox, xmlSpace, jsxInner } = parseSvg(raw);
  out += `  '${name}': (size: number) => (\n    <svg width={size} height={size}${xmlSpace} viewBox="${viewBox}" fill="none" style={{ flexShrink: 0 }}>\n      ${jsxInner}\n    </svg>\n  ),\n`;
}

out += '}\n\n';

out += `// Exact filename to icon ID (lowercased)
const EXACT_FILES: Record<string, string> = {
  'package.json': 'nodejs',
  'package-lock.json': 'nodejs',
  '.nvmrc': 'nodejs',
  '.node-version': 'nodejs',
  'pnpm-lock.yaml': 'pnpm',
  'pnpm-workspace.yaml': 'pnpm',
  '.pnpmfile.cjs': 'pnpm',
  'yarn.lock': 'yarn',
  '.yarnrc': 'yarn',
  '.yarnrc.yml': 'yarn',
  '.yarnrc.yaml': 'yarn',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
  'bunfig.toml': 'bun',
  'tsconfig.json': 'tsconfig',
  'tsconfig.build.json': 'tsconfig',
  'tsconfig.esm.json': 'tsconfig',
  'tsconfig.node.json': 'tsconfig',
  'jsconfig.json': 'tsconfig',
  'playwright.config.ts': 'playwright',
  'playwright.config.js': 'playwright',
  'playwright.config.mjs': 'playwright',
  'playwright.config.cjs': 'playwright',
  'vite.config.ts': 'vite',
  'vite.config.js': 'vite',
  'vite.config.mjs': 'vite',
  'vite.config.cjs': 'vite',
  'vitest.config.ts': 'vitest',
  'vitest.config.js': 'vitest',
  'vitest.config.mjs': 'vitest',
  'vitest.config.cjs': 'vitest',
  'tailwind.config.js': 'tailwindcss',
  'tailwind.config.ts': 'tailwindcss',
  'tailwind.config.mjs': 'tailwindcss',
  'tailwind.config.cjs': 'tailwindcss',
  'eslint.config.js': 'eslint',
  'eslint.config.mjs': 'eslint',
  'eslint.config.cjs': 'eslint',
  'eslint.config.ts': 'eslint',
  'eslint.config.mts': 'eslint',
  'eslint.config.cts': 'eslint',
  '.eslintrc': 'eslint',
  '.eslintrc.json': 'eslint',
  '.eslintrc.js': 'eslint',
  '.eslintrc.cjs': 'eslint',
  '.eslintrc.yml': 'eslint',
  '.eslintrc.yaml': 'eslint',
  'prettier.config.js': 'prettier',
  'prettier.config.mjs': 'prettier',
  'prettier.config.cjs': 'prettier',
  'prettier.config.ts': 'prettier',
  '.prettierrc': 'prettier',
  '.prettierrc.json': 'prettier',
  '.prettierrc.js': 'prettier',
  '.prettierrc.cjs': 'prettier',
  '.prettierrc.yml': 'prettier',
  '.prettierrc.yaml': 'prettier',
  '.prettierrc.toml': 'prettier',
  'cargo.toml': 'rust',
  'cargo.lock': 'rust',
  'go.mod': 'go',
  'go.sum': 'go',
  'go.work': 'go',
  'requirements.txt': 'python',
  'pipfile': 'python',
  'pipfile.lock': 'python',
  'poetry.lock': 'python',
  'pyproject.toml': 'python',
  'gemfile': 'ruby',
  'gemfile.lock': 'ruby',
  'dockerfile': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  '.dockerignore': 'docker',
  '.gitignore': 'git',
  '.gitmodules': 'git',
  '.gitattributes': 'git',
  '.gitkeep': 'git',
  '.env': 'tune',
  'license': 'certificate',
  'licence': 'certificate',
  'copying': 'certificate',
  'readme': 'readme',
  'readme.md': 'readme',
  'readme_en.md': 'readme',
  'readme.txt': 'readme',
  'changelog': 'readme',
  'changelog.md': 'readme',
  '.editorconfig': 'settings',
  'dsh.plugin.json': 'json',
}

// Extension to icon ID (lowercased)
const EXT_MAP: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'react_ts',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'react',
  vue: 'vue',
  svelte: 'svelte',
  py: 'python',
  pyw: 'python',
  ipynb: 'python',
  rs: 'rust',
  go: 'go',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  'c++': 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  c: 'c',
  h: 'c',
  cs: 'csharp',
  csx: 'csharp',
  csproj: 'csharp',
  sln: 'csharp',
  java: 'java',
  jar: 'java',
  class: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  php: 'php',
  rb: 'ruby',
  erb: 'ruby',
  gemspec: 'ruby',
  dart: 'dart',
  lua: 'lua',
  zig: 'zig',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  less: 'less',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'settings',
  conf: 'settings',
  cfg: 'settings',
  properties: 'settings',
  xml: 'settings',
  xsl: 'settings',
  xsd: 'settings',
  plist: 'settings',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  sh: 'console',
  bash: 'console',
  zsh: 'console',
  fish: 'console',
  ps1: 'powershell',
  bat: 'console',
  cmd: 'console',
  sql: 'database',
  db: 'database',
  sqlite: 'database',
  sqlite3: 'database',
  prisma: 'database',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  wasm: 'webassembly',
  wat: 'webassembly',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  ico: 'image',
  bmp: 'image',
  avif: 'image',
  tiff: 'image',
  svg: 'svg',
  doc: 'word',
  docx: 'word',
  odt: 'word',
  rtf: 'word',
  xls: 'table',
  xlsx: 'table',
  csv: 'table',
  tsv: 'table',
  ods: 'table',
  ppt: 'powerpoint',
  pptx: 'powerpoint',
  odp: 'powerpoint',
  zip: 'zip',
  tar: 'zip',
  gz: 'zip',
  tgz: 'zip',
  '7z': 'zip',
  rar: 'zip',
  bz2: 'zip',
  xz: 'zip',
  txt: 'document',
  log: 'document',
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
  eot: 'font',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  flac: 'audio',
  m4a: 'audio',
  aac: 'audio',
  wma: 'audio',
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  webm: 'video',
  flv: 'video',
  wmv: 'video',
}

function renderIcon(name: string, size: number): ReactNode {
  const fn = MATERIAL_ICONS[name]
  if (fn !== undefined) return fn(size)
  return MATERIAL_ICONS['file']?.(size) ?? null
}

/**
 * Return the official Material Icon Theme vector SVG for a file.
 * Extracted directly from Philipp Kief's official vscode-material-icon-theme package.
 */
export function fileIconFor(fileName: string, size = 14): ReactNode {
  const name = (fileName || '').trim()
  const lower = name.toLowerCase()
  const base = lower.replace(/^.*[\\\\/]/, '')

  // 1. Exact full filename match (e.g. package.json, pnpm-lock.yaml, tsconfig.json, etc.)
  const exactIcon = EXACT_FILES[base]
  if (exactIcon !== undefined) {
    return renderIcon(exactIcon, size)
  }

  // 2. Prefix & pattern matches for special config / dotfiles
  if (base.startsWith('.env')) return renderIcon('tune', size)
  if (base.startsWith('tsconfig.') || base.startsWith('jsconfig.')) return renderIcon('tsconfig', size)
  if (base.startsWith('playwright.config.')) return renderIcon('playwright', size)
  if (base.startsWith('vite.config.')) return renderIcon('vite', size)
  if (base.startsWith('vitest.config.')) return renderIcon('vitest', size)
  if (base.startsWith('tailwind.config.')) return renderIcon('tailwindcss', size)
  if (base.startsWith('eslint.config.') || base.startsWith('.eslintrc')) return renderIcon('eslint', size)
  if (base.startsWith('prettier.config.') || base.startsWith('.prettierrc')) return renderIcon('prettier', size)
  if (base.startsWith('dockerfile.') || base.startsWith('docker-compose.')) return renderIcon('docker', size)
  if (base.startsWith('readme.') || base.startsWith('readme_') || base.startsWith('changelog.')) return renderIcon('readme', size)
  if (base.startsWith('license.') || base.startsWith('licence.')) return renderIcon('certificate', size)

  // 3. Extension match
  const dot = base.lastIndexOf('.')
  if (dot !== -1) {
    const ext = base.slice(dot + 1)
    const extIcon = EXT_MAP[ext]
    if (extIcon !== undefined) {
      return renderIcon(extIcon, size)
    }
  }

  // 4. Default fallback: Material Icon document/file
  return renderIcon('file', size)
}
`;

fs.writeFileSync('src/client/icons.tsx', out);
console.log('Successfully written src/client/icons.tsx!');
