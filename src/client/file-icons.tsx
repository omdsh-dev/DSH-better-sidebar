/**
 * Colored, type-specific file and folder icons for the file tree.
 *
 * Brand file types (.tsx → React, .vue → Vue, .py → Python, …) use the
 * Simple Icons set (react-icons/si) with each brand's official color.
 * Generic types (.txt, .pdf, .zip, …) use the VSCode Seti set
 * (react-icons/vsc) with a hand-picked color. Special folders
 * (node_modules, src, .git, …) get a tinted folder glyph so the tree
 * reads at a glance.
 *
 * Zero new dependencies: react-icons is already a peer of this plugin.
 */
import type { ReactNode } from 'react'
import type { FileIconTheme } from './service.ts'
import {
  SiReact, SiVuedotjs, SiTypescript, SiJavascript, SiPython, SiGo,
  SiRust, SiPhp, SiHtml5, SiCss, SiSass, SiLess, SiSvelte, SiAstro,
  SiDocker, SiGit, SiMarkdown, SiSwift, SiKotlin, SiDart, SiGnubash,
  SiMysql, SiSqlite, SiLua, SiScala, SiClojure, SiPerl, SiHaskell,
  SiErlang, SiJulia, SiC, SiCplusplus, SiDotnet, SiYaml,
  SiToml, SiGraphql, SiTerraform, SiGodotengine, SiCrystal,
  SiCoffeescript, SiCmake, SiRuby, SiNpm, SiPnpm, SiYarn, SiComposer,
  SiVite, SiWebpack, SiRollupdotjs, SiEsbuild, SiNextdotjs, SiNuxt,
  SiTailwindcss, SiVitest, SiJest, SiCypress, SiEslint,
  SiPrettier, SiBabel, SiPostcss, SiPrisma, SiTurbo, SiNx, SiLerna,
  SiBiome, SiNodedotjs, SiDjango, SiTauri, SiElectron, SiDocusaurus,
  SiDotenv, SiAngular, SiBun, SiElixir, SiElm, SiSolidity, SiRacket,
  SiNim, SiZig, SiOcaml, SiVim, SiGradle, SiJenkins, SiGitlab,
  SiGulp, SiGrunt, SiGatsby, SiRemix, SiStorybook, SiStylelint, SiSwc,
  SiVitepress, SiKubernetes, SiHelm, SiNixos, SiConventionalcommits,
  SiPuppeteer, SiMocha, SiChai, SiTestinglibrary, SiSentry,
  SiGrafana, SiPrometheus, SiVercel, SiNetlify, SiCloudflare,
  SiFirebase, SiSupabase, SiPlanetscale, SiRender, SiFlydotio,
  SiRailway, SiDigitalocean, SiGooglecloud, SiGithub, SiGithubactions,
  SiApple, SiGoogle, SiAlgolia, SiMeilisearch, SiMinio, SiElasticsearch,
  SiRedis, SiMongodb, SiPostgresql, SiRabbitmq, SiApachekafka,
  SiNatsdotio, SiVault, SiConsul, SiEtcd, SiDatadog, SiOpentelemetry,
  SiLogstash, SiKibana, SiLighthouse, SiRollbar, SiCodeceptjs,
  SiTestcafe, SiSaucelabs, SiJasmine, SiLinux, SiApache, SiNginx,
} from 'react-icons/si'
import {
  VscFile, VscFileCode, VscFileText, VscFilePdf, VscFileMedia, VscFileZip,
  VscFileBinary, VscMusic, VscMap, VscKey, VscSettings, VscBook,
  VscJson, VscTerminalPowershell, VscTerminalCmd, VscFolder,
  VscFolderOpened,
} from 'react-icons/vsc'
import type { IconType } from 'react-icons'

/** A brand/generic icon paired with its display color. */
interface IconEntry {
  Icon: IconType
  color: string
}

/** Render one colored icon at the tree's 14px size. */
function colored(entry: IconEntry, size = 14): ReactNode {
  const { Icon, color } = entry
  return <Icon size={size} style={{ color }} />
}

// ── Brand file icons (extension → { icon, brand color }) ────────────────

const FILE_ICON_BY_EXT: Partial<Record<string, IconEntry>> = {
  // TypeScript / JavaScript
  ts: { Icon: SiTypescript, color: '#3178C6' },
  tsx: { Icon: SiReact, color: '#61DAFB' },
  js: { Icon: SiJavascript, color: '#F7DF1E' },
  jsx: { Icon: SiReact, color: '#61DAFB' },
  mjs: { Icon: SiJavascript, color: '#F7DF1E' },
  cjs: { Icon: SiJavascript, color: '#F7DF1E' },
  mtjs: { Icon: SiJavascript, color: '#F7DF1E' },
  cts: { Icon: SiTypescript, color: '#3178C6' },
  // Web frameworks
  vue: { Icon: SiVuedotjs, color: '#42B883' },
  svelte: { Icon: SiSvelte, color: '#FF3E00' },
  astro: { Icon: SiAstro, color: '#FF5E00' },
  html: { Icon: SiHtml5, color: '#E34F26' },
  htm: { Icon: SiHtml5, color: '#E34F26' },
  xhtml: { Icon: SiHtml5, color: '#E34F26' },
  css: { Icon: SiCss, color: '#1572B6' },
  scss: { Icon: SiSass, color: '#CC6699' },
  sass: { Icon: SiSass, color: '#CC6699' },
  less: { Icon: SiLess, color: '#1D365D' },
  styl: { Icon: VscFileCode, color: '#BF1B1B' },
  pug: { Icon: VscFileCode, color: '#A86454' },
  jade: { Icon: VscFileCode, color: '#A86454' },
  hbs: { Icon: VscFileCode, color: '#F0772B' },
  handlebars: { Icon: VscFileCode, color: '#F0772B' },
  ejs: { Icon: VscFileCode, color: '#E44D26' },
  eta: { Icon: VscFileCode, color: '#E44D26' },
  njk: { Icon: VscFileCode, color: '#2C7873' },
  nunjucks: { Icon: VscFileCode, color: '#2C7873' },
  twig: { Icon: VscFileCode, color: '#41C47B' },
  liquid: { Icon: VscFileCode, color: '#41C47B' },
  // Systems
  py: { Icon: SiPython, color: '#3776AB' },
  pyi: { Icon: SiPython, color: '#3776AB' },
  pyw: { Icon: SiPython, color: '#3776AB' },
  rb: { Icon: SiRuby, color: '#CC342D' },
  go: { Icon: SiGo, color: '#00ADD8' },
  rs: { Icon: SiRust, color: '#DEA584' },
  php: { Icon: SiPhp, color: '#777BB4' },
  swift: { Icon: SiSwift, color: '#F05138' },
  kt: { Icon: SiKotlin, color: '#7F52FF' },
  kts: { Icon: SiKotlin, color: '#7F52FF' },
  dart: { Icon: SiDart, color: '#0175C2' },
  lua: { Icon: SiLua, color: '#2C2D72' },
  scala: { Icon: SiScala, color: '#DC322F' },
  clj: { Icon: SiClojure, color: '#5F5F5F' },
  cljs: { Icon: SiClojure, color: '#5F5F5F' },
  cljc: { Icon: SiClojure, color: '#5F5F5F' },
  edn: { Icon: SiClojure, color: '#5F5F5F' },
  pl: { Icon: SiPerl, color: '#393939' },
  pm: { Icon: SiPerl, color: '#393939' },
  hs: { Icon: SiHaskell, color: '#5E5086' },
  erl: { Icon: SiErlang, color: '#A90533' },
  jl: { Icon: SiJulia, color: '#9558B2' },
  ex: { Icon: SiElixir, color: '#4B275F' },
  exs: { Icon: SiElixir, color: '#4B275F' },
  elm: { Icon: SiElm, color: '#60B5CC' },
  nim: { Icon: SiNim, color: '#FFE95B' },
  zig: { Icon: SiZig, color: '#F7A41D' },
  ml: { Icon: SiOcaml, color: '#EC672F' },
  mli: { Icon: SiOcaml, color: '#EC672F' },
  sol: { Icon: SiSolidity, color: '#363636' },
  rkt: { Icon: SiRacket, color: '#9C1C1C' },
  vim: { Icon: SiVim, color: '#019733' },
  viml: { Icon: SiVim, color: '#019733' },
  ahk: { Icon: VscFileCode, color: '#334455' },
  feature: { Icon: VscFileCode, color: '#00C356' },
  groovy: { Icon: VscFileCode, color: '#4298B8' },
  gradle: { Icon: SiGradle, color: '#02303A' },
  proto: { Icon: VscFileCode, color: '#4285F4' },
  thrift: { Icon: VscFileCode, color: '#6B7280' },
  nix: { Icon: SiNixos, color: '#7EB1D6' },
  // C / C++
  c: { Icon: SiC, color: '#A8B9CC' },
  h: { Icon: SiC, color: '#A8B9CC' },
  cpp: { Icon: SiCplusplus, color: '#00599C' },
  cc: { Icon: SiCplusplus, color: '#00599C' },
  cxx: { Icon: SiCplusplus, color: '#00599C' },
  hpp: { Icon: SiCplusplus, color: '#00599C' },
  hxx: { Icon: SiCplusplus, color: '#00599C' },
  ino: { Icon: VscFileCode, color: '#00878F' },
  cs: { Icon: SiDotnet, color: '#512BD4' },
  fs: { Icon: SiDotnet, color: '#512BD4' },
  fsx: { Icon: SiDotnet, color: '#512BD4' },
  vb: { Icon: SiDotnet, color: '#512BD4' },
  // Shell
  sh: { Icon: SiGnubash, color: '#4EAA25' },
  bash: { Icon: SiGnubash, color: '#4EAA25' },
  zsh: { Icon: SiGnubash, color: '#4EAA25' },
  fish: { Icon: SiGnubash, color: '#4EAA25' },
  ps1: { Icon: VscTerminalPowershell, color: '#012456' },
  psd1: { Icon: VscTerminalPowershell, color: '#012456' },
  psm1: { Icon: VscTerminalPowershell, color: '#012456' },
  bat: { Icon: VscTerminalCmd, color: '#C8C8C8' },
  cmd: { Icon: VscTerminalCmd, color: '#C8C8C8' },
  awk: { Icon: VscFileCode, color: '#4EAA25' },
  // Data / config
  json: { Icon: VscJson, color: '#F7DF1E' },
  jsonc: { Icon: VscJson, color: '#F7DF1E' },
  json5: { Icon: VscJson, color: '#F7DF1E' },
  yaml: { Icon: SiYaml, color: '#CB171E' },
  yml: { Icon: SiYaml, color: '#CB171E' },
  toml: { Icon: SiToml, color: '#9C4121' },
  ini: { Icon: VscSettings, color: '#8B5CF6' },
  conf: { Icon: VscSettings, color: '#8B5CF6' },
  cfg: { Icon: VscSettings, color: '#8B5CF6' },
  env: { Icon: SiDotenv, color: '#ECD53F' },
  xml: { Icon: VscFileCode, color: '#E3792B' },
  plist: { Icon: VscSettings, color: '#6B7280' },
  properties: { Icon: VscSettings, color: '#8B5CF6' },
  csv: { Icon: VscFileText, color: '#2CB553' },
  tsv: { Icon: VscFileText, color: '#2CB553' },
  // Docs
  md: { Icon: SiMarkdown, color: '#0844B8' },
  markdown: { Icon: SiMarkdown, color: '#0844B8' },
  mdx: { Icon: SiMarkdown, color: '#0844B8' },
  txt: { Icon: VscFileText, color: '#6B7280' },
  log: { Icon: VscFileText, color: '#6B7280' },
  pdf: { Icon: VscFilePdf, color: '#E53935' },
  rst: { Icon: VscFileText, color: '#7D3CBE' },
  adoc: { Icon: VscFileText, color: '#E40046' },
  asciidoc: { Icon: VscFileText, color: '#E40046' },
  tex: { Icon: VscFileText, color: '#3D6117' },
  latex: { Icon: VscFileText, color: '#3D6117' },
  org: { Icon: VscFileText, color: '#77D0B0' },
  rtf: { Icon: VscFileText, color: '#6B7280' },
  // Office
  doc: { Icon: VscFileText, color: '#2B579A' },
  docx: { Icon: VscFileText, color: '#2B579A' },
  xls: { Icon: VscFileText, color: '#217346' },
  xlsx: { Icon: VscFileText, color: '#217346' },
  ppt: { Icon: VscFileText, color: '#D24726' },
  pptx: { Icon: VscFileText, color: '#D24726' },
  odt: { Icon: VscFileText, color: '#18A303' },
  ods: { Icon: VscFileText, color: '#18A303' },
  odp: { Icon: VscFileText, color: '#18A303' },
  // Images
  png: { Icon: VscFileMedia, color: '#A855F7' },
  jpg: { Icon: VscFileMedia, color: '#A855F7' },
  jpeg: { Icon: VscFileMedia, color: '#A855F7' },
  gif: { Icon: VscFileMedia, color: '#A855F7' },
  webp: { Icon: VscFileMedia, color: '#A855F7' },
  svg: { Icon: VscFileMedia, color: '#FFB13B' },
  ico: { Icon: VscFileMedia, color: '#A855F7' },
  bmp: { Icon: VscFileMedia, color: '#A855F7' },
  avif: { Icon: VscFileMedia, color: '#A855F7' },
  tiff: { Icon: VscFileMedia, color: '#A855F7' },
  tif: { Icon: VscFileMedia, color: '#A855F7' },
  heic: { Icon: VscFileMedia, color: '#A855F7' },
  heif: { Icon: VscFileMedia, color: '#A855F7' },
  psd: { Icon: VscFileMedia, color: '#31A8FF' },
  ai: { Icon: VscFileMedia, color: '#FF9A00' },
  eps: { Icon: VscFileMedia, color: '#FFB13B' },
  raw: { Icon: VscFileMedia, color: '#6B7280' },
  xcf: { Icon: VscFileMedia, color: '#535555' },
  // Video
  mp4: { Icon: VscFileMedia, color: '#FF6B6B' },
  webm: { Icon: VscFileMedia, color: '#FF6B6B' },
  mov: { Icon: VscFileMedia, color: '#FF6B6B' },
  mkv: { Icon: VscFileMedia, color: '#FF6B6B' },
  avi: { Icon: VscFileMedia, color: '#FF6B6B' },
  wmv: { Icon: VscFileMedia, color: '#FF6B6B' },
  flv: { Icon: VscFileMedia, color: '#FF6B6B' },
  m4v: { Icon: VscFileMedia, color: '#FF6B6B' },
  m3u8: { Icon: VscFileMedia, color: '#FF6B6B' },
  // Audio
  mp3: { Icon: VscMusic, color: '#EC4899' },
  wav: { Icon: VscMusic, color: '#EC4899' },
  flac: { Icon: VscMusic, color: '#EC4899' },
  ogg: { Icon: VscMusic, color: '#EC4899' },
  m4a: { Icon: VscMusic, color: '#EC4899' },
  aac: { Icon: VscMusic, color: '#EC4899' },
  opus: { Icon: VscMusic, color: '#EC4899' },
  midi: { Icon: VscMusic, color: '#EC4899' },
  mid: { Icon: VscMusic, color: '#EC4899' },
  wma: { Icon: VscMusic, color: '#EC4899' },
  aiff: { Icon: VscMusic, color: '#EC4899' },
  mka: { Icon: VscMusic, color: '#EC4899' },
  // Archives
  zip: { Icon: VscFileZip, color: '#F59E0B' },
  tar: { Icon: VscFileZip, color: '#F59E0B' },
  gz: { Icon: VscFileZip, color: '#F59E0B' },
  tgz: { Icon: VscFileZip, color: '#F59E0B' },
  rar: { Icon: VscFileZip, color: '#F59E0B' },
  '7z': { Icon: VscFileZip, color: '#F59E0B' },
  bz2: { Icon: VscFileZip, color: '#F59E0B' },
  xz: { Icon: VscFileZip, color: '#F59E0B' },
  iso: { Icon: VscFileZip, color: '#F59E0B' },
  dmg: { Icon: VscFileZip, color: '#F59E0B' },
  jar: { Icon: VscFileZip, color: '#F59E0B' },
  war: { Icon: VscFileZip, color: '#F59E0B' },
  ear: { Icon: VscFileZip, color: '#F59E0B' },
  apk: { Icon: VscFileZip, color: '#3DDC84' },
  deb: { Icon: VscFileZip, color: '#A81D33' },
  rpm: { Icon: VscFileZip, color: '#000000' },
  msi: { Icon: VscFileZip, color: '#6B7280' },
  lz: { Icon: VscFileZip, color: '#F59E0B' },
  zst: { Icon: VscFileZip, color: '#F59E0B' },
  cab: { Icon: VscFileZip, color: '#F59E0B' },
  // Database
  db: { Icon: SiSqlite, color: '#003B57' },
  sqlite: { Icon: SiSqlite, color: '#003B57' },
  sqlite3: { Icon: SiSqlite, color: '#003B57' },
  sql: { Icon: SiMysql, color: '#4479A1' },
  // Source maps
  map: { Icon: VscMap, color: '#6B7280' },
  // Keys / certs
  pem: { Icon: VscKey, color: '#10B981' },
  key: { Icon: VscKey, color: '#10B981' },
  crt: { Icon: VscKey, color: '#10B981' },
  pub: { Icon: VscKey, color: '#10B981' },
  cer: { Icon: VscKey, color: '#10B981' },
  der: { Icon: VscKey, color: '#10B981' },
  p12: { Icon: VscKey, color: '#10B981' },
  pfx: { Icon: VscKey, color: '#10B981' },
  jks: { Icon: VscKey, color: '#10B981' },
  keystore: { Icon: VscKey, color: '#10B981' },
  csr: { Icon: VscKey, color: '#10B981' },
  ovpn: { Icon: VscKey, color: '#10B981' },
  // Fonts
  ttf: { Icon: VscFileBinary, color: '#A855F7' },
  otf: { Icon: VscFileBinary, color: '#A855F7' },
  woff: { Icon: VscFileBinary, color: '#A855F7' },
  woff2: { Icon: VscFileBinary, color: '#A855F7' },
  eot: { Icon: VscFileBinary, color: '#A855F7' },
  // GraphQL
  graphql: { Icon: SiGraphql, color: '#E10098' },
  gql: { Icon: SiGraphql, color: '#E10098' },
  // Terraform / IaC
  tf: { Icon: SiTerraform, color: '#7B42BC' },
  tfvars: { Icon: SiTerraform, color: '#7B42BC' },
  tfstate: { Icon: SiTerraform, color: '#7B42BC' },
  hcl: { Icon: SiTerraform, color: '#7B42BC' },
  // Godot
  gd: { Icon: SiGodotengine, color: '#478CBF' },
  // Crystal
  cr: { Icon: SiCrystal, color: '#000000' },
  // CoffeeScript
  coffee: { Icon: SiCoffeescript, color: '#2F2614' },
}

// ── Special filenames (exact match, case-sensitive) ──────────────────────

const FILE_ICON_BY_NAME: Partial<Record<string, IconEntry>> = {
  // Package managers
  'package.json': { Icon: SiNpm, color: '#CB3837' },
  'package-lock.json': { Icon: SiNpm, color: '#CB3837' },
  'pnpm-lock.yaml': { Icon: SiPnpm, color: '#F69220' },
  'yarn.lock': { Icon: SiYarn, color: '#2C8EBB' },
  'Cargo.lock': { Icon: SiRust, color: '#DEA584' },
  'Cargo.toml': { Icon: SiRust, color: '#DEA584' },
  'go.sum': { Icon: SiGo, color: '#00ADD8' },
  'go.mod': { Icon: SiGo, color: '#00ADD8' },
  'go.work': { Icon: SiGo, color: '#00ADD8' },
  'composer.json': { Icon: SiComposer, color: '#885630' },
  'composer.lock': { Icon: SiComposer, color: '#885630' },
  'poetry.lock': { Icon: SiPython, color: '#3776AB' },
  'uv.lock': { Icon: SiPython, color: '#3776AB' },
  'bun.lockb': { Icon: SiBun, color: '#FBF0DF' },
  'bun.lock': { Icon: SiBun, color: '#FBF0DF' },
  'mix.lock': { Icon: SiElixir, color: '#4B275F' },
  'Podfile': { Icon: SiApple, color: '#A6A6A6' },
  'Podfile.lock': { Icon: SiApple, color: '#A6A6A6' },
  'Package.resolved': { Icon: SiSwift, color: '#F05138' },
  'packages.lock.json': { Icon: SiNodedotjs, color: '#339933' },
  'flake.lock': { Icon: SiNixos, color: '#7EB1D6' },
  'flake.nix': { Icon: SiNixos, color: '#7EB1D6' },
  'default.nix': { Icon: SiNixos, color: '#7EB1D6' },
  'shell.nix': { Icon: SiNixos, color: '#7EB1D6' },
  // Git
  '.gitignore': { Icon: SiGit, color: '#F05032' },
  '.gitattributes': { Icon: SiGit, color: '#F05032' },
  '.gitmodules': { Icon: SiGit, color: '#F05032' },
  '.gitconfig': { Icon: SiGit, color: '#F05032' },
  '.gitmessage': { Icon: SiGit, color: '#F05032' },
  '.git-blame-ignore-revs': { Icon: SiGit, color: '#F05032' },
  '.gitkeep': { Icon: VscFile, color: '#6B7280' },
  '.keep': { Icon: VscFile, color: '#6B7280' },
  // Docs
  'LICENSE': { Icon: VscBook, color: '#6B7280' },
  'LICENSE.md': { Icon: VscBook, color: '#6B7280' },
  'LICENSE.txt': { Icon: VscBook, color: '#6B7280' },
  'README.md': { Icon: SiMarkdown, color: '#0844B8' },
  'CHANGELOG.md': { Icon: SiMarkdown, color: '#0844B8' },
  'CONTRIBUTING.md': { Icon: VscBook, color: '#6B7280' },
  'CODE_OF_CONDUCT.md': { Icon: VscBook, color: '#6B7280' },
  'SECURITY.md': { Icon: VscBook, color: '#6B7280' },
  'AUTHORS': { Icon: VscBook, color: '#6B7280' },
  'MAINTAINERS': { Icon: VscBook, color: '#6B7280' },
  'CODEOWNERS': { Icon: SiGithub, color: '#181717' },
  // Docker
  'Dockerfile': { Icon: SiDocker, color: '#2496ED' },
  'Dockerfile.dev': { Icon: SiDocker, color: '#2496ED' },
  'Dockerfile.prod': { Icon: SiDocker, color: '#2496ED' },
  'Dockerfile.test': { Icon: SiDocker, color: '#2496ED' },
  'docker-compose.yml': { Icon: SiDocker, color: '#2496ED' },
  'docker-compose.yaml': { Icon: SiDocker, color: '#2496ED' },
  'docker-compose.override.yml': { Icon: SiDocker, color: '#2496ED' },
  'Containerfile': { Icon: SiDocker, color: '#2496ED' },
  '.dockerignore': { Icon: SiDocker, color: '#2496ED' },
  '.containerignore': { Icon: SiDocker, color: '#2496ED' },
  // Build
  'Makefile': { Icon: SiCmake, color: '#064F8C' },
  'CMakeLists.txt': { Icon: SiCmake, color: '#064F8C' },
  '.editorconfig': { Icon: VscSettings, color: '#E0EFEF' },
  // Env
  '.env': { Icon: SiDotenv, color: '#ECD53F' },
  '.env.local': { Icon: SiDotenv, color: '#ECD53F' },
  '.env.development': { Icon: SiDotenv, color: '#ECD53F' },
  '.env.production': { Icon: SiDotenv, color: '#ECD53F' },
  '.env.example': { Icon: SiDotenv, color: '#ECD53F' },
  '.env.test': { Icon: SiDotenv, color: '#ECD53F' },
  '.env.staging': { Icon: SiDotenv, color: '#ECD53F' },
  '.env.docker': { Icon: SiDotenv, color: '#ECD53F' },
  // TypeScript / JS config
  'tsconfig.json': { Icon: SiTypescript, color: '#3178C6' },
  'tsconfig.base.json': { Icon: SiTypescript, color: '#3178C6' },
  'jsconfig.json': { Icon: SiJavascript, color: '#F7DF1E' },
  // Bundlers / build tools
  'vite.config.ts': { Icon: SiVite, color: '#646CFF' },
  'vite.config.js': { Icon: SiVite, color: '#646CFF' },
  'vite.config.mts': { Icon: SiVite, color: '#646CFF' },
  'vite.config.mjs': { Icon: SiVite, color: '#646CFF' },
  'webpack.config.js': { Icon: SiWebpack, color: '#1C78C0' },
  'webpack.config.ts': { Icon: SiWebpack, color: '#1C78C0' },
  'rollup.config.js': { Icon: SiRollupdotjs, color: '#C3413D' },
  'rollup.config.mjs': { Icon: SiRollupdotjs, color: '#C3413D' },
  'esbuild.config.js': { Icon: SiEsbuild, color: '#FFCF00' },
  'gulpfile.js': { Icon: SiGulp, color: '#CF4647' },
  'gulpfile.ts': { Icon: SiGulp, color: '#CF4647' },
  'gulpfile.mjs': { Icon: SiGulp, color: '#CF4647' },
  'gruntfile.js': { Icon: SiGrunt, color: '#FBA937' },
  'tsup.config.ts': { Icon: VscSettings, color: '#646CFF' },
  'tsdown.config.ts': { Icon: VscSettings, color: '#646CFF' },
  'unbuild.config.ts': { Icon: VscSettings, color: '#646CFF' },
  'farm.config.ts': { Icon: VscSettings, color: '#646CFF' },
  'rspack.config.js': { Icon: VscSettings, color: '#646CFF' },
  'swc.config.js': { Icon: SiSwc, color: '#E0BD6E' },
  '.swcrc': { Icon: SiSwc, color: '#E0BD6E' },
  'turbo.json': { Icon: SiTurbo, color: '#6DD3C6' },
  'turbo.config.json': { Icon: SiTurbo, color: '#6DD3C6' },
  'nx.json': { Icon: SiNx, color: '#14305F' },
  'lerna.json': { Icon: SiLerna, color: '#9333EA' },
  'biome.json': { Icon: SiBiome, color: '#60A5FA' },
  // Frameworks
  'next.config.js': { Icon: SiNextdotjs, color: '#000000' },
  'next.config.mjs': { Icon: SiNextdotjs, color: '#000000' },
  'next.config.ts': { Icon: SiNextdotjs, color: '#000000' },
  'nuxt.config.ts': { Icon: SiNuxt, color: '#00DC82' },
  'nuxt.config.js': { Icon: SiNuxt, color: '#00DC82' },
  'angular.json': { Icon: SiAngular, color: '#DD0031' },
  'svelte.config.js': { Icon: SiSvelte, color: '#FF3E00' },
  'astro.config.mjs': { Icon: SiAstro, color: '#FF5E00' },
  'astro.config.ts': { Icon: SiAstro, color: '#FF5E00' },
  'remix.config.js': { Icon: SiRemix, color: '#3992FF' },
  'gatsby-config.js': { Icon: SiGatsby, color: '#663399' },
  'gatsby-config.ts': { Icon: SiGatsby, color: '#663399' },
  'tailwind.config.js': { Icon: SiTailwindcss, color: '#06B6D4' },
  'tailwind.config.ts': { Icon: SiTailwindcss, color: '#06B6D4' },
  'tauri.conf.json': { Icon: SiTauri, color: '#FFC131' },
  'vercel.json': { Icon: SiVercel, color: '#000000' },
  'netlify.toml': { Icon: SiNetlify, color: '#00C7B7' },
  'docusaurus.config.js': { Icon: SiDocusaurus, color: '#3ECCF4' },
  'docusaurus.config.ts': { Icon: SiDocusaurus, color: '#3ECCF4' },
  'vitepress.config.ts': { Icon: SiVitepress, color: '#5672CD' },
  'vitepress.config.js': { Icon: SiVitepress, color: '#5672CD' },
  // Testing
  'playwright.config.ts': { Icon: VscSettings, color: '#2EAD33' },
  'playwright.config.js': { Icon: VscSettings, color: '#2EAD33' },
  'vitest.config.ts': { Icon: SiVitest, color: '#FCC00B' },
  'vitest.config.js': { Icon: SiVitest, color: '#FCC00B' },
  'jest.config.js': { Icon: SiJest, color: '#C21325' },
  'jest.config.ts': { Icon: SiJest, color: '#C21325' },
  'cypress.config.ts': { Icon: SiCypress, color: '#17202C' },
  'cypress.config.js': { Icon: SiCypress, color: '#17202C' },
  // Linting / formatting
  '.eslintrc.js': { Icon: SiEslint, color: '#4B32C3' },
  '.eslintrc.json': { Icon: SiEslint, color: '#4B32C3' },
  '.eslintrc.cjs': { Icon: SiEslint, color: '#4B32C3' },
  '.eslintrc.mjs': { Icon: SiEslint, color: '#4B32C3' },
  '.eslintrc.yml': { Icon: SiEslint, color: '#4B32C3' },
  'eslint.config.js': { Icon: SiEslint, color: '#4B32C3' },
  'eslint.config.mjs': { Icon: SiEslint, color: '#4B32C3' },
  'eslint.config.ts': { Icon: SiEslint, color: '#4B32C3' },
  '.eslintignore': { Icon: SiEslint, color: '#4B32C3' },
  '.prettierrc': { Icon: SiPrettier, color: '#F7B93E' },
  '.prettierrc.json': { Icon: SiPrettier, color: '#F7B93E' },
  '.prettierrc.js': { Icon: SiPrettier, color: '#F7B93E' },
  '.prettierrc.cjs': { Icon: SiPrettier, color: '#F7B93E' },
  '.prettierrc.mjs': { Icon: SiPrettier, color: '#F7B93E' },
  '.prettierrc.toml': { Icon: SiPrettier, color: '#F7B93E' },
  '.prettierrc.json5': { Icon: SiPrettier, color: '#F7B93E' },
  'prettier.config.js': { Icon: SiPrettier, color: '#F7B93E' },
  'prettier.config.mjs': { Icon: SiPrettier, color: '#F7B93E' },
  '.prettierignore': { Icon: SiPrettier, color: '#F7B93E' },
  '.stylelintrc': { Icon: SiStylelint, color: '#263A6F' },
  '.stylelintrc.json': { Icon: SiStylelint, color: '#263A6F' },
  '.stylelintrc.js': { Icon: SiStylelint, color: '#263A6F' },
  '.stylelintignore': { Icon: SiStylelint, color: '#263A6F' },
  'babel.config.js': { Icon: SiBabel, color: '#F9DC3D' },
  'babel.config.json': { Icon: SiBabel, color: '#F9DC3D' },
  '.babelrc': { Icon: SiBabel, color: '#F9DC3D' },
  '.babelrc.json': { Icon: SiBabel, color: '#F9DC3D' },
  '.babelrc.cjs': { Icon: SiBabel, color: '#F9DC3D' },
  'postcss.config.js': { Icon: SiPostcss, color: '#DD3A8C' },
  'postcss.config.ts': { Icon: SiPostcss, color: '#DD3A8C' },
  '.postcssrc': { Icon: SiPostcss, color: '#DD3A8C' },
  '.postcssrc.json': { Icon: SiPostcss, color: '#DD3A8C' },
  // Other config
  '.npmrc': { Icon: SiNpm, color: '#CB3837' },
  '.yarnrc': { Icon: SiYarn, color: '#2C8EBB' },
  '.pnpmrc': { Icon: SiPnpm, color: '#F69220' },
  '.npmignore': { Icon: SiNpm, color: '#CB3837' },
  '.nvmrc': { Icon: SiNodedotjs, color: '#339933' },
  '.node-version': { Icon: SiNodedotjs, color: '#339933' },
  '.ruby-version': { Icon: SiRuby, color: '#CC342D' },
  '.python-version': { Icon: SiPython, color: '#3776AB' },
  '.lintstagedrc': { Icon: VscSettings, color: '#F7B500' },
  '.lintstagedrc.json': { Icon: VscSettings, color: '#F7B500' },
  '.commitlintrc': { Icon: SiConventionalcommits, color: '#FE5197' },
  '.commitlintrc.json': { Icon: SiConventionalcommits, color: '#FE5197' },
  '.releaserc': { Icon: VscSettings, color: '#F7B500' },
  '.releaserc.json': { Icon: VscSettings, color: '#F7B500' },
  '.czrc': { Icon: VscSettings, color: '#F7B500' },
  // Ruby / Python
  'Gemfile': { Icon: SiRuby, color: '#CC342D' },
  'Gemfile.lock': { Icon: SiRuby, color: '#CC342D' },
  'Rakefile': { Icon: SiRuby, color: '#CC342D' },
  'requirements.txt': { Icon: SiPython, color: '#3776AB' },
  'setup.py': { Icon: SiPython, color: '#3776AB' },
  'pyproject.toml': { Icon: SiPython, color: '#3776AB' },
  'manage.py': { Icon: SiDjango, color: '#092E20' },
  // CI/CD
  'Jenkinsfile': { Icon: SiJenkins, color: '#D24939' },
  '.gitlab-ci.yml': { Icon: SiGitlab, color: '#FC6D26' },
  '.travis.yml': { Icon: VscSettings, color: '#3EAAAF' },
  'azure-pipelines.yml': { Icon: VscSettings, color: '#0078D4' },
  'bitbucket-pipelines.yml': { Icon: VscSettings, color: '#0052CC' },
  '.drone.yml': { Icon: VscSettings, color: '#212121' },
  'cloudbuild.yaml': { Icon: SiGooglecloud, color: '#4285F4' },
  // K8s / Helm
  'Chart.yaml': { Icon: SiHelm, color: '#0F1689' },
  'values.yaml': { Icon: SiHelm, color: '#0F1689' },
  'kustomization.yaml': { Icon: SiKubernetes, color: '#326CE5' },
  'kustomization.yml': { Icon: SiKubernetes, color: '#326CE5' },
  'skaffold.yaml': { Icon: SiKubernetes, color: '#326CE5' },
  '.helmignore': { Icon: SiHelm, color: '#0F1689' },
  // Serverless
  'serverless.yml': { Icon: VscSettings, color: '#6B7280' },
  'sam.yaml': { Icon: VscSettings, color: '#6B7280' },
  'appspec.yml': { Icon: VscSettings, color: '#6B7280' },
  // Prisma
  'schema.prisma': { Icon: SiPrisma, color: '#5D8AA8' },
  // Misc
  'Procfile': { Icon: SiNodedotjs, color: '#339933' },
  '.storybook/main.js': { Icon: SiStorybook, color: '#FF4785' },
  '.storybook/main.ts': { Icon: SiStorybook, color: '#FF4785' },
  '.storybook/preview.js': { Icon: SiStorybook, color: '#FF4785' },
  '.storybook/preview.ts': { Icon: SiStorybook, color: '#FF4785' },
}

// ── Special folder colors ───────────────────────────────────────────────

/** Folder name → tint color (applied to VscFolder / VscFolderOpened). */
const FOLDER_COLOR: Record<string, string> = {
  // Package / dependency
  node_modules: '#CB3837',
  packages: '#CB3837',
  // Source
  src: '#3178C6',
  source: '#3178C6',
  app: '#3178C6',
  apps: '#3178C6',
  core: '#A855F7',
  common: '#6B7280',
  shared: '#6B7280',
  internal: '#6B7280',
  modules: '#3178C6',
  plugins: '#42B883',
  // Git
  '.git': '#F05032',
  '.github': '#F05032',
  '.husky': '#F05032',
  // Output
  public: '#42B883',
  static: '#42B883',
  dist: '#E34F26',
  build: '#E34F26',
  out: '#E34F26',
  '.output': '#E34F26',
  '.next': '#000000',
  '.nuxt': '#00DC82',
  '.svelte-kit': '#FF3E00',
  '.astro': '#FF5E00',
  '.turbo': '#6DD3C6',
  '.parcel-cache': '#6B7280',
  '.vercel': '#000000',
  '.netlify': '#00C7B7',
  '.serverless': '#6B7280',
  '.terraform': '#7B42BC',
  '.terragrunt-cache': '#7B42BC',
  '.docusaurus': '#3ECCF4',
  '.cache': '#6B7280',
  // Testing
  test: '#F7DF1E',
  tests: '#F7DF1E',
  __tests__: '#F7DF1E',
  __mocks__: '#F7DF1E',
  __snapshots__: '#F7DF1E',
  __pacts__: '#F7DF1E',
  spec: '#F7DF1E',
  specs: '#F7DF1E',
  mocks: '#F7DF1E',
  fixtures: '#F7DF1E',
  e2e: '#F7DF1E',
  cypress: '#17202C',
  '.nyc_output': '#F7DF1E',
  coverage: '#42B883',
  // IDE / editor
  '.vscode': '#3178C6',
  '.idea': '#3178C6',
  '.devcontainer': '#3178C6',
  '.codesandbox': '#6B7280',
  '.stackblitz': '#6B7280',
  '.gitpod': '#6B7280',
  // Assets
  assets: '#A855F7',
  images: '#A855F7',
  img: '#A855F7',
  icons: '#A855F7',
  fonts: '#A855F7',
  media: '#A855F7',
  resources: '#A855F7',
  content: '#A855F7',
  // Styles
  styles: '#CC6699',
  stylesheets: '#CC6699',
  css: '#CC6699',
  themes: '#CC6699',
  templates: '#CC6699',
  partials: '#CC6699',
  layouts: '#CC6699',
  // Components
  components: '#42B883',
  composables: '#42B883',
  hooks: '#42B883',
  // Library
  lib: '#6B7280',
  libs: '#6B7280',
  vendor: '#6B7280',
  // Docs
  docs: '#0844B8',
  documentation: '#0844B8',
  examples: '#6B7280',
  playground: '#42B883',
  benchmarks: '#4EAA25',
  // Scripts
  scripts: '#4EAA25',
  bin: '#4EAA25',
  tools: '#4EAA25',
  // Config
  config: '#F7B500',
  configs: '#F7B500',
  '.config': '#F7B500',
  // i18n
  locales: '#F7B500',
  i18n: '#F7B500',
  translations: '#F7B500',
  lang: '#F7B500',
  language: '#F7B500',
  // Routing
  pages: '#3178C6',
  views: '#3178C6',
  routes: '#3178C6',
  router: '#3178C6',
  // State
  store: '#A855F7',
  stores: '#A855F7',
  state: '#A855F7',
  // Utils
  utils: '#6B7280',
  helpers: '#6B7280',
  types: '#3178C6',
  typings: '#3178C6',
  // Backend
  api: '#42B883',
  server: '#42B883',
  services: '#42B883',
  client: '#3178C6',
  clients: '#3178C6',
  middleware: '#CC6699',
  controllers: '#42B883',
  models: '#A855F7',
  entities: '#A855F7',
  repositories: '#A855F7',
  migrations: '#4479A1',
  seeds: '#4479A1',
  factories: '#4479A1',
  // Jobs / workers
  tasks: '#4EAA25',
  jobs: '#4EAA25',
  workers: '#4EAA25',
  queues: '#4EAA25',
  // Events
  events: '#F7DF1E',
  listeners: '#F7DF1E',
  observers: '#F7DF1E',
  notifications: '#F7DF1E',
  mail: '#F7DF1E',
  emails: '#F7DF1E',
  channels: '#F7DF1E',
  commands: '#4EAA25',
  console: '#4EAA25',
  cron: '#4EAA25',
  // Temp / data
  pub: '#42B883',
  tmp: '#6B7280',
  temp: '#6B7280',
  cache: '#6B7280',
  logs: '#6B7280',
  data: '#A855F7',
  backup: '#6B7280',
  www: '#42B883',
  webroot: '#42B883',
  // CI/CD
  '.gitlab': '#FC6D26',
  '.circleci': '#6B7280',
  '.travis': '#6B7280',
  '.drone': '#6B7280',
  '.azure': '#0078D4',
  // Mobile
  android: '#3DDC84',
  ios: '#000000',
  Android: '#3DDC84',
  IOS: '#000000',
  Platforms: '#3178C6',
}

// ── Active theme override ────────────────────────────────────────────────
// The sidebar sets the active file-icon theme (selected by the user in
// settings) via setActiveFileIconTheme. The active theme's resolvers are
// called FIRST; returning undefined falls through to the built-in mapping.
// - 'none' theme: resolvers return generic VscFile/VscFolder directly →
//   never reaches the mapping → original look.
// - 'builtin' theme: resolvers return undefined → falls through to the
//   563-entry colored mapping.
// - External themes: return ReactNode or undefined (fall through).
let activeTheme: FileIconTheme | undefined
let themeRevision = 0
const themeListeners = new Set<() => void>()

/**
 * Set the active file-icon theme. Called by the Sidebar shell on mount and
 * whenever the user's selection or the registry changes.
 */
export function setActiveFileIconTheme(theme: FileIconTheme | undefined): void {
  activeTheme = theme
  themeRevision++
  for (const fn of [...themeListeners]) fn()
}

/**
 * Subscribe to file-icon theme changes (for useSyncExternalStore in
 * components that render icons and need to re-render on theme switch).
 */
export function subscribeFileIconTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  return () => { themeListeners.delete(listener) }
}

/** The current theme revision (changes on every setActiveFileIconTheme call). */
export function getFileIconThemeRevision(): number {
  return themeRevision
}

// ── Public lookup functions ──────────────────────────────────────────────

export function fileIcon(name: string): ReactNode {
  if (activeTheme?.fileIcon !== undefined) {
    try {
      const custom = activeTheme.fileIcon(name)
      if (custom !== undefined) return custom
    } catch { /* fall through */ }
  }
  const byName = FILE_ICON_BY_NAME[name]
  if (byName !== undefined) return colored(byName)
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  const byExt = ext !== '' ? FILE_ICON_BY_EXT[ext] : undefined
  if (byExt !== undefined) return colored(byExt)
  return <VscFile size={14} />
}

export function folderIcon(name: string, isOpen: boolean): ReactNode {
  if (activeTheme?.folderIcon !== undefined) {
    try {
      const custom = activeTheme.folderIcon(name, isOpen)
      if (custom !== undefined) return custom
    } catch { /* fall through */ }
  }
  const tint = FOLDER_COLOR[name]
  const Icon = isOpen ? VscFolderOpened : VscFolder
  if (tint !== undefined) return <Icon size={14} style={{ color: tint }} />
  return <Icon size={14} />
}

/**
 * The "no icons" theme (id 'none'): restores the original file-tree look.
 * Its resolvers return generic glyphs directly, so the built-in mapping
 * is never reached. This is the DEFAULT theme — users who never touch
 * the setting see zero change from before this feature.
 */
export const NONE_FILE_ICON_THEME: FileIconTheme = {
  id: 'none',
  name: 'None (original)',
  fileIcon: () => <VscFile size={14} />,
  folderIcon: (_name: string, isOpen: boolean) => {
    const Icon = isOpen ? VscFolderOpened : VscFolder
    return <Icon size={14} />
  },
}

/**
 * The built-in colored icon theme (id 'builtin'): brand-colored file icons
 * + per-folder-name color tints. Its resolvers return undefined so the
 * fileIcon/folderIcon functions handle everything through the mapping.
 */
export const BUILTIN_FILE_ICON_THEME: FileIconTheme = {
  id: 'builtin',
  name: 'Seti + Brand (built-in)',
  fileIcon: () => undefined,
  folderIcon: () => undefined,
}
