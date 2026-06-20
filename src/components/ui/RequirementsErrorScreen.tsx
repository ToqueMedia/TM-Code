import React from 'react'
import { Box, Button, Flex, Heading, Text, VStack, Link } from '@chakra-ui/react'
import { FiAlertTriangle, FiRefreshCw, FiExternalLink, FiZap, FiDownload, FiLoader } from 'react-icons/fi'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@/utils/invokeMetrics'
import { tokens } from '@/theme/tokens'
import { IS_WINDOWS } from '@/utils/platform'
import type { EnvironmentCheckResult } from '@/services/environmentCheck'
import { GLOBAL_REQUIREMENTS } from '@/services/startupRequirements'
import {
  WINDOWS_DOWNLOAD_LINKS,
  INSTALL_PHASE_LABELS,
  requirementToToolId,
  type DevToolId,
  type ToolInstallProgress,
  type ToolInstallResult,
} from '@/services/devToolsInstall'

interface RequirementsErrorScreenProps {
  result: EnvironmentCheckResult
  onRetry: () => void | Promise<void>
}

type InstallStatus = 'idle' | 'installing' | 'error'
interface InstallEntry {
  status: InstallStatus
  /** winget | downloading | installing | refreshing */
  phase?: string
  percent?: number
  error?: string
}

export const RequirementsErrorScreen: React.FC<RequirementsErrorScreenProps> = ({ result, onRetry }) => {
  const [isRetrying, setIsRetrying] = React.useState(false)
  // Per-tool native-install state (Windows one-click). Keyed by DevToolId.
  const [installs, setInstalls] = React.useState<Record<string, InstallEntry>>({})

  const handleRetry = async () => {
    setIsRetrying(true)
    await onRetry()
    setIsRetrying(false)
  }

  const missingMandatory = GLOBAL_REQUIREMENTS.filter(req => {
    if (!req.mandatory) return false
    const status = result?.requirements?.[req.name]
    return !status || !status.meetsMinimum
  })

  const getStatus = (reqName: string) => result?.requirements?.[reqName]

  // Mirror the Rust installer's live progress onto the matching card. Terminal
  // phases (done/error) are resolved by the invoke() result in handleInstall,
  // so we only reflect the intermediate phases here.
  React.useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<ToolInstallProgress>('tool-install-progress', (event) => {
      const { tool, phase, percent } = event.payload
      if (phase === 'done' || phase === 'error') return
      setInstalls(prev => ({
        ...prev,
        [tool]: {
          status: 'installing',
          phase,
          percent: phase === 'downloading' ? (percent ?? prev[tool]?.percent) : undefined,
        },
      }))
    }).then((fn) => { unlisten = fn })
    return () => { if (unlisten) unlisten() }
  }, [])

  // Native install: download + silent install + PATH refresh in Rust, then
  // re-run the startup check. If every mandatory tool is now present the parent
  // unmounts this screen; otherwise the remaining cards stay.
  const handleInstall = React.useCallback(async (toolId: DevToolId) => {
    setInstalls(prev => ({ ...prev, [toolId]: { status: 'installing', phase: 'winget' } }))
    try {
      const res = await invoke<ToolInstallResult>('install_dev_tool', {
        toolId,
        downloadUrl: WINDOWS_DOWNLOAD_LINKS[toolId],
      })
      if (res.success) {
        setInstalls(prev => ({ ...prev, [toolId]: { status: 'idle' } }))
        await onRetry()
      } else {
        setInstalls(prev => ({ ...prev, [toolId]: { status: 'error', error: res.message } }))
      }
    } catch (err) {
      setInstalls(prev => ({ ...prev, [toolId]: { status: 'error', error: String(err) } }))
    }
  }, [onRetry])

  const anyInstalling = Object.values(installs).some(i => i.status === 'installing')

  // Install every still-missing tool, one at a time so the UAC prompts don't stack.
  const handleInstallAll = React.useCallback(async () => {
    for (const req of missingMandatory) {
      const toolId = requirementToToolId(req.name)
      if (toolId) await handleInstall(toolId)
    }
  }, [missingMandatory, handleInstall])

  // Native one-click install is Windows-only (winget / signed installer +
  // automatic PATH refresh). Elsewhere we keep the browser-download link.
  const canNativeInstall = IS_WINDOWS && missingMandatory.some(req => requirementToToolId(req.name) !== null)

  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      height="100vh"
      bg={tokens.colors.bg.app}
      color={tokens.colors.text.primary}
      p={8}
      textAlign="center"
    >
      <VStack gap={6} maxW="500px">
        <Box
          bg="rgba(254, 16, 99, 0.1)"
          p={6}
          borderRadius="full"
          color={tokens.colors.accent.red}
        >
          <FiAlertTriangle size={48} />
        </Box>

        <VStack gap={2}>
          <Heading size="lg" fontWeight="800">
            Requisitos incompatíveis
          </Heading>
          <Text color={tokens.colors.text.secondary} fontSize="15px">
            O TM Code precisa destas ferramentas com versões compatíveis para funcionar corretamente.
          </Text>
        </VStack>

        <VStack align="stretch" w="100%" gap={3} mt={4}>
          {missingMandatory.map(req => {
            const status = getStatus(req.name)
            const isOutdated = !!status?.found && !status.meetsMinimum
            const toolId = requirementToToolId(req.name)
            const install = (toolId && installs[toolId]) || { status: 'idle' as InstallStatus }
            const isInstalling = install.status === 'installing'
            const isInstallError = install.status === 'error'
            // Native install offered only when on Windows AND the tool is one the
            // installer handles. Otherwise the external link stays the action.
            const nativeInstall = IS_WINDOWS && !!toolId

            return (
            <Box
              key={req.name}
              bg={tokens.colors.bg.card}
              border="1px solid"
              borderColor={isInstallError ? 'rgba(239, 68, 68, 0.25)' : tokens.colors.border.default}
              borderRadius={tokens.radius.xl}
              p={4}
              textAlign="left"
            >
              <Flex justify="space-between" align="center" mb={2} gap={3}>
                <Text fontWeight="700" fontSize="14px">
                  {req.name}
                </Text>

                {isInstalling ? (
                  // Live install status (phase + download %)
                  <Flex align="center" gap={1.5} color={tokens.colors.accent.orange} flexShrink={0}>
                    <Box css={{ animation: 'spin 1s linear infinite' }} display="flex">
                      <FiLoader size={12} />
                    </Box>
                    <Text fontSize="12px" fontWeight="600">
                      {install.phase === 'downloading' && install.percent != null
                        ? `A descarregar… ${Math.round(install.percent)}%`
                        : INSTALL_PHASE_LABELS[install.phase || ''] || 'A instalar…'}
                    </Text>
                  </Flex>
                ) : nativeInstall ? (
                  // Windows: native one-click install (with manual link fallback on error)
                  <Flex align="center" gap={3} flexShrink={0}>
                    {isInstallError && (
                      <Link
                        href={req.installUrl}
                        target="_blank"
                        color={tokens.colors.text.muted}
                        fontSize="12px"
                        display="flex"
                        alignItems="center"
                        gap={1}
                      >
                        Download <FiExternalLink size={10} />
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => handleInstall(toolId!)}
                      disabled={anyInstalling}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '7px 14px',
                        borderRadius: tokens.radius.lg,
                        border: `1px solid ${tokens.colors.accent.primaryBorder}`,
                        background: tokens.colors.accent.primarySubtle,
                        color: tokens.colors.accent.primary,
                        fontFamily: 'inherit',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: anyInstalling ? 'not-allowed' : 'pointer',
                        opacity: anyInstalling ? 0.5 : 1,
                      }}
                    >
                      <FiZap size={13} />
                      {isInstallError ? 'Tentar de novo' : 'Instalar'}
                    </button>
                  </Flex>
                ) : (
                  // macOS / Linux: browser download (no silent installer)
                  <Link
                    href={req.installUrl}
                    target="_blank"
                    color={tokens.colors.accent.primary}
                    fontSize="12px"
                    display="flex"
                    alignItems="center"
                    gap={1}
                    flexShrink={0}
                  >
                    <FiDownload size={11} /> Download <FiExternalLink size={10} />
                  </Link>
                )}
              </Flex>
              <Text fontSize="12px" color={isInstallError ? tokens.colors.accent.red : tokens.colors.text.muted}>
                {isInstallError
                  ? (install.error || 'A instalação automática falhou. Use o link de download acima.')
                  : isOutdated
                  ? `Encontrado ${status?.version ?? 'versão desconhecida'} — mínimo necessário ${req.minVersion}. ${req.installHint}`
                  : `Não encontrado. ${req.installHint}`}
              </Text>
            </Box>
            )
          })}
        </VStack>

        {/* Windows convenience: install every missing tool in one go. */}
        {canNativeInstall && missingMandatory.length > 1 && (
          <Button
            size="md"
            variant="outline"
            borderColor={tokens.colors.accent.primaryBorder}
            color={tokens.colors.accent.primary}
            _hover={{ bg: tokens.colors.accent.primarySubtle }}
            onClick={handleInstallAll}
            disabled={anyInstalling}
            borderRadius={tokens.radius.lg}
          >
            <FiZap size={15} style={{ marginRight: 8 }} />
            {anyInstalling ? 'A instalar…' : 'Instalar tudo'}
          </Button>
        )}

        <Button
          mt={canNativeInstall && missingMandatory.length > 1 ? 0 : 6}
          size="lg"
          bg={tokens.colors.accent.primary}
          color="white"
          _hover={{ bg: tokens.colors.accent.primaryDark }}
          onClick={handleRetry}
          loading={isRetrying}
          disabled={anyInstalling}
          borderRadius={tokens.radius.lg}
          px={8}
        >
          <FiRefreshCw size={18} className={isRetrying ? 'spin' : ''} style={{ marginRight: 8 }} />
          Verificar novamente
        </Button>

        <Text fontSize="11px" color={tokens.colors.text.disabled} mt={4}>
          {IS_WINDOWS
            ? 'A instalação corre internamente (download + instalação silenciosa + atualização do PATH). Se falhar, use o link de download de cada ferramenta.'
            : 'Após instalar as ferramentas, poderá ser necessário reiniciar a aplicação ou o computador para que as alterações no PATH tenham efeito.'}
        </Text>
      </VStack>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .spin {
          animation: spin 1s linear infinite;
        }
      `}</style>
    </Flex>
  )
}
