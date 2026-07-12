import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { t } from '@/i18n'
import { invoke } from '@/utils/invokeMetrics'
import { useChatStore } from '@/stores/chatStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useProjectStore } from '@/stores/projectStore'
import type { RecentProject } from '@/types/project'

const isMac = /Mac/.test(navigator.platform || '')

async function switchProject(projectPath: string): Promise<void> {
  const currentProject = useProjectStore.getState().currentProject
  if (currentProject?.path === projectPath) return

  const chatStore = useChatStore.getState()
  if (currentProject) {
    await chatStore.cleanupOnExit(currentProject.path).catch(() => {})
  }

  await useProjectStore.getState().openProject(projectPath)
}

export async function openProjectInEditor(projectPath: string): Promise<void> {
  await switchProject(projectPath)
  useLayoutStore.getState().setViewMode('editor')
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
