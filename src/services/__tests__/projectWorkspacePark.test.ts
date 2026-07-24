import {
  parkLayout,
  takeLayoutPark,
  parkHttpClient,
  takeHttpPark,
  clearProjectParks,
} from '../projectWorkspacePark'
import type { LayoutParkSnapshot } from '../projectWorkspacePark'

const emptyLayout = (): LayoutParkSnapshot => ({
  viewMode: 'preview',
  previousViewMode: 'chat',
  devServer: {
    pid: 42,
    projectKind: 'frontend',
    frontendUrl: 'http://localhost:5173/',
    backendUrl: null,
    status: 'running',
  },
  previewMode: 'server',
  isHttpDrawerOpen: false,
  isPreviewFullscreen: false,
  previewHtmlContent: null,
  previewSourcePath: null,
  previewReloadKey: 3,
  previewServerTimedOut: false,
  devServerLogs: [],
  isConsoleVisible: true,
  isPreviewServerLoading: false,
  isInstallingDeps: false,
  scaffoldPhase: null,
  scaffoldMessage: '',
})

describe('projectWorkspacePark (F5)', () => {
  beforeEach(() => {
    clearProjectParks('/a')
    clearProjectParks('/b')
  })

  it('parks and restores layout per project path', () => {
    parkLayout('/a', emptyLayout())
    parkLayout('/b', { ...emptyLayout(), viewMode: 'chat', devServer: null })

    const a = takeLayoutPark('/a')
    expect(a?.viewMode).toBe('preview')
    expect(a?.devServer?.pid).toBe(42)

    const b = takeLayoutPark('/b')
    expect(b?.viewMode).toBe('chat')
    expect(b?.devServer).toBeNull()
  })

  it('parks HTTP client independently', () => {
    parkHttpClient('/a', {
      tabs: [{ id: 't1' }],
      activeTabId: 't1',
      history: [],
      isHistoryOpen: true,
    })
    expect(takeHttpPark('/a')?.activeTabId).toBe('t1')
    expect(takeHttpPark('/b')).toBeNull()
  })

  it('clearProjectParks drops both parks', () => {
    parkLayout('/a', emptyLayout())
    parkHttpClient('/a', {
      tabs: [],
      activeTabId: '',
      history: [],
      isHistoryOpen: false,
    })
    clearProjectParks('/a')
    expect(takeLayoutPark('/a')).toBeNull()
    expect(takeHttpPark('/a')).toBeNull()
  })
})
