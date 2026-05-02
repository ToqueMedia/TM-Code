import { memo, useCallback, useEffect, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'
import {
  FiCheck,
  FiCopy,
  FiExternalLink,
  FiRefreshCw,
  FiTrash2,
} from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useProjectStore } from '../../../stores/projectStore'
import {
  deployService,
  type DeploymentSummary,
  type DomainStatusResponse,
} from '../../../services/deployService'

function DeploysSection() {
  const project = useProjectStore((s) => s.currentProject)
  const [summary, setSummary] = useState<DeploymentSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hostnameInput, setHostnameInput] = useState('')
  const [submittingDomain, setSubmittingDomain] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
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

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  // Refresh on window focus — no polling. The user expects status to update
  // when they come back to the IDE after editing DNS at their registrar.
  useEffect(() => {
    function onFocus() {
      loadSummary()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadSummary])

  const handleAddDomain = useCallback(async () => {
    if (!project || !hostnameInput.trim() || submittingDomain) return
    setSubmittingDomain(true)
    setError(null)
    try {
      const res: DomainStatusResponse = await deployService.addCustomDomain(
        project.id,
        hostnameInput.trim(),
      )
      if (!res.success) {
        setError(res.error ?? 'Failed to add domain')
      } else {
        setHostnameInput('')
        await loadSummary()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmittingDomain(false)
    }
  }, [project, hostnameInput, submittingDomain, loadSummary])

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
    const ok = confirm('Remove the custom domain? Your project will only be reachable at the default subdomain.')
    if (!ok) return
    await deployService.removeCustomDomain(project.id)
    await loadSummary()
  }, [project, loadSummary])

  if (!project) {
    return (
      <Text fontSize="13px" color={tokens.colors.text.muted}>
        Open a project to see its deployment.
      </Text>
    )
  }

  return (
    <Flex direction="column" gap={6}>
      {/* Current deployment */}
      <Section
        title="Current deployment"
        subtitle={
          loading
            ? 'Loading…'
            : summary?.exists
            ? 'Live on Cloudflare. Re-publishing replaces the assets in place.'
            : 'No deployment yet. Use the Publish button in the title bar.'
        }
      >
        {summary?.exists && summary.serviceUrl && (
          <UrlRow url={summary.serviceUrl} provider={summary.provider} lastDeployedAt={summary.lastDeployedAt} />
        )}
      </Section>

      {/* Custom domain */}
      <Section
        title="Custom domain"
        subtitle="Point your own domain at this project. Cloudflare manages the SSL certificate automatically once DNS is verified."
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
          {provider && <>Provider: <Text as="span" color={tokens.colors.text.secondary}>{provider}</Text></>}
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
}: {
  hostname: string
  onChange: (v: string) => void
  onSubmit: () => void
  submitting: boolean
  disabled?: boolean
  disabledMessage?: string
}) {
  if (disabled && disabledMessage) {
    return (
      <Text fontSize="12px" color={tokens.colors.text.muted}>
        {disabledMessage}
      </Text>
    )
  }
  return (
    <Flex gap={2}>
      <Input
        value={hostname}
        onChange={(e) => onChange(e.target.value)}
        placeholder="app.yourdomain.com"
        bg="rgba(0, 0, 0, 0.3)"
        border="1px solid rgba(255, 255, 255, 0.08)"
        color={tokens.colors.text.primary}
        _placeholder={{ color: tokens.colors.text.muted }}
        _hover={{ borderColor: 'rgba(255, 255, 255, 0.16)' }}
        _focus={{
          borderColor: tokens.colors.accent.primary,
          boxShadow: `0 0 0 1px ${tokens.colors.accent.primary}`,
          outline: 'none',
        }}
        fontSize="13px"
        h="38px"
        flex="1"
        fontFamily="mono"
      />
      <Button
        onClick={onSubmit}
        loading={submitting}
        loadingText="Adding…"
        disabled={!hostname.trim()}
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
          aria-label="Refresh"
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
