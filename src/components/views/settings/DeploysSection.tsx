import { memo, useCallback, useEffect, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'
import {
  FiCheck,
  FiCopy,
  FiExternalLink,
  FiPause,
  FiPlay,
  FiRefreshCw,
  FiTrash2,
} from 'react-icons/fi'
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { useProjectStore } from '../../../stores/projectStore'
import {
  deployService,
  type DeploymentSummary,
  type DeploysListItem,
  type DomainStatusResponse,
} from '../../../services/deployService'

function fmtT(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`))
}

/**
 * Pre-flight validation for the custom-domain input. Catches the three
 * mistakes that don't need a server round-trip to detect:
 *   1. Malformed hostname (typos, scheme prefix, paths).
 *   2. Subdomain of `toquemedia.net` — that's the user's *default* URL,
 *      not something they can re-add as a custom domain.
 *   3. The hostname already attached to this project.
 *
 * Defense-in-depth: the worker re-validates everything via cleanHostname +
 * isValidDomain + the deployment-record lookup. This pre-flight is purely
 * UX — it gives instant feedback so the user doesn't watch a spinner for
 * 300ms only to read the same error.
 */
function preflightHostname(raw: string, summary: DeploymentSummary | null): string | null {
  const h = raw.trim().toLowerCase()
  if (!h) return null // submit button is already disabled — no error to show
  // RFC-1035-ish: each label 1-63 chars, [a-z0-9-], not starting/ending with -;
  // overall must have at least one dot and a TLD ≥2 letters. The worker uses
  // a similar regex; this one trades exotic-IDN support for cheap validation.
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h)) {
    return 'Invalid format. Use something like `app.yourdomain.com` (no http://, no path).'
  }
  if (h.endsWith('.toquemedia.net')) {
    return 'Subdomains of toquemedia.net cannot be used as custom domains — that is already your default URL.'
  }
  if (summary?.customDomain && summary.customDomain.toLowerCase() === h) {
    return 'This domain is already active on this project.'
  }
  return null
}

function DeploysSection() {
  const project = useProjectStore((s) => s.currentProject)
  const [summary, setSummary] = useState<DeploymentSummary | null>(null)
  const [deploysList, setDeploysList] = useState<DeploysListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hostnameInput, setHostnameInput] = useState('')
  const [submittingDomain, setSubmittingDomain] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  /** Per-projectId in-flight flag so the buttons show a loading state without
   *  blocking the rest of the list. */
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  // Tracked separately from `summary.lastDeployedAt` because that field
  // reflects deploy time, not the last hostname-status check. The custom
  // domain panel needs the latter so the user can tell whether the displayed
  // status is fresh or stale (DNS propagation can take 24h+).
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null)

  const loadSummary = useCallback(async () => {
    if (!project) return
    setLoading(true)
    setError(null)
    try {
      const data = await deployService.getDeploymentSummary(project.id)
      setSummary(data)
      if (data.customDomain) setLastCheckedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [project])

  const loadDeploysList = useCallback(async () => {
    try {
      const items = await deployService.listDeploys()
      setDeploysList(items)
    } catch (err) {
      // Don't block the rest of the panel — surface inline only when the
      // list itself was the user's primary interest.
      console.warn('[deploys] list failed', err)
    }
  }, [])

  useEffect(() => {
    loadSummary()
    loadDeploysList()
  }, [loadSummary, loadDeploysList])

  // Refresh on window focus — no polling. The user expects status to update
  // when they come back to the IDE after editing DNS at their registrar.
  useEffect(() => {
    function onFocus() {
      loadSummary()
      loadDeploysList()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadSummary, loadDeploysList])

  /** Generic per-action handler — wraps the service call in a busy guard +
   *  reloads the list on success. Confirms before destructive Delete. */
  const handleAction = useCallback(
    async (item: DeploysListItem, action: 'suspend' | 'resume' | 'delete') => {
      if (action === 'delete') {
        const ok = await tauriConfirm(t('deploys.confirmDelete'), {
          title: t('deploys.action.delete'),
          kind: 'warning',
        })
        if (!ok) return
      }
      setBusyIds((prev) => new Set(prev).add(item.projectId))
      setError(null)
      try {
        if (action === 'suspend') {
          await deployService.suspendDeploy(item.projectId)
        } else if (action === 'resume') {
          await deployService.resumeDeploy(item.projectId)
        } else {
          await deployService.archiveDeploy(item.projectId)
        }
        await loadDeploysList()
        // The current project may be the one we just acted on — refresh the
        // single-project summary so the Custom domain panel stays consistent.
        if (project && item.projectId === project.id) {
          await loadSummary()
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev)
          next.delete(item.projectId)
          return next
        })
      }
    },
    [loadDeploysList, loadSummary, project],
  )

  const handleAddDomain = useCallback(async () => {
    if (!project || !hostnameInput.trim() || submittingDomain) return
    // Re-run the pre-flight here so a forged Enter / DevTools click can't
    // bypass the disabled button. Worker still validates server-side; this
    // is just to keep error state local + spare a network round-trip.
    const preflight = preflightHostname(hostnameInput, summary)
    if (preflight) {
      setError(preflight)
      return
    }
    setSubmittingDomain(true)
    setError(null)
    try {
      const res: DomainStatusResponse = await deployService.addCustomDomain(
        project.id,
        hostnameInput.trim(),
      )
      if (!res.success) {
        setError(res.error ?? t('deploys.failedAddDomain'))
      } else {
        setHostnameInput('')
        await loadSummary()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmittingDomain(false)
    }
  }, [project, hostnameInput, submittingDomain, summary, loadSummary])

  const handleRefreshDomain = useCallback(async () => {
    if (!project || refreshing) return
    setRefreshing(true)
    try {
      await deployService.getCustomDomainStatus(project.id)
      await loadSummary()
    } finally {
      setRefreshing(false)
    }
  }, [project, refreshing, loadSummary])

  const handleRemoveDomain = useCallback(async () => {
    if (!project) return
    const ok = await tauriConfirm(
      t('deploys.removeDomainConfirm'),
      { title: t('deploys.removeDomainTitle'), kind: 'warning' },
    )
    if (!ok) return
    await deployService.removeCustomDomain(project.id)
    await loadSummary()
  }, [project, loadSummary])

  if (!project) {
    return (
      <Text fontSize="13px" color={tokens.colors.text.muted}>
        {t('deploys.openProject')}
      </Text>
    )
  }

  return (
    <Flex direction="column" gap={6}>
      {/* All deployments — overview across the user's account, with
          per-row suspend / resume / delete. The current project is
          highlighted so the user knows which row is "this one". */}
      <Section
        title={t('deploys.yourDeployments')}
        subtitle={
          deploysList.length === 0
            ? t('deploys.empty')
            : `${deploysList.length} live or paused.`
        }
      >
        {deploysList.length > 0 && (
          <Flex direction="column" gap={2}>
            {deploysList.map((item) => (
              <DeployRow
                key={item.projectId}
                item={item}
                isCurrent={project?.id === item.projectId}
                busy={busyIds.has(item.projectId)}
                onAction={handleAction}
              />
            ))}
          </Flex>
        )}
      </Section>

      {/* Current deployment */}
      <Section
        title="Current deployment"
        subtitle={
          loading
            ? 'Loading…'
            : summary?.exists
            ? 'Live. Re-publishing replaces the assets in place.'
            : 'No deployment yet. Use the Publish button in the preview toolbar.'
        }
      >
        {summary?.exists && summary.serviceUrl && (
          <UrlRow
            url={
              summary.customDomain && summary.sslStatus === 'active'
                ? `https://${summary.customDomain}`
                : summary.serviceUrl
            }
            provider={summary.provider}
            lastDeployedAt={summary.lastDeployedAt}
          />
        )}
      </Section>

      {/* Custom domain */}
      <Section
        title="Custom domain"
        subtitle="Point your own domain at this project. The SSL certificate is managed for you once DNS is verified."
      >
        {summary?.customDomain ? (
          <CustomDomainPanel
            summary={summary}
            refreshing={refreshing}
            lastCheckedAt={lastCheckedAt}
            onRefresh={handleRefreshDomain}
            onRemove={handleRemoveDomain}
          />
        ) : (
          <AddDomainPanel
            hostname={hostnameInput}
            onChange={setHostnameInput}
            onSubmit={handleAddDomain}
            submitting={submittingDomain}
            disabled={!summary?.exists}
            disabledMessage={!summary?.exists ? 'Deploy the project first.' : undefined}
            summary={summary}
          />
        )}
      </Section>

      {error && (
        <Box
          p={3}
          borderRadius="8px"
          bg={tokens.colors.accent.redSubtle}
          border={`1px solid ${tokens.colors.accent.redMuted}`}
        >
          <Text fontSize="12px" color={tokens.colors.accent.red}>
            {error}
          </Text>
        </Box>
      )}
    </Flex>
  )
}

function DeployRow({
  item,
  isCurrent,
  busy,
  onAction,
}: {
  item: DeploysListItem
  isCurrent: boolean
  busy: boolean
  onAction: (item: DeploysListItem, action: 'suspend' | 'resume' | 'delete') => void
}) {
  const isActive = item.status === 'active'
  const isSuspended = item.status === 'suspended'

  return (
    <Box
      p={3}
      borderRadius="8px"
      bg={isCurrent ? tokens.colors.accent.primarySubtle : 'rgba(255, 255, 255, 0.03)'}
      border={`1px solid ${isCurrent ? `${tokens.colors.accent.primary}30` : 'rgba(255, 255, 255, 0.06)'}`}
    >
      <Flex align="center" gap={2} mb={item.daysUntilArchive !== null || isCurrent ? 2 : 0}>
        <Box
          as="a"
          {...{ href: item.serviceUrl, target: '_blank', rel: 'noopener noreferrer' }}
          flex="1"
          minW={0}
          fontSize="12.5px"
          fontFamily="mono"
          color={tokens.colors.text.primary}
          _hover={{ color: tokens.colors.accent.primary, textDecoration: 'underline' }}
          truncate
        >
          {item.serviceUrl || item.slug}
        </Box>

        <DeployStatusBadge status={item.status} />

        {isActive && (
          <ActionButton
            label={t('deploys.action.suspend')}
            icon={<FiPause size={11} />}
            busy={busy}
            onClick={() => onAction(item, 'suspend')}
          />
        )}
        {isSuspended && (
          <ActionButton
            label={t('deploys.action.resume')}
            icon={<FiPlay size={11} />}
            busy={busy}
            onClick={() => onAction(item, 'resume')}
            tone="primary"
          />
        )}
        <ActionButton
          label={t('deploys.action.delete')}
          icon={<FiTrash2 size={11} />}
          busy={busy}
          onClick={() => onAction(item, 'delete')}
          tone="danger"
        />
      </Flex>

      {isCurrent && (
        <Text fontSize="10.5px" color={tokens.colors.accent.primary} fontWeight="500">
          Current project
        </Text>
      )}

      {item.daysUntilArchive !== null && (
        <Text fontSize="11px" color={tokens.colors.accent.orange}>
          {item.daysUntilArchive <= 0
            ? t('deploys.daysUntilArchive.today')
            : fmtT(t('deploys.daysUntilArchive'), {
                days: item.daysUntilArchive,
                plural: item.daysUntilArchive === 1 ? '' : 's',
              })}
        </Text>
      )}
    </Box>
  )
}

function DeployStatusBadge({ status }: { status: 'active' | 'suspended' | 'archived' }) {
  const cfg = status === 'active'
    ? { color: tokens.colors.accent.greenBright, bg: tokens.colors.accent.greenSubtle, label: t('deploys.status.active') }
    : status === 'suspended'
      ? { color: tokens.colors.accent.orange, bg: 'rgba(247, 127, 0, 0.1)', label: t('deploys.status.suspended') }
      : { color: tokens.colors.text.muted, bg: 'rgba(255, 255, 255, 0.04)', label: t('deploys.status.archived') }
  return (
    <Flex
      display="inline-flex"
      align="center"
      gap="5px"
      px="8px"
      py="3px"
      borderRadius="5px"
      bg={cfg.bg}
      flexShrink={0}
    >
      <Box w="6px" h="6px" borderRadius="full" bg={cfg.color} />
      <Text fontSize="10.5px" color={cfg.color} fontWeight="500">{cfg.label}</Text>
    </Flex>
  )
}

function ActionButton({
  label,
  icon,
  busy,
  onClick,
  tone = 'default',
}: {
  label: string
  icon: React.ReactNode
  busy: boolean
  onClick: () => void
  tone?: 'default' | 'primary' | 'danger'
}) {
  const palette = tone === 'danger'
    ? { color: tokens.colors.accent.red, hoverBg: tokens.colors.accent.redSubtle }
    : tone === 'primary'
      ? { color: tokens.colors.accent.primary, hoverBg: tokens.colors.accent.primarySubtle }
      : { color: tokens.colors.text.muted, hoverBg: 'rgba(255,255,255,0.05)' }
  return (
    <Box
      as="button"
      w="26px"
      h="26px"
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg="transparent"
      border="none"
      borderRadius="6px"
      cursor={busy ? 'wait' : 'pointer'}
      opacity={busy ? 0.4 : 1}
      color={palette.color}
      _hover={busy ? {} : { bg: palette.hoverBg }}
      onClick={busy ? undefined : onClick}
      title={label}
      aria-label={label}
    >
      {icon}
    </Box>
  )
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <Box>
      <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary} mb="2px">
        {title}
      </Text>
      <Text fontSize="11.5px" color={tokens.colors.text.muted} mb={3} lineHeight="1.5">
        {subtitle}
      </Text>
      {children}
    </Box>
  )
}

function UrlRow({
  url,
  provider,
  lastDeployedAt,
}: {
  url: string
  provider?: string
  lastDeployedAt?: string
}) {
  return (
    <Box
      p={3}
      borderRadius="8px"
      bg="rgba(255, 255, 255, 0.03)"
      border="1px solid rgba(255, 255, 255, 0.06)"
    >
      <Flex align="center" gap={2} mb={lastDeployedAt || provider ? 2 : 0}>
        <Text flex="1" fontSize="12.5px" fontFamily="mono" color={tokens.colors.text.primary} truncate>
          {url}
        </Text>
        <CopyButton text={url} />
        <Box
          as="a"
          {...{ href: url, target: '_blank', rel: 'noopener noreferrer' }}
          w="26px"
          h="26px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          color={tokens.colors.text.muted}
          borderRadius="6px"
          _hover={{ bg: 'rgba(255,255,255,0.05)', color: tokens.colors.accent.primary }}
        >
          <FiExternalLink size={12} />
        </Box>
      </Flex>
      {(lastDeployedAt || provider) && (
        <Text fontSize="11px" color={tokens.colors.text.muted}>
          {provider && lastDeployedAt && ' · '}
          {lastDeployedAt && (
            <>
              Last deployed: <Text as="span" color={tokens.colors.text.secondary}>{formatTime(lastDeployedAt)}</Text>
            </>
          )}
        </Text>
      )}
    </Box>
  )
}

function AddDomainPanel({
  hostname,
  onChange,
  onSubmit,
  submitting,
  disabled,
  disabledMessage,
  summary,
}: {
  hostname: string
  onChange: (v: string) => void
  onSubmit: () => void
  submitting: boolean
  disabled?: boolean
  disabledMessage?: string
  summary: DeploymentSummary | null
}) {
  if (disabled && disabledMessage) {
    return (
      <Text fontSize="12px" color={tokens.colors.text.muted}>
        {disabledMessage}
      </Text>
    )
  }
  // Pre-flight runs on every keystroke — cheap regex + 2 string compares.
  // Result is null while empty (no error to show yet) and a string when
  // the input is non-empty AND fails one of the local checks.
  const preflightError = preflightHostname(hostname, summary)
  const submitDisabled = !hostname.trim() || preflightError !== null
  return (
    <Box>
      <Flex gap={2}>
        <Input
          value={hostname}
          onChange={(e) => onChange(e.target.value)}
          placeholder="app.yourdomain.com"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          bg="rgba(0, 0, 0, 0.3)"
          border="1px solid"
          // Red border when there's a pre-flight error so the input itself
          // signals invalidity even before reading the message below.
          borderColor={preflightError ? `${tokens.colors.accent.red}90` : 'rgba(255, 255, 255, 0.08)'}
          color={tokens.colors.text.primary}
          _placeholder={{ color: tokens.colors.text.muted }}
          _hover={{ borderColor: preflightError ? tokens.colors.accent.red : 'rgba(255, 255, 255, 0.16)' }}
          _focus={{
            borderColor: preflightError ? tokens.colors.accent.red : tokens.colors.accent.primary,
            boxShadow: `0 0 0 1px ${preflightError ? tokens.colors.accent.red : tokens.colors.accent.primary}`,
            outline: 'none',
          }}
          fontSize="13px"
          h="38px"
          flex="1"
          fontFamily="mono"
          aria-invalid={preflightError ? true : undefined}
          // Submit on Enter when valid — keeps the keyboard flow that the
          // Button handles for click. Defense-in-depth: also gated by
          // `submitDisabled` so a malformed hostname can't slip through.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !submitDisabled && !submitting) onSubmit()
          }}
        />
        <Button
          onClick={onSubmit}
          loading={submitting}
          loadingText="Adding…"
          disabled={submitDisabled}
          h="38px"
          px={4}
          fontSize="12.5px"
          fontWeight="600"
          bg={`linear-gradient(135deg, ${tokens.colors.accent.primary} 0%, ${tokens.colors.accent.primaryDark} 100%)`}
          color="#fff"
          _hover={{ boxShadow: `0 4px 16px -4px ${tokens.colors.accent.primaryGlow}` }}
        >
          Add domain
        </Button>
      </Flex>
      {preflightError && (
        <Text
          fontSize="11.5px"
          color={tokens.colors.accent.red}
          mt="6px"
          lineHeight="1.4"
          role="alert"
        >
          {preflightError}
        </Text>
      )}
    </Box>
  )
}

function CustomDomainPanel({
  summary,
  refreshing,
  lastCheckedAt,
  onRefresh,
  onRemove,
}: {
  summary: DeploymentSummary
  refreshing: boolean
  lastCheckedAt: number | null
  onRefresh: () => void
  onRemove: () => void
}) {
  const isActive = summary.domainStatus === 'active' && summary.sslStatus === 'active'
  return (
    <Box>
      <Flex align="center" gap={2} mb="6px">
        <Text fontSize="13px" fontFamily="mono" color={tokens.colors.text.primary} flex="1">
          {summary.customDomain}
        </Text>
        <StatusBadge active={isActive} status={summary.domainStatus ?? 'pending'} sslStatus={summary.sslStatus} />
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
          onClick={onRefresh}
          title="Refresh status"
          aria-label={t('deploys.refresh')}
        >
          <Box
            css={refreshing ? {
              animation: 'spin 1s linear infinite',
              '@keyframes spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
            } : undefined}
          >
            <FiRefreshCw size={12} />
          </Box>
        </Box>
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
          _hover={{ bg: tokens.colors.accent.redSubtle, color: tokens.colors.accent.red }}
          onClick={onRemove}
          title="Remove custom domain"
          aria-label="Remove"
        >
          <FiTrash2 size={12} />
        </Box>
      </Flex>

      {/* Last-checked timestamp — helps the user judge whether the displayed
          status is fresh or stale. DNS propagation can take 24h+ so this
          context matters more for custom domains than for app-internal data. */}
      <Text fontSize="10.5px" color={tokens.colors.text.muted} mb={3} ml="2px">
        Last checked: <Text as="span" color={tokens.colors.text.secondary}>{formatRelativeTime(lastCheckedAt)}</Text>
        {' · '}
        <Text
          as="span"
          color={tokens.colors.text.muted}
          textDecoration="underline"
          cursor={refreshing ? 'wait' : 'pointer'}
          opacity={refreshing ? 0.5 : 1}
          _hover={refreshing ? {} : { color: tokens.colors.text.primary }}
          onClick={refreshing ? undefined : onRefresh}
        >
          {refreshing ? 'checking…' : 'check now'}
        </Text>
      </Text>

      {!isActive && (
        <Box
          mt={2}
          p={3}
          borderRadius="8px"
          bg="rgba(247, 127, 0, 0.06)"
          border={`1px solid rgba(247, 127, 0, 0.2)`}
          mb={3}
        >
          <Text fontSize="11.5px" color={tokens.colors.accent.orange} fontWeight="500" mb={1}>
            Add these DNS records at your domain registrar
          </Text>
          <Text fontSize="11px" color={tokens.colors.text.muted}>
            Status refreshes when this window regains focus, or click "check now" above. DNS propagation can take up to 24h.
          </Text>
        </Box>
      )}

      {summary.trafficRecord && <DnsRecord label="Traffic" record={summary.trafficRecord} />}
      {summary.sslVerificationRecord && (
        <DnsRecord label="SSL verification" record={summary.sslVerificationRecord} />
      )}
    </Box>
  )
}

function DnsRecord({
  label,
  record,
}: {
  label: string
  record: { type: string; name: string; value: string }
}) {
  return (
    <Box
      mt={2}
      borderRadius="8px"
      border="1px solid rgba(255, 255, 255, 0.06)"
      bg="rgba(0, 0, 0, 0.3)"
      overflow="hidden"
    >
      <Flex
        align="center"
        gap={2}
        px={3}
        py={2}
        bg="rgba(255, 255, 255, 0.02)"
        borderBottom="1px solid rgba(255, 255, 255, 0.06)"
      >
        <Text
          fontSize="10px"
          color={tokens.colors.text.muted}
          textTransform="uppercase"
          letterSpacing="0.06em"
          fontWeight="600"
        >
          {label}
        </Text>
        <Box
          px="6px"
          py="2px"
          borderRadius="4px"
          bg="rgba(255, 255, 255, 0.05)"
          fontSize="10px"
          fontFamily="mono"
          color={tokens.colors.text.secondary}
        >
          {record.type}
        </Box>
      </Flex>
      <Box px={3} py={2}>
        <Field label="Name" value={record.name} />
        <Field label="Value" value={record.value} />
      </Box>
    </Box>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Flex align="center" gap={2} py="4px">
      <Text fontSize="10.5px" color={tokens.colors.text.muted} w="50px">
        {label}
      </Text>
      <Text
        flex="1"
        fontSize="12px"
        fontFamily="mono"
        color={tokens.colors.text.primary}
        truncate
      >
        {value}
      </Text>
      <CopyButton text={value} />
    </Flex>
  )
}

function StatusBadge({
  active,
  status,
  sslStatus,
}: {
  active: boolean
  status: string
  sslStatus?: string
}) {
  const color = active ? tokens.colors.accent.greenBright : tokens.colors.accent.orange
  const bg = active ? tokens.colors.accent.greenSubtle : 'rgba(247, 127, 0, 0.1)'
  const label = active ? 'Active' : `${status}${sslStatus ? ` · SSL ${sslStatus}` : ''}`
  return (
    <Flex
      display="inline-flex"
      align="center"
      gap="5px"
      px="8px"
      py="3px"
      borderRadius="5px"
      bg={bg}
    >
      <Box w="6px" h="6px" borderRadius="full" bg={color} />
      <Text fontSize="10.5px" color={color} fontWeight="500">{label}</Text>
    </Flex>
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
      w="26px"
      h="26px"
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
      aria-label="Copy"
    >
      {copied ? <FiCheck size={12} /> : <FiCopy size={12} />}
    </Box>
  )
}

function formatRelativeTime(epochMs: number | null): string {
  if (!epochMs) return 'never'
  const diff = Date.now() - epochMs
  if (diff < 5_000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(epochMs).toLocaleString()
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}

export default memo(DeploysSection)
