// Layout & Navigation
export { default as ActivityBar } from './ActivityBar'
export { default as BottomPanel } from './BottomPanel'
export { default as StatusBar } from './StatusBar'
export { default as NavigationControls } from './NavigationControls'
export { default as Breadcrumbs } from './Breadcrumbs'
export { default as WindowControls } from './WindowControls'
export { default as ExplorerPanel } from './ExplorerPanel'

// Editor
export { default as MonacoEditor } from './MonacoEditor'
export { default as EditorTabs } from './EditorTabs'
export { default as EditorTab } from './EditorTab'
export type { EditorTabProps } from './EditorTab'
export { default as LanguageSelector } from './LanguageSelector'
export { default as IndentationMenu } from './IndentationMenu'
export { default as TabContextMenu } from './TabContextMenu'

// Panels & Content
export { default as SearchPanel } from './SearchPanel'
export { default as FileTree } from './FileTree'
export { default as QuickOpen } from './QuickOpen'
export { default as CommandPalette } from './CommandPalette'
export { default as ProjectStatus } from './ProjectStatus'
export { default as PerformanceStatus } from './PerformanceStatus'
export { default as OutputContent } from './OutputContent'
export { default as ProblemsContent } from './ProblemsContent'
export { default as DebugConsoleContent } from './DebugConsoleContent'

// Shared UI primitives
export { PanelHeader } from './PanelHeader'
export { PanelTab } from './PanelTab'
export { SearchInput } from './SearchInput'
export { OptionButton } from './OptionButton'

// Loading & Feedback
export { default as ToastContainer } from './Toast'
export { ShimmerStyle, SkeletonLine, SkeletonRect, SkeletonCircle } from './Skeleton'
export { LoadingSpinner } from './LoadingSpinner'
export { default as FileTreeSkeleton } from './FileTreeSkeleton'

// Color mode
export { Provider } from './provider'
export { ColorModeProvider, useColorMode } from './color-mode'
export type { ColorModeProviderProps } from './color-mode'
