import { memo, useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react'
import { Box, Flex, Text, HStack } from '@chakra-ui/react'
import { FiFolder } from 'react-icons/fi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tokens } from '@/theme/tokens'
import { useProjectStore } from '../stores/projectStore'
import { useChatStore } from '../stores/chatStore'
import { useBillingStore } from '../stores/billingStore'
import { useByokState } from '../hooks/useByokState'
import { useOverflowCollapse } from '../hooks/useOverflowCollapse'
import WindowControls from './ui/WindowControls'
import MenuBar from './ui/titlebar/MenuBar'
import BranchMenu from './ui/BranchMenu'
import SessionDropdown from './views/SessionDropdown'
// TmSpeedIndicator: /speed retirado 2026-07-16 — reimportar ao reativar.
// import TmSpeedIndicator from './chat/TmSpeedIndicator'
import AttentionInbox from './ui/AttentionInbox'
import ModelIndicator from './chat/ModelIndicator'
import { CreditIndicator } from './ui/CreditIndicator'
import { McpIndicator } from './ui/StatusIndicators'
import { useMcpStore } from '../stores/mcpStore'
import { BrowserMissingDialog } from './dialogs/BrowserMissingDialog'
import { IS_MAC } from '@/utils/platform'

const IssueReporterDialog = lazy(() => import('./dialogs/IssueReporterDialog'))

function MinimalTitleBar() {
  const currentProject = useProjectStore(s => s.currentProject)
  // Collision-based collapse: when the bar's items would overflow (window too
  // narrow), `collapsed` flips and the labels drop to icons — only then, not at
  // a fixed breakpoint. See useOverflowCollapse.
  const barRef = useRef<HTMLDivElement>(null)
  const collapsed = useOverflowCollapse(barRef)
  // Chat status controls migrated UP here from the ChatView toolbar, so New
  // Chat and the always-visible indicators align with the Project / Branch
  // chips in one bar.
  const isStreaming = useChatStore(s => s.isStreaming)
  const { byokInPlay: showModelIndicator } = useByokState()
  const billingPlan = useBillingStore(s => s.plan)
  const noCredits = useBillingStore(s => s.noCredits)
  const consumedPct = useBillingStore(s => s.consumedPct)
  const tokensConsumed = useBillingStore(s => s.tokensConsumed)
  const tokenBudget = useBillingStore(s => s.tokenBudget)
  const cycleEnd = useBillingStore(s => s.cycleEnd)
  const billingStatus = useBillingStore(s => s.status)
  const tmsRemaining = useBillingStore(s => s.tmsRemaining)
  const mcpServers = useMcpStore(s => s.servers)
  const mcpIsInitializing = useMcpStore(s => s.isInitializing)
  const [showIssueReporter, setShowIssueReporter] = useState(false)
  const handleCloseIssueReporter = useCallback(() => setShowIssueReporter(false), [])

  // Listen for issue reporter open event (from native menu, or from the
  // sidebar-footer user menu — the avatar moved there in the 2026-07-13
  // redesign; this dialog stays mounted here as the single global instance).
  useEffect(() => {
    function handleOpen() { setShowIssueReporter(true) }
    window.addEventListener('app:report-issue', handleOpen)
    return () => window.removeEventListener('app:report-issue', handleOpen)
  }, [])

  async function handleClose() {
    try { await getCurrentWindow().close() } catch (e) { console.error('Window close failed:', e) }
  }

  async function handleMinimize() {
    try { await getCurrentWindow().minimize() } catch (e) { console.error('Window minimize failed:', e) }
  }

  async function handleFullToggle() {
    try {
      const win = getCurrentWindow()
      const plat = navigator.platform || ''
      if (/Mac/.test(plat)) {
        const fs = await win.isFullscreen()
        await win.setFullscreen(!fs)
      } else {
        const isMax = await win.isMaximized()
        if (isMax) await win.unmaximize()
        else await win.maximize()
      }
    } catch (e) { console.error('Window toggle failed:', e) }
  }

  const handleDoubleClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    const tag = t.tagName?.toLowerCase() || ''
    if (['button', 'input', 'svg', 'path'].includes(tag)) return
    if (t.getAttribute?.('role') === 'button') return
    if (t.closest?.('[data-no-drag]')) return
    try {
      const win = getCurrentWindow()
      const isMax = await win.isMaximized()
      if (isMax) await win.unmaximize()
      else await win.maximize()
    } catch (err) { console.error('Window toggle failed:', err) }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    const tag = t.tagName?.toLowerCase() || ''
    if (['button', 'input', 'svg', 'path'].includes(tag)) return
    if (t.getAttribute?.('role') === 'button') return
    // Respect our drag opt-out. Avoid data-tauri-drag-region="false":
    // on Windows the native drag handler keys off attribute presence.
    // should NOT start a window drag — otherwise the click gets eaten by
    // startDragging() on Windows and onClick never fires.
    if (t.closest?.('[data-no-drag]')) return
    getCurrentWindow().startDragging().catch(() => {})
  }, [])

  return (
    <Box
      ref={barRef}
      height="40px"
      // Header LISO (redesign 2026-07-13): mesma cor do fundo da app, sem
      // borda nem translucidez — deixa de ler como "uma barra" e funde-se
      // com o conteúdo, como na referência. A área continua a ser a drag
      // region da janela frameless.
      bg="#0a0a0a"
      display="flex"
      alignItems="center"
      px={2}
      position="relative"
      userSelect="none"
      flexShrink={0}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    >
      {/* Left: Window controls (macOS) + menus */}
      <HStack gap={2} flexShrink={0} pl={1} data-no-drag>
        {IS_MAC && (
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        )}
        <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary} whiteSpace="nowrap">
          TM Code
        </Text>
        <MenuBar />
        {currentProject && (
          <HStack gap={1.5} ml={1} data-no-drag>
            {/* Chip do projecto — par do chip de branch, como na referência */}
            <Flex
              align="center"
              gap="6px"
              h="26px"
              px="9px"
              borderRadius="8px"
              bg="rgba(255, 255, 255, 0.05)"
              border={`1px solid ${tokens.colors.border.default}`}
              color={tokens.colors.text.secondary}
              maxW="200px"
              title={currentProject.path}
            >
              <FiFolder size={12} />
              {!collapsed && (
                <Text fontSize="12px" fontWeight="600" lineClamp={1}>
                  {currentProject.name}
                </Text>
              )}
            </Flex>
            {/* Trocar/criar branch a partir do chat */}
            <BranchMenu projectPath={currentProject.path} />
            {/* New Chat — the sessions LIST lives in the Projects sidebar now
                (WelcomeSidebar nests each project's sessions under its folder);
                only chat creation stayed in the titlebar. Collapses to
                icon-only when the bar runs out of room. */}
            <Box maxW={collapsed ? undefined : '240px'} minW={0} data-no-drag>
              <SessionDropdown
                projectPath={currentProject.path}
                compact={collapsed}
              />
            </Box>
          </HStack>
        )}
      </HStack>

      {/* Center spacer */}
      <Flex flex={1} />

      {/* Right: status indicators + project actions. */}
      <HStack gap={2} flexShrink={0} pr={1} data-no-drag>
        {/* Always-visible indicators — TM Speed / model (BYOK) / credits —
            migrated up from the chat toolbar. Each self-nulls when N/A. Credits
            and model are mutually exclusive (byokInPlay swaps them). */}
        {currentProject && (
          <HStack gap={1.5} flexShrink={0}>
            {/* Inbox de atenção (Fase 6a) — só aparece quando há itens. */}
            <AttentionInbox />
            {/* TmSpeedIndicator desmontado — /speed retirado 2026-07-16
                (código morto p/ futuro; ver slashCommandRegistry). */}
            <ModelIndicator />
            {!showModelIndicator && (
              <CreditIndicator
                plan={billingPlan}
                noCredits={noCredits}
                isStreaming={isStreaming}
                consumedPct={consumedPct}
                tokensConsumed={tokensConsumed}
                tokenBudget={tokenBudget}
                cycleEnd={cycleEnd}
                status={billingStatus}
                tmsRemaining={tmsRemaining}
              />
            )}
            {/* MCP status — self-nulls when no server is running/errored. */}
            <McpIndicator servers={mcpServers} isInitializing={mcpIsInitializing} />
          </HStack>
        )}

        {/* Avatar/menu de utilizador: migrou para o rodapé da sidebar
            (redesign 2026-07-13, paridade com a referência). */}
      </HStack>

      {/* Right: window controls (Windows/Linux) */}
      {!IS_MAC && (
        <HStack flexShrink={0} data-no-drag>
          <WindowControls
            onClose={handleClose}
            onMinimize={handleMinimize}
            onMaximize={handleFullToggle}
          />
        </HStack>
      )}

      {/* Issue Reporter Dialog */}
      <Suspense fallback={null}>
        <IssueReporterDialog
          isOpen={showIssueReporter}
          onClose={handleCloseIssueReporter}
        />
      </Suspense>

      {/* E2E: dialog mounted globally so any tool execution path can prompt
          the user, even from views where the preview is not yet visible. */}
      <BrowserMissingDialog />
    </Box>
  )
}

export default memo(MinimalTitleBar)
