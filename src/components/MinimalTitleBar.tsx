import { memo, useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react'
import { Box, Flex, Text, HStack, Portal } from '@chakra-ui/react'
import { FiFolder, FiUploadCloud } from 'react-icons/fi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tokens } from '@/theme/tokens'
import { useProjectStore } from '../stores/projectStore'
import { useToastStore } from '../stores/toastStore'
import { useChatStore } from '../stores/chatStore'
import { useBillingStore } from '../stores/billingStore'
import { useByokState } from '../hooks/useByokState'
import { useOverflowCollapse } from '../hooks/useOverflowCollapse'
import { prepareProjectWebExport, sendProjectToTmCodeWeb, type PreparedWebExport } from '../services/webExportService'
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
import { useTranslation, t as translate } from '@/i18n'
import { IS_MAC } from '@/utils/platform'

const IssueReporterDialog = lazy(() => import('./dialogs/IssueReporterDialog'))

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

function buildSendToWebConfirmMessage(template: string, prepared: PreparedWebExport): string {
  const summary = prepared.summary
  const skipped = summary.skippedGenerated +
    summary.skippedHidden +
    summary.skippedSensitive +
    summary.skippedUnsupported
  const base = template
    .replace('{files}', String(summary.fileCount))
    .replace('{size}', formatBytes(summary.totalBytes))
    .replace('{skipped}', String(skipped))

  // Only curated, translated, plain-language notes here — the raw
  // compatibility warnings are developer-facing and stay in the payload.
  const extras: string[] = []
  const compatibility = prepared.payload.compatibility
  if (compatibility.hasDatabase) extras.push(`• ${translate('titlebar.sendToWebDbNote')}`)
  extras.push(`• ${translate('titlebar.sendToWebEnvNote')}`)
  if (summary.assetCount > 0) {
    extras.push(`• ${translate('titlebar.sendToWebAssetsNote').replace('{assets}', String(summary.assetCount))}`)
  }

  return extras.length > 0 ? `${base}\n\n${extras.join('\n')}` : base
}

function MinimalTitleBar() {
  const currentProject = useProjectStore(s => s.currentProject)
  // Collision-based collapse: when the bar's items would overflow (window too
  // narrow), `collapsed` flips and the labels drop to icons — only then, not at
  // a fixed breakpoint. See useOverflowCollapse.
  const barRef = useRef<HTMLDivElement>(null)
  const collapsed = useOverflowCollapse(barRef)
  // Chat session + status controls migrated UP here from the ChatView toolbar,
  // so New Chat / Sessions and the always-visible indicators align with the
  // Project / Branch / Send-to-Web chips in one bar.
  const activeSessionId = useChatStore(s => s.activeSessionId)
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
  const [sendingToWeb, setSendingToWeb] = useState(false)
  // Painel de atividade do "Enviar para Web" — lista de passos com o atual
  // em spinner e os concluídos com ✓.
  const [exportSteps, setExportSteps] = useState<Array<{ label: string; done: boolean }>>([])
  const exportStepsClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleCloseIssueReporter = useCallback(() => setShowIssueReporter(false), [])

  // Listen for issue reporter open event (from native menu, or from the
  // sidebar-footer user menu — the avatar moved there in the 2026-07-13
  // redesign; this dialog stays mounted here as the single global instance).
  useEffect(() => {
    function handleOpen() { setShowIssueReporter(true) }
    window.addEventListener('app:report-issue', handleOpen)
    return () => window.removeEventListener('app:report-issue', handleOpen)
  }, [])

  const t = useTranslation()

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

  // Activity feed do envio — cada passo aparece no painel flutuante enquanto
  // decorre (spinner) e fica com ✓ quando o seguinte começa. Substitui os
  // toasts intermédios: o developer vê a sequência inteira num só sítio.
  function pushExportStep(label: string) {
    setExportSteps(steps => [...steps.map(step => ({ ...step, done: true })), { label, done: false }])
  }
  function finishExportSteps(clearAfterMs: number) {
    setExportSteps(steps => steps.map(step => ({ ...step, done: true })))
    if (exportStepsClearTimer.current) clearTimeout(exportStepsClearTimer.current)
    exportStepsClearTimer.current = setTimeout(() => setExportSteps([]), clearAfterMs)
  }

  async function handleSendToWeb() {
    if (!currentProject || sendingToWeb) return
    setSendingToWeb(true)
    if (exportStepsClearTimer.current) clearTimeout(exportStepsClearTimer.current)
    setExportSteps([{ label: t('titlebar.sendToWebPreparing'), done: false }])
    try {
      const prepared = await prepareProjectWebExport(currentProject)
      // Fail-closed confirmation. window.confirm is NOT safe here: with the
      // Tauri dialog plugin it becomes async, and on an outdated binary the
      // command rejects ("dialog.confirm not allowed") — the old code then
      // treated the pending Promise as truthy and exported WITHOUT any
      // confirmation. Any failure to show the dialog must abort the send.
      let confirmed = false
      try {
        const { confirm: tauriConfirm } = await import('@tauri-apps/plugin-dialog')
        confirmed = await tauriConfirm(
          buildSendToWebConfirmMessage(t('titlebar.sendToWebConfirm'), prepared),
          { title: t('titlebar.sendToWebTitle'), kind: 'info' },
        )
      } catch {
        useToastStore.getState().addToast('error', t('titlebar.sendToWebConfirmFailed'))
        setExportSteps([])
        return
      }
      if (!confirmed) {
        setExportSteps([])
        return
      }

      const result = await sendProjectToTmCodeWeb(currentProject, prepared, progress => {
        if (progress.phase === 'provision-db') {
          pushExportStep(t('titlebar.sendToWebProvisioningDb'))
        } else if (progress.phase === 'db-ready') {
          pushExportStep(t('titlebar.sendToWebDbReady')
            .replace('{reused}', progress.reused ? t('titlebar.sendToWebDbReused') : t('titlebar.sendToWebDbCreated')))
        } else if (progress.phase === 'db-migrated') {
          pushExportStep(t('titlebar.sendToWebDbMigrated'))
        } else if (progress.phase === 'db-data-start') {
          pushExportStep(t('titlebar.sendToWebDbDataCopying'))
        } else if (progress.phase === 'db-data') {
          pushExportStep(progress.rows > 0
            ? t('titlebar.sendToWebDbDataDone').replace('{rows}', String(progress.rows))
            : t('titlebar.sendToWebDbDataNone'))
        } else if (progress.phase === 'db-verified') {
          pushExportStep(t('titlebar.sendToWebDbVerified'))
        } else if (progress.phase === 'db-linked') {
          pushExportStep(t('titlebar.sendToWebDbLinked'))
        } else if (progress.phase === 'uploading') {
          pushExportStep(progress.envVarCount > 0
            ? t('titlebar.sendToWebUploadingWithEnv')
            : t('titlebar.sendToWebUploading'))
        }
      })
      pushExportStep(t('titlebar.sendToWebSent'))
      finishExportSteps(3000)
      useToastStore.getState().addToast('success', t('titlebar.sendToWebSent'))
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(result.webUrl)
    } catch (error) {
      setExportSteps([])
      useToastStore.getState().addToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setSendingToWeb(false)
    }
  }

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
            {/* Sessions + New Chat — migrated up from the chat toolbar so they
                align with the Project / Branch chips. Collapse to icon-only when
                the bar runs out of room. */}
            <Box maxW={collapsed ? undefined : '240px'} minW={0} data-no-drag>
              <SessionDropdown
                projectPath={currentProject.path}
                activeSessionId={activeSessionId}
                isStreaming={isStreaming}
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
            {/* MCP status — after credits, before Send-to-Web. Self-nulls when
                no server is running/errored. */}
            <McpIndicator servers={mcpServers} isInitializing={mcpIsInitializing} />
          </HStack>
        )}

        {/* Send to TM Code Web */}
        {currentProject && (
          <Flex
            as="button"
            align="center"
            justify="center"
            gap="6px"
            px="9px"
            h="26px"
            minW="26px"
            borderRadius="8px"
            cursor={sendingToWeb ? 'progress' : 'pointer'}
            color={sendingToWeb ? tokens.colors.accent.primary : tokens.colors.text.primary}
            bg={sendingToWeb ? 'rgba(254, 16, 99, 0.12)' : 'rgba(254, 16, 99, 0.075)'}
            border={sendingToWeb ? '1px solid rgba(254, 16, 99, 0.35)' : '1px solid rgba(254, 16, 99, 0.24)'}
            boxShadow={sendingToWeb ? '0 0 0 1px rgba(254,16,99,0.06), 0 8px 22px rgba(254,16,99,0.12)' : '0 0 0 1px rgba(254,16,99,0.03)'}
            transition="background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease"
            _hover={{
              bg: 'rgba(254, 16, 99, 0.13)',
              color: tokens.colors.text.inverse,
              borderColor: 'rgba(254, 16, 99, 0.42)',
              boxShadow: '0 10px 26px rgba(254,16,99,0.16), 0 0 0 1px rgba(254,16,99,0.06)',
              transform: sendingToWeb ? 'none' : 'translateY(-1px)',
            }}
            _active={{ transform: 'translateY(0) scale(0.98)' }}
            _focusVisible={{ outline: '2px solid rgba(254, 16, 99, 0.45)', outlineOffset: '2px' }}
            title={t('titlebar.sendToWebTitle')}
            aria-label={t('titlebar.sendToWebTitle')}
            aria-disabled={sendingToWeb}
            opacity={sendingToWeb ? 0.82 : 1}
            onClick={handleSendToWeb}
            css={{
              '@media (max-width: 860px)': {
                '& [data-send-web-label]': { display: 'none' },
              },
              '@keyframes tmSendToWebSpin': {
                to: { transform: 'rotate(360deg)' },
              },
            }}
          >
            <Box
              as="span"
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              color="currentColor"
              css={sendingToWeb ? { animation: 'tmSendToWebSpin 0.9s linear infinite' } : undefined}
            >
              <FiUploadCloud size={14} />
            </Box>
            {!collapsed && (
              <Text data-send-web-label fontSize="11px" fontWeight="700" whiteSpace="nowrap">
                {t('titlebar.sendToWebShort')}
              </Text>
            )}
          </Flex>
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

      {/* Activity Loading do Enviar para Web — cada passo visível enquanto
          decorre; desaparece sozinho depois do envio concluir. */}
      {exportSteps.length > 0 && (
        <Portal>
          <Box
            position="fixed"
            bottom="16px"
            right="16px"
            zIndex={9999}
            minW="300px"
            maxW="380px"
            bg={tokens.colors.dialog.bg}
            border={`1px solid ${tokens.colors.border.panel}`}
            borderRadius="10px"
            boxShadow="0 12px 40px rgba(0,0,0,0.45)"
            px={4}
            py={3}
            css={{ '@keyframes tmExportStepSpin': { to: { transform: 'rotate(360deg)' } } }}
          >
            <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary} mb={2}>
              {t('titlebar.sendToWebShort')}
            </Text>
            <Flex direction="column" gap="6px">
              {exportSteps.map((step, index) => (
                <Flex key={index} align="flex-start" gap={2}>
                  {step.done ? (
                    <Text as="span" fontSize="12px" color={tokens.colors.accent.green} flexShrink={0} lineHeight="16px">✓</Text>
                  ) : (
                    <Box
                      w="10px"
                      h="10px"
                      mt="3px"
                      flexShrink={0}
                      borderRadius="full"
                      border="2px solid transparent"
                      borderTopColor={tokens.colors.accent.primary}
                      borderRightColor={tokens.colors.accent.primary}
                      // will-change promove a animação ao compositor: continua
                      // a rodar mesmo quando o main thread está ocupado (era o
                      // "spinner preso" que parecia um crash).
                      css={{ animation: 'tmExportStepSpin 0.8s linear infinite', willChange: 'transform' }}
                    />
                  )}
                  <Text
                    fontSize="12px"
                    lineHeight="16px"
                    color={step.done ? tokens.colors.text.secondary : tokens.colors.text.primary}
                  >
                    {step.label}
                  </Text>
                </Flex>
              ))}
            </Flex>
          </Box>
        </Portal>
      )}
    </Box>
  )
}

export default memo(MinimalTitleBar)
