import { memo, useCallback, useEffect, useMemo, useState } from 'react'
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
import { deployService } from '../../services/deployService'

type Phase = 'configure' | 'publishing' | 'success' | 'error'

interface PublishModalProps {
  isOpen: boolean
  onClose: () => void
}

function slugSuggest(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

function PublishModal({ isOpen, onClose }: PublishModalProps) {
  const project = useProjectStore((s) => s.currentProject)
  const userPlan = useBillingStore((s) => s.plan)

  const record = useDeployStore((s) =>
    project ? s.records.get(project.id) ?? null : null,
  )

  const phase: Phase = useMemo(() => {
    if (!record) return 'configure'
    if (record.phase === 'in_progress') return 'publishing'
    if (record.phase === 'success') return 'success'
    if (record.phase === 'error') return 'error'
    return 'configure'
  }, [record])

  const [subdomain, setSubdomain] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Seed subdomain when modal opens
  useEffect(() => {
    if (isOpen && project) {
      setSubdomain((prev) => prev || slugSuggest(project.name))
    }
    if (!isOpen) {
      setSubmitting(false)
    }
  }, [isOpen, project])

  const handlePublish = useCallback(async () => {
    if (!project || submitting) return
    setSubmitting(true)
    try {
      await deployService.deploy(project.path, {
        projectId: project.id,
        projectName: project.name,
        customSubdomain: subdomain || undefined,
        userPlan,
      })
    } catch {
      // store already records the failure; UI will pivot to error phase
    } finally {
      setSubmitting(false)
    }
  }, [project, submitting, subdomain, userPlan])

  const handleClose = useCallback(() => {
    if (phase === 'publishing') return // can't close mid-deploy
    onClose()
  }, [phase, onClose])

  if (!project) return null

  return (
    <Dialog.Root open={isOpen} onOpenChange={(e) => !e.open && handleClose()}>
      <Portal>
        <Dialog.Backdrop bg={tokens.colors.dialog.backdrop} />
        <Dialog.Positioner>
          <Dialog.Content
            bg={tokens.colors.dialog.bg}
            color={tokens.colors.text.primary}
            border={`1px solid ${tokens.colors.dialog.border}`}
            maxW="540px"
            borderRadius="14px"
            boxShadow="0 20px 60px -20px rgba(0,0,0,0.6)"
            overflow="hidden"
          >
            <Header phase={phase} onClose={handleClose} />

            <Box px={6} py={5}>
              {phase === 'configure' && (
                <ConfigureStep
                  subdomain={subdomain}
                  onSubdomainChange={setSubdomain}
                  onPublish={handlePublish}
                  onCancel={handleClose}
                  submitting={submitting}
                />
              )}
              {phase === 'publishing' && record && <PublishingStep record={record} />}
              {phase === 'success' && record && (
                <SuccessStep record={record} onClose={handleClose} />
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

function Header({ phase, onClose }: { phase: Phase; onClose: () => void }) {
  return (
    <Flex
      align="center"
      justify="space-between"
      px={6}
      py={4}
      borderBottom={`1px solid ${tokens.colors.border.default}`}
      bg="rgba(255, 255, 255, 0.02)"
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
            {phase === 'success' ? 'Project published' : 'Publish project'}
          </Text>
          <Text fontSize="11.5px" color={tokens.colors.text.muted} lineHeight="1.2" mt="2px">
            Deploys to Cloudflare — frontend on R2, backend as a Worker
          </Text>
        </Box>
      </Flex>
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
        cursor={phase === 'publishing' ? 'not-allowed' : 'pointer'}
        opacity={phase === 'publishing' ? 0.4 : 1}
        color={tokens.colors.text.muted}
        _hover={phase === 'publishing' ? {} : { bg: 'rgba(255,255,255,0.05)', color: tokens.colors.text.primary }}
        onClick={onClose}
        aria-label="Close"
      >
        <FiX size={14} />
      </Box>
    </Flex>
  )
}

function ConfigureStep({
  subdomain,
  onSubdomainChange,
  onPublish,
  onCancel,
  submitting,
}: {
  subdomain: string
  onSubdomainChange: (v: string) => void
  onPublish: () => void
  onCancel: () => void
  submitting: boolean
}) {
  const isValid = subdomain.trim().length > 0
  return (
    <Box>
      <Text fontSize="12.5px" color={tokens.colors.text.secondary} mb={4} lineHeight="1.5">
        Give your project a public address. You can change it on the next deploy.
      </Text>

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
            onChange={(e) => onSubdomainChange(slugSuggest(e.target.value))}
            placeholder="my-project"
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
          Letters, numbers, and hyphens only.
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
          Cancel
        </Button>
        <Button
          onClick={onPublish}
          loading={submitting}
          loadingText="Publishing…"
          disabled={!isValid}
          h="36px"
          px={4}
          fontSize="12.5px"
          fontWeight="600"
          bg={`linear-gradient(135deg, ${tokens.colors.accent.primary} 0%, ${tokens.colors.accent.primaryDark} 100%)`}
          color="#fff"
          _hover={{ boxShadow: `0 4px 16px -4px ${tokens.colors.accent.primaryGlow}` }}
        >
          Publish
        </Button>
      </Flex>
    </Box>
  )
}

function PublishingStep({ record }: { record: DeployRecord }) {
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

function SuccessStep({ record, onClose }: { record: DeployRecord; onClose: () => void }) {
  const url = record.serviceUrl ?? ''
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
          Live!
        </Text>
        <Text fontSize="12px" color={tokens.colors.text.muted}>
          Your project is now public.
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
          Done
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
          Deploy failed
        </Text>
        <Text fontSize="12px" color={tokens.colors.text.secondary} lineHeight="1.5">
          {record.error ?? 'Unknown error'}
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
          Close
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
          Retry
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
      aria-label="Copy URL"
    >
      {copied ? <FiCheckCircle size={13} /> : <FiCopy size={13} />}
    </Box>
  )
}

function stepLabel(name: string): string {
  switch (name) {
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
    case 'assets':
      return 'Uploading assets'
    case 'domain':
      return 'Configuring domain'
    default:
      return name
  }
}

export default memo(PublishModal)
