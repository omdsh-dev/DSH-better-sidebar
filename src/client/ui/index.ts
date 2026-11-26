/**
 * The global UI kit's public face. Pages import from HERE (`./ui/index.ts`)
 * so the component set is one reviewable surface; the modules behind it stay
 * free to split further without touching call sites.
 */
export {
  ActionButton, Chip, ConfirmDialog, DownloadLink, FileAttachmentChip, IconButton, Notice, SectionHeader, StatusBadge,
  type FileAttachmentChipProps, type StatusTone,
} from './kit.tsx'
export { LoadingIndicator, type LoadingIndicatorProps } from './LoadingIndicator.tsx'
export { WorkbenchSection, type WorkbenchSectionProps } from './WorkbenchSection.tsx'
export { WorkbenchStack, type WorkbenchStackSection } from './WorkbenchStack.tsx'
export { SelectMenu, type SelectMenuProps, type SelectOption } from './SelectMenu.tsx'
export { TextInput, TextArea, NumberInput, Checkbox, ToggleSwitch, Tabs, SettingRow, type TabOption } from './controls.tsx'
export {
  ActionFooter, ChoiceCard, Disclosure, EmptyState, ErrorBlock, FactList, FactRow, FallbackPane, Field, ListRow, StatusLine,
  type ActionFooterProps, type ChoiceCardProps, type ChoiceOption, type DisclosureProps, type EmptyStateProps,
  type ErrorBlockProps, type Fact, type FactListProps, type FactRowProps, type FallbackPaneProps, type FieldProps,
  type ListRowProps, type PatternTone, type StatusLineProps,
} from './patterns.tsx'
export { SourceSwitcher, type SourceSwitcherItem, type SourceSwitcherProps } from './SourceSwitcher.tsx'
export { SearchField, type SearchFieldProps } from './SearchField.tsx'
export { SidebarToolbar, type SidebarToolbarProps } from './SidebarToolbar.tsx'
export { Menu, MenuSurface } from './Menu.tsx'
export { useScrollLoad, type ScrollLoadOptions } from './use-scroll-load.ts'
export {
  invalidateGitStatus, statusOfXY, useGitStatus,
  type GitFileStatus, type GitStatusView, type GitTone,
} from './git-status.ts'
