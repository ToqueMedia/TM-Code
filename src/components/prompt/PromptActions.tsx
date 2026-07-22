import { memo, useMemo, type MouseEvent, type ReactNode } from 'react'
import { Box, Flex, IconButton, Text } from '@chakra-ui/react'
import { FiSend, FiSquare, FiCode, FiImage, FiClock, FiTerminal, FiServer, FiCornerDownRight, FiLayers, FiFastForward } from 'react-icons/fi'
import { VscDiscard } from 'react-icons/vsc'
import { useBillingStore } from '../../stores/billingStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useChatStore } from '../../stores/chatStore'
import { useByokStore } from '../../stores/byokStore'
import { useCheckpointStore } from '../../stores/checkpointStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import ContextWindowIndicator from '../chat/ContextWindowIndicator'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

interface PromptActionsProps {
  viewMode: string
  isStreaming: boolean
  /** QueryGuard-level busy (covers dispatching + tool turns, not just token
   *  streaming) OU tarefas paralelas vivas — drives the Steer/Task toggle. */
  isAgentBusy: boolean
  /** A sessão visível pertence a uma tarefa paralela em curso — o botão Stop
   *  aparece (posicional) mesmo com o run principal idle. */
  viewedTaskBusy?: boolean
  /** Steer/Task toggle state — what Enter does while the agent is busy. */
  queueAsTask: boolean
  onQueueModeChange: (asTask: boolean) => void
  hasInput: boolean
  onToggleEditor: () => void
  onUndoImprovePrompt: () => void
  onToggleDevServer: () => void
  canToggleDevServer: boolean
  isDevServerActive: boolean
  isDevServerStarting: boolean
  canUndoImprovePrompt: boolean
  onSend: () => void
  onStop: () => void
  onAttach: () => void
  attachmentCount: number
}

function PromptActions({
  viewMode,
  isStreaming,
  isAgentBusy,
  viewedTaskBusy = false,
  queueAsTask,
  onQueueModeChange,
  hasInput,
  onToggleEditor,
  onUndoImprovePrompt,
  onToggleDevServer,
  canToggleDevServer,
  isDevServerActive,
  isDevServerStarting,
  canUndoImprovePrompt,
  onSend,
  onStop,
  onAttach,
  attachmentCount,
}: PromptActionsProps) {
  const billingPlan = useBillingStore(s => s.plan)
  const checkpointCount = useCheckpointStore(s => s.checkpoints.length)
  const isCheckpointDrawerOpen = useLayoutStore(s => s.isCheckpointDrawerOpen)
  const toggleCheckpointDrawer = useLayoutStore(s => s.toggleCheckpointDrawer)
  const autoModePermissions = usePermissionStore(st => st.autoModePermissions)
  const setAutoModePermissions = usePermissionStore(st => st.setAutoModePermissions)
  const setCheckpointDrawerOpen = useLayoutStore(s => s.setCheckpointDrawerOpen)
  const setPlanViewerOpen = useLayoutStore(s => s.setPlanViewerOpen)
  const isTerminalOpen = useTerminalPanelStore(s => s.isOpen)
  const toggleTerminal = useTerminalPanelStore(s => s.toggle)
  const closeTerminal = useTerminalPanelStore(s => s.close)
  // Plan label via i18n — falls back to raw plan name for unknown plans.
  const planLabel = t(`prompt.planLabel.${billingPlan}` as any) || billingPlan

  // ── Paperclip gate ──
  //
  // Decision matrix (whether attach button is shown, and the hint):
  //   BYOK active + provider supports images natively  → show, native
  //   BYOK active + no native vision + paid plan       → show, "via TM Vision"
  //   BYOK active + no native vision + Explorer        → hidden (plan limit)
  //   BYOK inactive + paid plan                        → show, native via Qwen
  //   BYOK inactive + Explorer                         → hidden (plan limit)
  //
  // Source of truth is the active session's BYOK snapshot (if any), with a
  // fallback to the current global byokStore selection for not-yet-snapshotted
  // sessions (e.g. before the first send). This mirrors the agentService logic.
  const activeSession = useChatStore(s => s.activeSessionId ? s.sessions.get(s.activeSessionId) ?? null : null)
  const byokSnapshot = activeSession?.byokSnapshot ?? null

  // Subscribe to PRIMITIVES only — selecting `resolveActive()` directly was
  // returning a fresh object reference each render, which made Zustand's
  // useSyncExternalStore think the snapshot kept changing and re-rendered
  // forever ("getSnapshot should be cached" warning + Maximum update depth).
  // Compute the resolved tuple in a memo so the reference stays stable until
  // any of the contributing fields actually changes.
  const byokEnabled = useByokStore(s => s.enabled)
  const byokActiveProvider = useByokStore(s => s.activeProvider)
  const byokActiveModel = useByokStore(s => s.activeModel)
  const byokProviders = useByokStore(s => s.providers)
  const byokPerProviderConfig = useByokStore(s => s.perProviderConfig)
  const byokResolvedActive = useMemo(() => {
    if (!byokEnabled || !byokActiveProvider || !byokActiveModel) return null
    const provider = byokProviders.find(p => p.id === byokActiveProvider)
    if (!provider) return null
    const userDefined = byokPerProviderConfig[byokActiveProvider]?.userDefinedModel
    const registryModel = provider.models.find(m => m.id === byokActiveModel)
    if (registryModel) return { providerCustom: provider.custom === true, imagesSupported: registryModel.capabilities.images }
    if (userDefined && userDefined.id === byokActiveModel) return { providerCustom: provider.custom === true, imagesSupported: userDefined.capabilities.images }
    if (provider.custom) return { providerCustom: true, imagesSupported: false }
    return null
  }, [byokEnabled, byokActiveProvider, byokActiveModel, byokProviders, byokPerProviderConfig])

  const byokSnapshotImages = useMemo(() => {
    if (!byokSnapshot) return null
    if (byokSnapshot.capabilities?.images !== undefined) return byokSnapshot.capabilities.images
    const provider = byokProviders.find(p => p.id === byokSnapshot.providerId)
    const config = byokPerProviderConfig[byokSnapshot.providerId]
    const registryModel = provider?.models.find(m => m.id === byokSnapshot.modelId)
    if (registryModel) return registryModel.capabilities.images
    const dynamicModel = config?.dynamicCatalog?.models.find(m => m.id === byokSnapshot.modelId)
    if (dynamicModel) return dynamicModel.capabilities.images
    const userDefined = config?.userDefinedModel
    if (userDefined?.id === byokSnapshot.modelId) return userDefined.capabilities.images
    return false
  }, [byokSnapshot, byokProviders, byokPerProviderConfig])

  const byokModelImages = byokSnapshot
    ? byokSnapshotImages
    : (byokResolvedActive?.imagesSupported ?? null)
  const byokInUse = byokSnapshot !== null || byokResolvedActive !== null
  const isExplorer = billingPlan === 'explorer'
  const devServerButtonTitle = isDevServerActive
    ? t('prompt.stopDevServer')
    : isDevServerStarting
      ? t('prompt.startingServer')
      : t('prompt.startDevServer')

  let showAttach = false
  let attachHint: string | null = null
  if (byokInUse) {
    if (byokModelImages === true) {
      showAttach = true
    } else if (!isExplorer) {
      showAttach = true
      attachHint = 'via TM Vision'
    }
  } else {
    showAttach = !isExplorer
  }

  return (
    <Flex
      align="center"
      justify="space-between"
      gap={2}
      px={{ base: 2.5, md: 3 }}
      py={2}
      borderTop="1px solid rgba(255, 255, 255, 0.035)"
      css={{
        // Container query, not viewport: the prompt column gets squeezed by
        // side drawers (team chat, terminal, checkpoints) and by the preview
        // split, none of which change the window width. Measuring this row
        // directly collapses the labels exactly when the row itself runs out
        // of room, regardless of what stole the space.
        containerType: 'inline-size',
        '@container (max-width: 760px)': {
          '& [data-prompt-action-label]': { display: 'none' },
          '& [data-prompt-tool-button]': {
            paddingLeft: '8px',
            paddingRight: '8px',
          },
        },
      }}
    >
      <Flex align="center" gap={1} minW={0} overflow="hidden">
        {/* Plan badge — model is decided by the backend based on the user's plan */}
        <Flex
          align="center"
          px={2.5}
          h="28px"
          borderRadius="8px"
          color={tokens.colors.text.muted}
          bg="rgba(255, 255, 255, 0.025)"
          border="1px solid rgba(255, 255, 255, 0.045)"
          flexShrink={0}
        >
          <Text fontSize="10.5px" fontWeight={700} letterSpacing="0.04em">
            {planLabel}
          </Text>
        </Flex>

        {showAttach && (
          <IconButton
            aria-label={attachHint ? `${t("prompt.attach")} (${attachHint})` : t("prompt.attach")}
            size="sm"
            variant="ghost"
            color={attachmentCount > 0 ? tokens.colors.accent.primary : tokens.colors.text.secondary}
            bg={attachmentCount > 0 ? tokens.colors.accent.primarySubtle : 'transparent'}
            _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
            borderRadius="8px"
            onClick={onAttach}
            title={attachHint || undefined}
          >
            <FiImage size={15} />
          </IconButton>
        )}

        {/* Modo Auto (classificador de permissões) — porte claude-vaz */}
        <PromptToolButton
          icon={<FiFastForward size={14} />}
          label={t('autoMode.title')}
          active={autoModePermissions}
          ariaLabel={t('autoMode.chipTooltip')}
          title={t('autoMode.chipTooltip')}
          onClick={() => setAutoModePermissions(!autoModePermissions)}
        />

        {/* Editor toggle */}
        <PromptToolButton
          icon={<FiCode size={14} />}
          label={t('prompt.sourceCode')}
          active={viewMode === 'editor'}
          ariaLabel={t("prompt.toggleEditor")}
          onClick={onToggleEditor}
        />

        <PromptToolButton
          icon={<FiClock size={14} />}
          label={t('checkpoint.title')}
          active={isCheckpointDrawerOpen}
          ariaLabel={t('checkpoint.title')}
          title={t('checkpoint.title')}
          badge={checkpointCount > 0 ? checkpointCount : undefined}
          onClick={event => {
            event.stopPropagation()
            closeTerminal()
            toggleCheckpointDrawer()
          }}
        />

        <PromptToolButton
          icon={<FiTerminal size={14} />}
          label={t('activity.terminal')}
          active={isTerminalOpen}
          ariaLabel={t('prompt.toggleTerminal')}
          title={t('prompt.toggleTerminal')}
          onClick={event => {
            event.stopPropagation()
            if (!isTerminalOpen) {
              setCheckpointDrawerOpen(false)
              setPlanViewerOpen(false)
            }
            toggleTerminal()
          }}
        />

        <PromptToolButton
          icon={<FiServer size={14} />}
          label={isDevServerActive ? t('prompt.stopDevServer') : t('prompt.startDevServer')}
          active={isDevServerActive || isDevServerStarting}
          disabled={!canToggleDevServer || (isDevServerStarting && !isDevServerActive)}
          ariaLabel={devServerButtonTitle}
          title={devServerButtonTitle}
          onClick={event => {
            event.stopPropagation()
            onToggleDevServer()
          }}
        />

        {canUndoImprovePrompt && (
          <PromptToolButton
            icon={<VscDiscard size={14} />}
            label={t('prompt.undoPromptImprovement')}
            ariaLabel={t('prompt.undoPromptImprovement')}
            title={t('prompt.undoPromptImprovementTitle')}
            onClick={event => {
              event.stopPropagation()
              onUndoImprovePrompt()
            }}
          />
        )}
      </Flex>

      {/* Per-turn context-pressure pill + Send / Stop / Queue button.
          The context indicator lives here (not the header) so it sits on the
          same line as the plan/source-code/checkpoint controls, next to send. */}
      <Flex align="center" gap={2} flexShrink={0}>
        <ContextWindowIndicator popoverPlacement="top" />
        {isAgentBusy && (
          // Steer/Task segmented toggle — what Enter does while a run is
          // live: steer the CURRENT task (parity default) or queue a NEW
          // task that starts when this one finishes. Labels collapse under
          // the same container query as the left-side tool buttons.
          <Flex
            h="28px"
            borderRadius="8px"
            border={`1px solid ${tokens.colors.border.default}`}
            overflow="hidden"
            flexShrink={0}
            role="group"
            aria-label={t('prompt.queueModeToggle')}
          >
            <QueueModeButton
              icon={<FiCornerDownRight size={12} />}
              label={t('prompt.steerMode')}
              title={t('prompt.steerModeHint')}
              active={!queueAsTask}
              activeColor={tokens.colors.accent.primary}
              activeBg={tokens.colors.accent.primarySubtle}
              onClick={() => onQueueModeChange(false)}
            />
            <QueueModeButton
              icon={<FiLayers size={12} />}
              label={t('prompt.taskMode')}
              title={t('prompt.taskModeHint')}
              active={queueAsTask}
              activeColor={tokens.colors.accent.purple}
              activeBg={tokens.colors.accent.purpleSubtle}
              onClick={() => onQueueModeChange(true)}
            />
          </Flex>
        )}
        {(isStreaming || viewedTaskBusy) && hasInput ? (
          // Run desta vista em curso + user escreveu → ENVIAR ganha ao Stop
          // (main: fila/steer; tarefa em foco: steer da tarefa). Sem o
          // viewedTaskBusy aqui, escrever um steer para uma tarefa mostrava
          // o botão Stop no lugar do Enviar (H38, ronda crítica 2026-07-16).
          <IconButton
            aria-label={t("prompt.sendToQueue")}
            size="sm"
            bg={tokens.colors.accent.primary}
            color={tokens.colors.text.inverse}
            borderRadius="8px"
            _hover={{ bg: tokens.colors.accent.primaryDark }}
            onClick={onSend}
          >
            <FiSend size={14} />
          </IconButton>
        ) : (isStreaming || viewedTaskBusy) ? (
          // Run desta vista em curso (main OU tarefa) + sem input → Stop
          // posicional (usePromptBar.handleStop decide o alvo).
          <IconButton
            aria-label={t("prompt.stopGeneration")}
            size="sm"
            bg={tokens.colors.accent.redSubtle}
            color={tokens.colors.accent.red}
            borderRadius="8px"
            _hover={{ bg: tokens.colors.accent.redMuted }}
            onClick={onStop}
          >
            <FiSquare size={14} />
          </IconButton>
        ) : (
          // Agent idle → normal send
          <IconButton
            aria-label={t("prompt.send")}
            size="sm"
            bg={hasInput ? tokens.colors.accent.primary : 'transparent'}
            color={hasInput ? tokens.colors.text.inverse : tokens.colors.text.disabled}
            borderRadius="8px"
            boxShadow={hasInput ? `0 0 0 1px ${tokens.colors.accent.primaryMuted}` : undefined}
            _hover={hasInput ? { bg: tokens.colors.accent.primaryDark, transform: 'translateY(-1px)' } : {}}
            onClick={onSend}
            disabled={!hasInput}
          >
            <FiSend size={14} />
          </IconButton>
        )}
      </Flex>
    </Flex>
  )
}

function QueueModeButton({
  icon,
  label,
  title,
  active,
  activeColor,
  activeBg,
  onClick,
}: {
  icon: ReactNode
  label: string
  title: string
  active: boolean
  activeColor: string
  activeBg: string
  onClick: () => void
}) {
  return (
    <Box
      as="button"
      data-prompt-tool-button
      display="flex"
      alignItems="center"
      gap="4px"
      h="100%"
      px="8px"
      cursor="pointer"
      color={active ? activeColor : tokens.colors.text.disabled}
      bg={active ? activeBg : 'transparent'}
      transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}`}
      _hover={{ color: active ? activeColor : tokens.colors.text.secondary }}
      onClick={event => {
        event.stopPropagation()
        onClick()
      }}
      aria-pressed={active}
      aria-label={label}
      title={title}
    >
      <Box display="flex" alignItems="center" flexShrink={0}>
        {icon}
      </Box>
      <Text data-prompt-action-label fontSize="10.5px" fontWeight="700" whiteSpace="nowrap">
        {label}
      </Text>
    </Box>
  )
}

function PromptToolButton({
  icon,
  label,
  active,
  badge,
  disabled,
  loading,
  ariaLabel,
  title,
  onClick,
}: {
  icon: ReactNode
  label: string
  active?: boolean
  badge?: number
  disabled?: boolean
  loading?: boolean
  ariaLabel: string
  title?: string
  onClick: (event: MouseEvent) => void
}) {
  return (
    <Box
      as="button"
      data-prompt-tool-button
      display="flex"
      alignItems="center"
      gap="5px"
      h="28px"
      px="8px"
      borderRadius="8px"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.45 : 1}
      color={active ? tokens.colors.accent.primary : tokens.colors.text.secondary}
      bg={active ? tokens.colors.accent.primarySubtle : 'transparent'}
      border={`1px solid ${active ? tokens.colors.accent.primaryMuted : 'transparent'}`}
      transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}, border-color ${tokens.transition.fast}, transform ${tokens.transition.fast}`}
      css={loading ? {
        '@keyframes promptToolSpin': {
          to: { transform: 'rotate(360deg)' },
        },
        '& [data-prompt-tool-icon]': {
          animation: 'promptToolSpin 0.85s linear infinite',
        },
      } : undefined}
      _hover={{
        bg: disabled ? (active ? tokens.colors.accent.primarySubtle : 'transparent') : active ? tokens.colors.accent.primarySubtle : tokens.colors.bg.whiteSubtle,
        color: disabled ? (active ? tokens.colors.accent.primary : tokens.colors.text.secondary) : active ? tokens.colors.accent.primary : tokens.colors.text.primary,
        transform: disabled ? 'none' : 'translateY(-1px)',
      }}
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      flexShrink={0}
    >
      <Box data-prompt-tool-icon display="flex" alignItems="center" justifyContent="center" flexShrink={0}>
        {icon}
      </Box>
      <Text data-prompt-action-label fontSize="11px" fontWeight="600" whiteSpace="nowrap">
        {label}
      </Text>
      {badge !== undefined && (
        <Text
          fontSize="9px"
          fontFamily={tokens.fontFamily.mono}
          color={active ? tokens.colors.accent.primary : tokens.colors.text.disabled}
          lineHeight="1"
        >
          {badge}
        </Text>
      )}
    </Box>
  )
}

export default memo(PromptActions)
