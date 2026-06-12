import { create } from 'zustand'
import type { GitFileStatus } from '../services/gitService'

// Shared git status for the whole app (SourceControlPanel, activity-bar badge,
// …). Populated exclusively by services/gitStatusPoller.ts — components only
// read. Before this store existed, the panel and the toolbar each ran their
// own 6s setInterval issuing duplicate git_status_files IPCs (user report,
// 2026-06-12); a single poller feeding one store halves the traffic.

interface GitStatusState {
  files: GitFileStatus[]
  branch: string
  /** Commits ahead/behind of @{upstream}. Only meaningful when hasUpstream. */
  ahead: number
  behind: number
  hasUpstream: boolean
  /** True only during user-requested (spinner) refreshes, not background polls. */
  loading: boolean
}

interface GitStatusActions {
  /** Internal — poller only. */
  _update: (partial: Partial<GitStatusState>) => void
  _reset: () => void
}

const initial: GitStatusState = {
  files: [],
  branch: '',
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  loading: false,
}

export const useGitStatusStore = create<GitStatusState & GitStatusActions>(set => ({
  ...initial,
  _update: partial => set(partial),
  _reset: () => set(initial),
}))
