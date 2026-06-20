import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box, Button, Dialog, Flex, Input, Portal, Text } from '@chakra-ui/react'
import {
  FiCheckCircle,
  FiCopy,
  FiExternalLink,
  FiGlobe,
  FiLoader,
  FiX,
} from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useProjectStore } from '../../stores/projectStore'
import { useDeployStore, type DeployRecord } from '../../stores/deployStore'
import { useBillingStore } from '../../stores/billingStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { deployService, type DeploysSummaryResponse } from '../../services/deployService'
import { detectFromProjectPath } from '../../services/deploy/runtimeDetector'
import { t } from '@/i18n'

type Phase = 'upgrade' | 'over-quota' | 'configure' | 'publishing' | 'success' | 'error'

function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`))
}

interface PublishModalProps {
  isOpen: boolean
  onClose: () => void
}

function slugSuggest(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

function PublishModal({ isOpen, onClose }: PublishModalProps) {
  const project = useProjectStore((s) => s.currentProject)
  const userPlan = useBillingStore((s) => s.plan)
  const billingLoaded = useBillingStore((s) => s.isLoaded)

  const record = useDeployStore((s) =>
    project ? s.records.get(project.id) ?? null : null,
  )

  const isFreeTier = billingLoaded && (!userPlan || userPlan === 'explorer')

  const [subdomain, setSubdomain] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [detectWarnings, setDetectWarnings] = useState<string[]>([])
  const [summary, setSummary] = useState<DeploysSummaryResponse | null>(null)

  /** True when the user is updating a project that's already live —
   *  controls the Publish ↔ Update label across the modal. */
  const isUpdate = summary?.isReDeploy === true

  const phase: Phase = useMemo(() => {
    // Plan gating: free tier can't deploy. Show upgrade CTA up-front.
    if (!record && isFreeTier) return 'upgrade'
    // Server-authoritative quota gate. Re-deploys never trip this branch
    // because isReDeploy excludes the current projectId from the count.
    if (!record && summary?.overQuota) return 'over-quota'
    if (!record) return 'configure'
    if (record.phase === 'in_progress') return 'publishing'
    if (record.phase === 'success') return 'success'
    if (record.phase === 'error') return 'error'
    return 'configure'
  }, [record, isFreeTier, summary?.overQuota])

  // Seed subdomain when modal opens. Prefer existingSlug from summary when
  // this is a re-deploy so the user doesn't accidentally type a new slug.
  // Use a ref to avoid overwriting user edits — once the user changes the
  // input we stop auto-seeding.
  const userEditedRef = useRef(false)
  useEffect(() => {
    if (isOpen && project) {
      const seed = summary?.existingSlug ?? slugSuggest(project.name)
      if (!userEditedRef.current) {
        setSubdomain(seed)
      }
    }
    if (!isOpen) {
      setSubmitting(false)
      userEditedRef.current = false
    }
  }, [isOpen, project, summary?.existingSlug])

  // Detector warnings (hidden backend etc.) + quota summary in parallel.
  // Both fire once per modal-open + project pair. Free tier skips both
  // since the upgrade phase already short-circuits the UI.
  useEffect(() => {
    if (!isOpen || !project || isFreeTier) {
      setDetectWarnings([])
      setSummary(null)
      return
    }
    let cancelled = false
    detectFromProjectPath(project.path)
      .then((r) => { if (!cancelled) setDetectWarnings(r.warnings) })
      .catch(() => { if (!cancelled) setDetectWarnings([]) })
    deployService
      .getDeploysSummary(project.id)
      .then((r) => { if (!cancelled) setSummary(r) })
      .catch(() => { if (!cancelled) setSummary(null) })
    return () => { cancelled = true }
  }, [isOpen, project, isFreeTier])

  // Mask the native preview webview while the modal is open. Without this,
  // the wry child webview sits above CSS z-index on Windows/Linux and the
  // modal renders invisibly behind the preview. Mirrors MenuBar's pattern.
  useEffect(() => {
    if (!isOpen) return
    useLayoutStore.getState().pushOverlay()
    return () => {
      useLayoutStore.getState().popOverlay()
    }
  }, [isOpen])

  const handlePublish = useCallback(async () => {
    if (!project || submitting) return
    setSubmitting(true)
    try {
      await deployService.deploy(project.path, {
        projectId: project.id,
        projectName: project.name,
        customSubdomain: subdomain.replace(/^-+|-+$/g, '') || undefined,
        userPlan,
      })
    } catch {
      // store already records the failure; UI will pivot to error phase
    } finally {
      setSubmitting(false)
    }
  }, [project, submitting, subdomain, userPlan])

  // `shakeNonce` increments each time the user tries to close mid-deploy
  // (ESC, backdrop click, or — historically — the X button). The header
  // listens for changes and runs a brief shake animation so the user gets
  // visible feedback that the attempt registered AND was rejected, instead
  // of "I pressed ESC and nothing happened".
  const [shakeNonce, setShakeNonce] = useState(0)

  const handleClose = useCallback(() => {
    if (phase === 'publishing') {
      setShakeNonce((n) => n + 1)
      return // can't close mid-deploy
    }
    // Closing from a terminal phase (success / error) must clear the
    // store record. Without this, reopening the modal jumps straight back
    // to SuccessStep / ErrorStep with stale data — the user sees yesterday's
    // serviceUrl when they meant to start a fresh deploy. Re-fetching the
    // summary on next open also gets the updated lastDeployedAt + slug.
    if (project && (phase === 'success' || phase === 'error')) {
      useDeployStore.getState().clear(project.id)
      setSubmitting(false)
      setSummary(null)
      setSubdomain('')
    }
    onClose()
  }, [phase, project, onClose])

  if (!project) return null

  return (
    <Dialog.Root open={isOpen} onOpenChange={(e) => !e.open && handleClose()}>
      <Portal>
        {/* Backdrop: full viewport cover. Inline style takes precedence over
            any Chakra defaults from data-attribute stylesheets, which is what
            broke fixed positioning here previously. */}
        <Dialog.Backdrop
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1399,
            backgroundColor: tokens.colors.dialog.backdrop,
          }}
        />
        {/* Positioner: full viewport, centers Content via flex. pointer-events
            is none on the wrapper so click-through to backdrop still closes;
            Content overrides back to auto. */}
        <Dialog.Positioner
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1400,
            pointerEvents: 'none',
          }}
        >
          <Dialog.Content
            bg={tokens.colors.dialog.bg}
            color={tokens.colors.text.primary}
            border={`1px solid ${tokens.colors.dialog.border}`}
            maxW="540px"
            borderRadius="14px"
            boxShadow="0 20px 60px -20px rgba(0,0,0,0.6)"
            overflow="hidden"
            style={{ pointerEvents: 'auto' }}
          >
            <Header
              phase={phase}
              isUpdate={isUpdate}
              onClose={handleClose}
              shakeNonce={shakeNonce}
            />

            <Box px={6} py={5}>
              {summary?.scope === 'team' && phase !== 'upgrade' && (
                <Box
                  mb={3}
                  px={2.5}
                  py={1.5}
                  borderRadius="6px"
                  bg="rgba(163, 113, 247, 0.12)"
                  border="1px solid rgba(163, 113, 247, 0.3)"
                >
                  <Text fontSize="11px" color="#a78bfa">
                    {t('publish.teamHosting')}
                  </Text>
                </Box>
              )}
              {phase === 'upgrade' && <UpgradeStep onClose={handleClose} />}
              {phase === 'over-quota' && summary && (
                <OverQuotaStep summary={summary} onClose={handleClose} />
              )}
              {phase === 'configure' && (
                <ConfigureStep
                  subdomain={subdomain}
                  onSubdomainChange={(v) => { userEditedRef.current = true; setSubdomain(v) }}
                  onPublish={handlePublish}
                  onCancel={handleClose}
                  submitting={submitting}
                  warnings={detectWarnings}
                  isUpdate={isUpdate}
                  summary={summary}
                  customDomain={summary?.customDomain ?? undefined}
                />
              )}
              {phase === 'publishing' && record && (
                <PublishingStep record={record} isUpdate={isUpdate} />
              )}
              {phase === 'success' && record && summary && (
                <SuccessStep record={record} isUpdate={isUpdate} onClose={handleClose} customDomain={summary.customDomain} />
              )}
              {phase === 'error' && record && (
                <ErrorStep record={record} onRetry={handlePublish} onClose={handleClose} />
              )}
            </Box>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}

function Header({
  phase,
  isUpdate,
  onClose,
  shakeNonce,
}: {
  phase: Phase
  isUpdate: boolean
  onClose: () => void
  shakeNonce: number
}) {
  // Trigger a brief shake + "can't close yet" hint whenever the parent
  // bumps `shakeNonce` (ESC / backdrop attempt during publish). Cleared on
  // animation end so the next attempt re-fires.
  const [isShaking, setIsShaking] = useState(false)
  useEffect(() => {
    if (shakeNonce === 0) return
    setIsShaking(true)
    const t = window.setTimeout(() => setIsShaking(false), 600)
    return () => window.clearTimeout(t)
  }, [shakeNonce])

  const title = phase === 'success'
    ? t(isUpdate ? 'publish.headerTitleUpdateSuccess' : 'publish.headerTitleSuccess')
    : phase === 'upgrade'
      ? t('publish.headerTitleUpgrade')
      : t(isUpdate ? 'publish.headerTitleUpdate' : 'publish.headerTitle')

  const defaultSubtitle = isUpdate
    ? t('publish.headerSubtitleUpdate')
    : t('publish.headerSubtitle')
  // During shake, swap the subtitle for the "can't close yet" hint AND tint
  // the text accent-red — same line, no layout shift. After the shake finishes
  // (600ms) we return to the default subtitle.
  const subtitle = isShaking
    ? t('publish.cantCloseWhilePublishing')
    : defaultSubtitle

  return (
    <Flex
      align="center"
      justify="space-between"
      px={6}
      py={4}
      borderBottom={`1px solid ${tokens.colors.border.default}`}
      bg="rgba(255, 255, 255, 0.02)"
      animation={isShaking ? 'tm-publish-shake 600ms cubic-bezier(.36,.07,.19,.97)' : undefined}
      css={{
        '@keyframes tm-publish-shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '10%, 30%, 50%, 70%, 90%': { transform: 'translateX(-4px)' },
          '20%, 40%, 60%, 80%': { transform: 'translateX(4px)' },
        },
      }}
    >
      <Flex align="center" gap={2}>
        <Flex
          w="28px"
          h="28px"
          borderRadius="8px"
          bg={tokens.colors.accent.primarySubtle}
          align="center"
          justify="center"
          color={tokens.colors.accent.primary}
        >
          <FiGlobe size={14} />
        </Flex>
        <Box>
          <Text fontSize="14px" fontWeight="600" color={tokens.colors.text.primary} lineHeight="1.2">
            {title}
          </Text>
          <Text
            fontSize="11.5px"
            color={isShaking ? tokens.colors.accent.red : tokens.colors.text.muted}
            lineHeight="1.2"
            mt="2px"
            transition="color 200ms ease"
          >
            {subtitle}
          </Text>
        </Box>
      </Flex>
      {phase !== 'publishing' && (
        <Box
          as="button"
          w="28px"
          h="28px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          bg="transparent"
          border="none"
          borderRadius="6px"
          cursor="pointer"
          color={tokens.colors.text.muted}
          _hover={{ bg: 'rgba(255,255,255,0.05)', color: tokens.colors.text.primary }}
          onClick={onClose}
          aria-label="Close"
        >
          <FiX size={14} />
        </Box>
      )}
    </Flex>
  )
}

function OverQuotaStep({
  summary,
  onClose,
}: {
  summary: DeploysSummaryResponse
  onClose: () => void
}) {
  return (
    <Box>
      <Box
        p={4}
        borderRadius="10px"
        bg={tokens.colors.accent.redSubtle}
        border={`1px solid ${tokens.colors.accent.redMuted}`}
        mb={4}
      >
        <Text fontSize="13px" color={tokens.colors.text.primary} fontWeight="600" mb={1.5}>
          {t('publish.overQuota.title')}
        </Text>
        <Text fontSize="12px" color={tokens.colors.text.secondary} lineHeight="1.55">
          {fmt(t('publish.overQuota.message'), {
            used: summary.activeCount,
            quota: summary.quota,
            plan: summary.plan,
          })}
        </Text>
      </Box>
      <Flex justify="flex-end" gap={2}>
        <Button
          size="sm"
          variant="ghost"
          color={tokens.colors.text.secondary}
          onClick={onClose}
        >
          {t('publish.error.close')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            // Close the publish modal and switch to the settings view so the
            // user lands on the Deploys section (top of the settings panel).
            useLayoutStore.getState().setViewMode('settings')
            onClose()
          }}
          bg={`linear-gradient(135deg, ${tokens.colors.accent.primary} 0%, ${tokens.colors.accent.primaryDark} 100%)`}
          color="#fff"
          fontWeight="600"
        >
          {t('publish.overQuota.openDeploys')}
        </Button>
      </Flex>
    </Box>
  )
}

function UpgradeStep({ onClose }: { onClose: () => void }) {
  return (
    <Box>
      <Box
        p={4}
        borderRadius="10px"
        bg={tokens.colors.accent.primarySubtle}
        border={`1px solid ${tokens.colors.accent.primary}30`}
        mb={4}
      >
        <Text fontSize="13px" color={tokens.colors.text.primary} fontWeight="600" mb={1.5}>
          Publishing is a paid feature
        </Text>
        <Text fontSize="12px" color={tokens.colors.text.secondary} lineHeight="1.55">
          {t('publish.explorerPlanNote')}
        </Text>
      </Box>
      <Text fontSize="11.5px" color={tokens.colors.text.muted} lineHeight="1.55" mb={4}>
        {t('publish.upgradeHint')}
      </Text>
      <Flex justify="flex-end" gap={2}>
        <Button
          size="sm"
          variant="ghost"
          color={tokens.colors.text.secondary}
          onClick={onClose}
        >
          {t('misc.close')}
        </Button>
      </Flex>
    </Box>
  )
}

function ConfigureStep({
  subdomain,
  onSubdomainChange,
  onPublish,
  onCancel,
  submitting,
  warnings,
  isUpdate,
  summary,
  customDomain,
}: {
  subdomain: string
  onSubdomainChange: (v: string) => void
  onPublish: () => void
  onCancel: () => void
  submitting: boolean
  warnings: string[]
  isUpdate: boolean
  summary: DeploysSummaryResponse | null
  customDomain?: string
}) {
  const isValid = subdomain.trim().length > 0
  const counterLine = summary
    ? isUpdate
      ? t('publish.counterRedeploy')
      : fmt(t('publish.counter'), { used: summary.activeCount, quota: summary.quota })
    : null

  // Update mode is a different UX from "create new publish": the slug is
  // fixed (changing it would orphan the live URL), the quota line is just
  // an info note, and the only knob is the "send build" button. We branch
  // here instead of layering conditionals around shared widgets — the two
  // cases share so little markup that one path each reads better.
  if (isUpdate) {
    return (
      <UpdateConfigureBody
        warnings={warnings}
        existingSlug={summary?.existingSlug ?? subdomain}
        customDomain={customDomain}
        counterLine={counterLine}
        submitting={submitting}
        onPublish={onPublish}
        onCancel={onCancel}
      />
    )
  }

  return (
    <Box>
      {warnings.length > 0 && (
        <Box
          p={3}
          mb={4}
          borderRadius="8px"
          bg="rgba(247, 127, 0, 0.06)"
          border={`1px solid rgba(247, 127, 0, 0.25)`}
        >
          {warnings.map((w, i) => (
            <Text key={i} fontSize="12px" color={tokens.colors.accent.orange} lineHeight="1.5">
              ⚠ {w}
            </Text>
          ))}
        </Box>
      )}
      <Text fontSize="12.5px" color={tokens.colors.text.secondary} mb={4} lineHeight="1.5">
        Give your project a public address. You can change it on the next deploy.
      </Text>
      {counterLine && (
        <Box mb={4}>
          <Text
            fontSize="11px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.mono}
            mb={summary && !isUpdate ? 1.5 : 0}
          >
            {counterLine}
          </Text>
          {summary && !isUpdate && summary.quota > 0 && (
            <Box
              h="3px"
              bg="rgba(255, 255, 255, 0.06)"
              borderRadius="999px"
              overflow="hidden"
            >
              <Box
                h="100%"
                w={`${Math.min(100, (summary.activeCount / summary.quota) * 100)}%`}
                bg={
                  summary.activeCount >= summary.quota
                    ? tokens.colors.accent.red
                    : summary.activeCount / summary.quota >= 0.66
                      ? tokens.colors.accent.orange
                      : tokens.colors.accent.primary
                }
                transition="width .25s ease"
              />
            </Box>
          )}
        </Box>
      )}

      <Box mb={5}>
        <Text
          fontSize="11px"
          color={tokens.colors.text.secondary}
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="0.04em"
          mb="6px"
        >
          Subdomain
        </Text>
        <Flex
          align="stretch"
          border="1px solid rgba(255, 255, 255, 0.08)"
          borderRadius="8px"
          overflow="hidden"
          bg="rgba(0, 0, 0, 0.3)"
          _focusWithin={{
            borderColor: tokens.colors.accent.primary,
            boxShadow: `0 0 0 1px ${tokens.colors.accent.primary}`,
          }}
        >
          <Input
            value={subdomain}
            onChange={(e) => onSubdomainChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            onBlur={() => onSubdomainChange(subdomain.replace(/^-+|-+$/g, ''))}
            placeholder="my-project"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            bg="transparent"
            border="none"
            color={tokens.colors.text.primary}
            _placeholder={{ color: tokens.colors.text.muted }}
            _focus={{ outline: 'none', boxShadow: 'none' }}
            fontSize="13px"
            h="40px"
            pl={3}
            fontFamily="mono"
          />
          <Flex
            align="center"
            px={3}
            bg="rgba(255, 255, 255, 0.04)"
            borderLeft="1px solid rgba(255, 255, 255, 0.06)"
          >
            <Text fontSize="13px" color={tokens.colors.text.muted} fontFamily="mono">
              .toquemedia.net
            </Text>
          </Flex>
        </Flex>
        <Text fontSize="11px" color={tokens.colors.text.muted} mt="6px">
          {t('deploys.lettersNumbersHyphens')}
        </Text>
      </Box>

      <Flex gap={2} justify="flex-end" mt={6}>
        <Button
          onClick={onCancel}
          variant="ghost"
          color={tokens.colors.text.secondary}
          fontSize="12.5px"
          h="36px"
          px={4}
          _hover={{ bg: 'rgba(255,255,255,0.04)', color: tokens.colors.text.primary }}
        >
          {t('publish.cancel')}
        </Button>
        <Button
          onClick={onPublish}
          loading={submitting}
          loadingText={isUpdate ? t('publish.updating') : t('publish.publishing')}
          disabled={!isValid}
          h="36px"
          px={4}
          fontSize="12.5px"
          fontWeight="600"
          bg={`linear-gradient(135deg, ${tokens.colors.accent.primary} 0%, ${tokens.colors.accent.primaryDark} 100%)`}
          color="#fff"
          _hover={{ boxShadow: `0 4px 16px -4px ${tokens.colors.accent.primaryGlow}` }}
        >
          {isUpdate ? t('publish.update') : t('publish.button')}
        </Button>
      </Flex>
    </Box>
  )
}

/** Update-mode body — slug is fixed, copy is "send a fresh build", and the
 *  primary action is a single Update button. The fresh-publish counterpart
 *  in `ConfigureStep` handles slug entry + quota bar; mixing the two paths
 *  inside one component meant the slug Input was always rendered (visible
 *  and editable) on update, which would orphan the live URL if the user
 *  changed it. */
function UpdateConfigureBody({
  warnings,
  existingSlug,
  customDomain,
  counterLine,
  submitting,
  onPublish,
  onCancel,
}: {
  warnings: string[]
  existingSlug: string
  customDomain?: string
  counterLine: string | null
  submitting: boolean
  onPublish: () => void
  onCancel: () => void
}) {
  const liveUrl = customDomain
    ? `https://${customDomain}`
    : `https://${existingSlug}.toquemedia.net`
  return (
    <Box>
      {warnings.length > 0 && (
        <Box
          p={3}
          mb={4}
          borderRadius="8px"
          bg="rgba(247, 127, 0, 0.06)"
          border="1px solid rgba(247, 127, 0, 0.25)"
        >
          {warnings.map((w, i) => (
            <Text key={i} fontSize="12px" color={tokens.colors.accent.orange} lineHeight="1.5">
              ⚠ {w}
            </Text>
          ))}
        </Box>
      )}

      <Text fontSize="12.5px" color={tokens.colors.text.secondary} mb={4} lineHeight="1.55">
        {t('publish.update.intro')}
      </Text>

      <Text
        fontSize="11px"
        color={tokens.colors.text.secondary}
        fontWeight="600"
        textTransform="uppercase"
        letterSpacing="0.04em"
        mb="6px"
      >
        {customDomain ? t('publish.update.customDomainLabel') : t('publish.update.liveUrlLabel')}
      </Text>
      <Flex
        align="center"
        gap={2}
        p={3}
        mb={4}
        borderRadius="8px"
        bg="rgba(0, 0, 0, 0.3)"
        border="1px solid rgba(255, 255, 255, 0.06)"
      >
        <Text flex="1" fontSize="13px" fontFamily="mono" color={tokens.colors.text.primary} truncate>
          {liveUrl}
        </Text>
        <Box
          as="a"
          {...{ href: liveUrl, target: '_blank', rel: 'noopener noreferrer' }}
          w="28px"
          h="28px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          color={tokens.colors.text.muted}
          borderRadius="6px"
          _hover={{ bg: 'rgba(255,255,255,0.05)', color: tokens.colors.accent.primary }}
        >
          <FiExternalLink size={13} />
        </Box>
      </Flex>

      {counterLine && (
        <Text
          fontSize="11px"
          color={tokens.colors.text.muted}
          fontFamily={tokens.fontFamily.mono}
          mb={4}
        >
          {counterLine}
        </Text>
      )}

      <Text fontSize="11px" color={tokens.colors.text.muted} lineHeight="1.55" mb={4}>
        {t('publish.update.subdomainHint')}
      </Text>

      <Flex gap={2} justify="flex-end">
        <Button
          onClick={onCancel}
          variant="ghost"
          color={tokens.colors.text.secondary}
          fontSize="12.5px"
          h="36px"
          px={4}
          _hover={{ bg: 'rgba(255,255,255,0.04)', color: tokens.colors.text.primary }}
        >
          {t('publish.cancel')}
        </Button>
        <Button
          onClick={onPublish}
          loading={submitting}
          loadingText={t('publish.updating')}
          h="36px"
          px={4}
          fontSize="12.5px"
          fontWeight="600"
          bg={`linear-gradient(135deg, ${tokens.colors.accent.primary} 0%, ${tokens.colors.accent.primaryDark} 100%)`}
          color="#fff"
          _hover={{ boxShadow: `0 4px 16px -4px ${tokens.colors.accent.primaryGlow}` }}
        >
          {t('publish.update')}
        </Button>
      </Flex>
    </Box>
  )
}

function PublishingStep({ record, isUpdate: _isUpdate }: { record: DeployRecord; isUpdate: boolean }) {
  return (
    <Box>
      <Flex align="center" gap={2} mb={4}>
        <Box
          color={tokens.colors.accent.primary}
          animation="spin 1.4s linear infinite"
          css={{
            '@keyframes spin': {
              from: { transform: 'rotate(0deg)' },
              to: { transform: 'rotate(360deg)' },
            },
          }}
        >
          <FiLoader size={14} />
        </Box>
        <Text fontSize="13px" color={tokens.colors.text.primary} fontWeight="500">
          {record.currentStep
            ? `Step ${record.currentStep.step} of ${record.currentStep.totalSteps} — ${stepLabel(record.currentStep.stepName)}`
            : 'Starting deploy…'}
        </Text>
      </Flex>

      <Box
        h="6px"
        bg="rgba(255, 255, 255, 0.06)"
        borderRadius="full"
        overflow="hidden"
        mb={5}
      >
        <Box
          h="100%"
          w={
            record.currentStep
              ? `${(record.currentStep.step / Math.max(1, record.currentStep.totalSteps)) * 100}%`
              : '0%'
          }
          bg={`linear-gradient(90deg, ${tokens.colors.accent.primary} 0%, ${tokens.colors.accent.primaryDark} 100%)`}
          transition="width 0.4s cubic-bezier(.4,0,.2,1)"
        />
      </Box>

      <Flex direction="column" gap={2}>
        {record.history.map((step, idx) => {
          const isCurrent =
            record.currentStep?.step === step.step && step.status === 'in_progress'
          const isComplete = step.status === 'complete'
          return (
            <Flex key={`${step.step}-${idx}`} align="center" gap={2}>
              <Box
                w="16px"
                h="16px"
                borderRadius="50%"
                display="flex"
                alignItems="center"
                justifyContent="center"
                bg={
                  isComplete
                    ? tokens.colors.accent.greenSubtle
                    : isCurrent
                    ? tokens.colors.accent.primarySubtle
                    : 'rgba(255,255,255,0.04)'
                }
                color={
                  isComplete
                    ? tokens.colors.accent.greenBright
                    : isCurrent
                    ? tokens.colors.accent.primary
                    : tokens.colors.text.muted
                }
                flexShrink={0}
              >
                {isComplete ? (
                  <FiCheckCircle size={10} />
                ) : isCurrent ? (
                  <Box
                    w="6px"
                    h="6px"
                    borderRadius="50%"
                    bg={tokens.colors.accent.primary}
                    animation="pulse 1s ease-in-out infinite"
                    css={{
                      '@keyframes pulse': {
                        '0%, 100%': { opacity: 1 },
                        '50%': { opacity: 0.4 },
                      },
                    }}
                  />
                ) : null}
              </Box>
              <Text
                fontSize="12px"
                color={isComplete || isCurrent ? tokens.colors.text.primary : tokens.colors.text.muted}
                fontWeight={isCurrent ? '500' : '400'}
              >
                {stepLabel(step.stepName)}
                {step.detail && (
                  <Text as="span" color={tokens.colors.text.muted} ml={1}>
                    — {step.detail}
                  </Text>
                )}
              </Text>
            </Flex>
          )
        })}
      </Flex>

      {record.warnings.length > 0 && (
        <Box
          mt={4}
          p={3}
          borderRadius="8px"
          bg="rgba(247, 127, 0, 0.06)"
          border={`1px solid rgba(247, 127, 0, 0.2)`}
        >
          {record.warnings.map((w, i) => (
            <Text key={i} fontSize="11.5px" color={tokens.colors.accent.orange}>
              ⚠ {w}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function SuccessStep({ record, isUpdate, onClose, customDomain }: { record: DeployRecord; isUpdate: boolean; onClose: () => void; customDomain?: string | null }) {
  const url = customDomain ? `https://${customDomain}` : (record.serviceUrl ?? '')
  return (
    <Box>
      <Flex direction="column" align="center" py={3}>
        <Flex
          w="48px"
          h="48px"
          borderRadius="50%"
          bg={tokens.colors.accent.greenSubtle}
          color={tokens.colors.accent.greenBright}
          align="center"
          justify="center"
          mb={3}
        >
          <FiCheckCircle size={24} />
        </Flex>
        <Text fontSize="15px" fontWeight="600" color={tokens.colors.text.primary} mb={1}>
          {t(isUpdate ? 'publish.success.updateHeading' : 'publish.success.liveHeading')}
        </Text>
        <Text fontSize="12px" color={tokens.colors.text.muted}>
          {t(isUpdate ? 'publish.success.updateMessage' : 'publish.success.liveMessage')}
        </Text>
      </Flex>

      <Flex
        align="center"
        gap={2}
        p={3}
        mt={4}
        borderRadius="8px"
        bg="rgba(0, 0, 0, 0.3)"
        border="1px solid rgba(255, 255, 255, 0.08)"
      >
        <Text
          flex="1"
          fontSize="12.5px"
          fontFamily="mono"
          color={tokens.colors.text.primary}
          truncate
        >
          {url}
        </Text>
        <CopyButton text={url} />
        <Box
          as="a"
          {...{ href: url, target: '_blank', rel: 'noopener noreferrer' }}
          w="28px"
          h="28px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          color={tokens.colors.text.muted}
          borderRadius="6px"
          _hover={{ bg: 'rgba(255,255,255,0.05)', color: tokens.colors.accent.primary }}
        >
          <FiExternalLink size={13} />
        </Box>
      </Flex>

      <Flex gap={2} justify="flex-end" mt={6}>
        <Button
          onClick={onClose}
          h="36px"
          px={4}
          fontSize="12.5px"
          fontWeight="500"
          bg="rgba(255,255,255,0.06)"
          color={tokens.colors.text.primary}
          _hover={{ bg: 'rgba(255,255,255,0.1)' }}
        >
          {t('publish.success.done')}
        </Button>
      </Flex>
    </Box>
  )
}

function ErrorStep({
  record,
  onRetry,
  onClose,
}: {
  record: DeployRecord
  onRetry: () => void
  onClose: () => void
}) {
  return (
    <Box>
      <Box
        p={3}
        borderRadius="8px"
        bg={tokens.colors.accent.redSubtle}
        border={`1px solid ${tokens.colors.accent.redMuted}`}
        mb={4}
      >
        <Text fontSize="12.5px" color={tokens.colors.accent.red} fontWeight="500" mb={1}>
          {t('publish.error.heading')}
        </Text>
        <Text fontSize="12px" color={tokens.colors.text.secondary} lineHeight="1.5">
          {renderErrorWithLinks(record.error ?? 'Unknown error')}
        </Text>
      </Box>

      <Flex gap={2} justify="flex-end">
        <Button
          onClick={onClose}
          variant="ghost"
          h="36px"
          px={4}
          fontSize="12.5px"
          color={tokens.colors.text.secondary}
          _hover={{ bg: 'rgba(255,255,255,0.04)', color: tokens.colors.text.primary }}
        >
          {t('publish.error.close')}
        </Button>
        <Button
          onClick={onRetry}
          h="36px"
          px={4}
          fontSize="12.5px"
          fontWeight="600"
          bg={`linear-gradient(135deg, ${tokens.colors.accent.primary} 0%, ${tokens.colors.accent.primaryDark} 100%)`}
          color="#fff"
          _hover={{ boxShadow: `0 4px 16px -4px ${tokens.colors.accent.primaryGlow}` }}
        >
          {t('publish.error.retry')}
        </Button>
      </Flex>
    </Box>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [text])
  return (
    <Box
      as="button"
      w="28px"
      h="28px"
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg="transparent"
      border="none"
      cursor="pointer"
      borderRadius="6px"
      color={copied ? tokens.colors.accent.greenBright : tokens.colors.text.muted}
      _hover={{ bg: 'rgba(255,255,255,0.05)', color: tokens.colors.text.primary }}
      onClick={handleCopy}
      aria-label={t('publish.copyUrl')}
    >
      {copied ? <FiCheckCircle size={13} /> : <FiCopy size={13} />}
    </Box>
  )
}

/**
 * Render an error message with embedded https URLs converted to clickable
 * links. Cloud Build wraps its failure log URLs in the error message
 * (e.g. "Cloud Build FAILURE: STEP 1 failed (logs: https://console.cloud...)").
 * Without this the user has to copy the URL out of plaintext by hand.
 */
function renderErrorWithLinks(text: string): ReactNode {
  const URL_RE = /(https?:\/\/[^\s)]+)/g
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const url = match[0]
    parts.push(
      <a
        key={`${match.index}-${url}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{
          color: tokens.colors.accent.primary,
          textDecoration: 'underline',
          wordBreak: 'break-all',
        }}
      >
        Open logs
      </a>,
    )
    lastIndex = match.index + url.length
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts.length > 0 ? parts : text
}

function stepLabel(name: string): string {
  switch (name) {
    case 'build':
      return 'Building project'
    case 'init':
      return 'Preparing'
    case 'prepare':
      return 'Preparing project'
    case 'auth':
      return 'Configuring authentication'
    case 'database':
      return 'Provisioning database'
    case 'migrations':
      return 'Running migrations'
    case 'worker':
      return 'Publishing backend'
    case 'container/build':
      return 'Building your backend'
    case 'container/deploy':
      return 'Bringing your backend online'
    case 'assets':
      return 'Uploading assets'
    case 'domain':
      return 'Configuring domain'
    case 'finalize':
      return 'Finishing up'
    default:
      return name
  }
}

export default memo(PublishModal)
