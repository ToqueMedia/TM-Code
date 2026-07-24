/**
 * F5 — park/restore per-project workspace UI so in-window project switch
 * keeps each project's preview, layout, and HTTP client "alive" without
 * tearing them down.
 *
 * The focused project always owns the live Zustand stores (layoutStore,
 * httpClientStore). On switch we snapshot the outgoing project into this
 * module and rehydrate the incoming project's snapshot (or defaults).
 *
 * Dev-server PROCESSES are owned by `devServerManager` multi-slot; this
 * park only holds the layout mirror + HTTP client tabs for the UI.
 */

import type { ViewMode, PreviewMode, DevServerInfo, DevServerLogEntry, ScaffoldPhase } from '../stores/layoutStore'

export interface LayoutParkSnapshot {
  viewMode: ViewMode
  previousViewMode: ViewMode | null
  devServer: DevServerInfo | null
  previewMode: PreviewMode
  isHttpDrawerOpen: boolean
  isPreviewFullscreen: boolean
  previewHtmlContent: string | null
  previewSourcePath: string | null
  previewReloadKey: number
  previewServerTimedOut: boolean
  devServerLogs: DevServerLogEntry[]
  isConsoleVisible: boolean
  isPreviewServerLoading: boolean
  isInstallingDeps: boolean
  scaffoldPhase: ScaffoldPhase
  scaffoldMessage: string
}

export interface HttpClientParkSnapshot {
  tabs: unknown[]
  activeTabId: string
  history: unknown[]
  isHistoryOpen: boolean
}

const layoutParks = new Map<string, LayoutParkSnapshot>()
const httpParks = new Map<string, HttpClientParkSnapshot>()

export function parkLayout(projectPath: string, snap: LayoutParkSnapshot): void {
  if (!projectPath) return
  layoutParks.set(projectPath, snap)
}

export function takeLayoutPark(projectPath: string): LayoutParkSnapshot | null {
  if (!projectPath) return null
  return layoutParks.get(projectPath) ?? null
}

export function clearLayoutPark(projectPath: string): void {
  layoutParks.delete(projectPath)
}

export function parkHttpClient(projectPath: string, snap: HttpClientParkSnapshot): void {
  if (!projectPath) return
  httpParks.set(projectPath, snap)
}

export function takeHttpPark(projectPath: string): HttpClientParkSnapshot | null {
  if (!projectPath) return null
  return httpParks.get(projectPath) ?? null
}

export function clearHttpPark(projectPath: string): void {
  httpParks.delete(projectPath)
}

/** Drop all parks for a project (close / delete). */
export function clearProjectParks(projectPath: string): void {
  clearLayoutPark(projectPath)
  clearHttpPark(projectPath)
}
