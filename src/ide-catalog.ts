/**
 * IDE identities shared by the host detector and the browser menu. Keep this
 * module platform-neutral: it is reachable from the client declaration graph.
 */
export const IDE_CATALOG = [
  { id: 'vscode', name: 'Visual Studio Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'windsurf', name: 'Windsurf' },
  { id: 'zed', name: 'Zed' },
  { id: 'vscodium', name: 'VSCodium' },
  { id: 'trae', name: 'Trae' },
  { id: 'intellij', name: 'IntelliJ IDEA' },
  { id: 'webstorm', name: 'WebStorm' },
  { id: 'pycharm', name: 'PyCharm' },
  { id: 'goland', name: 'GoLand' },
  { id: 'clion', name: 'CLion' },
  { id: 'rider', name: 'Rider' },
  { id: 'android-studio', name: 'Android Studio' },
  { id: 'xcode', name: 'Xcode' },
  { id: 'visual-studio', name: 'Visual Studio' },
  { id: 'sublime-text', name: 'Sublime Text' },
] as const

/** Stable machine-readable identity accepted by the launch route. */
export type IdeId = typeof IDE_CATALOG[number]['id']

/** Public detection result sent to the client (never exposes executable paths). */
export interface InstalledIde {
  id: IdeId
  name: string
}

const IDE_IDS = new Set<string>(IDE_CATALOG.map(ide => ide.id))

/** Runtime guard for the untrusted id received over HTTP. */
export function isIdeId(value: string): value is IdeId {
  return IDE_IDS.has(value)
}
