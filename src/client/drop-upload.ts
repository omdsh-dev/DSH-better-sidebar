export interface UploadItem {
  file: File
  relativePath: string
}

interface LegacyEntryBase {
  name: string
  isFile: boolean
  isDirectory: boolean
}
interface LegacyFileEntry extends LegacyEntryBase {
  isFile: true
  isDirectory: false
  file(success: (file: File) => void, failure?: (error: unknown) => void): void
}
interface LegacyDirectoryReader {
  readEntries(success: (entries: LegacyEntry[]) => void, failure?: (error: unknown) => void): void
}
interface LegacyDirectoryEntry extends LegacyEntryBase {
  isFile: false
  isDirectory: true
  createReader(): LegacyDirectoryReader
}
type LegacyEntry = LegacyFileEntry | LegacyDirectoryEntry

/** Files chosen through either a normal or webkitdirectory input. */
export function uploadItemsFromFiles(files: FileList | readonly File[]): UploadItem[] {
  return Array.from(files).map(file => ({
    file,
    relativePath: normalizeRelative((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name),
  }))
}

/** Preserve folder structure for Chromium directory drops, with FileList fallback. */
export async function uploadItemsFromDrop(data: DataTransfer): Promise<UploadItem[]> {
  const entries: LegacyEntry[] = []
  for (const item of Array.from(data.items ?? [])) {
    const legacy = item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }
    const entry = legacy.kind === 'file' ? legacy.webkitGetAsEntry?.() ?? null : null
    if (entry !== null) entries.push(entry as unknown as LegacyEntry)
  }
  if (entries.length === 0) return uploadItemsFromFiles(data.files)
  const nested = await Promise.all(entries.map(entry => walkEntry(entry, '')))
  return nested.flat()
}

async function walkEntry(entry: LegacyEntry, parent: string): Promise<UploadItem[]> {
  const relativePath = normalizeRelative(parent === '' ? entry.name : `${parent}/${entry.name}`)
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => { entry.file(resolve, reject) })
    return [{ file, relativePath }]
  }
  const children = await readAllEntries(entry.createReader())
  const nested = await Promise.all(children.map(child => walkEntry(child, relativePath)))
  return nested.flat()
}

/** DirectoryReader returns batches and must be drained until an empty batch. */
async function readAllEntries(reader: LegacyDirectoryReader): Promise<LegacyEntry[]> {
  const all: LegacyEntry[] = []
  for (;;) {
    const batch = await new Promise<LegacyEntry[]>((resolve, reject) => { reader.readEntries(resolve, reject) })
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

function normalizeRelative(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}
