import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { t } from '@/i18n'
import { invoke } from '@/utils/invokeMetrics'
import { useLayoutStore } from '@/stores/layoutStore'
import { useProjectStore } from '@/stores/projectStore'
import type { RecentProject } from '@/types/project'

const isMac = /Mac/.test(navigator.platform || '')

/** Returns true when the switch actually happened (openProject can DECLINE
 *  via the agent-busy confirm, leaving the current project in place). */
async function switchProject(projectPath: string): Promise<boolean> {
  const currentProject = useProjectStore.getState().currentProject
  if (currentProject?.path === projectPath) return true

  // No cleanupOnExit here: the project-change effect in App.tsx already
  // saves the previous session when currentProject flips — and openProject
  // can now DECLINE ("keep working"). Tearing chat state down BEFORE the
  // confirm left the project the user chose to stay in with auto-save dead.
  await useProjectStore.getState().openProject(projectPath)
  return useProjectStore.getState().currentProject?.path === projectPath
}

export async function openProjectInEditor(projectPath: string): Promise<void> {
  const switched = await switchProject(projectPath)
  if (switched) useLayoutStore.getState().setViewMode('editor')
}

export async function showProjectContextMenu(project: RecentProject): Promise<void> {
  const [
    openEditorItem,
    newWindowItem,
    revealItem,
    separator1,
    removeItem,
    separator2,
    deleteItem,
  ] = await Promise.all([
    MenuItem.new({
      text: t('misc.openInEditorMenu'),
      action: () => { void openProjectInEditor(project.path) },
    }),
    MenuItem.new({
      text: t('misc.openInNewWindow'),
      action: () => {
        void invoke('open_new_instance', { projectPath: project.path }).catch(() => {})
      },
    }),
    MenuItem.new({
      text: isMac ? t('misc.revealInFinder') : t('misc.revealInExplorer'),
      action: () => { revealItemInDir(project.path).catch(() => {}) },
    }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    MenuItem.new({
      text: t('misc.removeFromRecent'),
      action: () => {
        useProjectStore.getState().removeFromRecent(project.id).catch(() => {})
      },
    }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    MenuItem.new({
      text: t('misc.deleteProject'),
      action: () => {
        useProjectStore.getState().deleteProject(project.id, project.path).catch(() => {})
      },
    }),
  ])

  // Opening a SECOND window on the project this window already has open
  // would put two processes on the same sessions/state dir — hide the
  // affordance instead of letting the user race themselves.
  const isCurrentProject = useProjectStore.getState().currentProject?.path === project.path
  const items = isCurrentProject
    ? [openEditorItem, revealItem, separator1, removeItem, separator2, deleteItem]
    : [openEditorItem, newWindowItem, revealItem, separator1, removeItem, separator2, deleteItem]

  const menu = await Menu.new({ items })

  await menu.popup()
}
