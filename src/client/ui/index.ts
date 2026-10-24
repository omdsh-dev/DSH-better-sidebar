/**
 * The global UI kit's public face. Pages import from HERE (`./ui/index.ts`)
 * so the component set is one reviewable surface; the modules behind it stay
 * free to split further without touching call sites.
 */
export {
  Chip, ConfirmDialog, IconButton, Notice, SectionHeader, StatusBadge,
  type StatusTone,
} from './kit.tsx'
export {
  invalidateGitStatus, statusOfXY, useGitStatus,
  type GitFileStatus, type GitStatusView, type GitTone,
} from './git-status.ts'
