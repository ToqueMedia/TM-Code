import { useState, useEffect, useCallback } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import {
  FiZap,
  FiShield,
  FiTerminal,
  FiLayers,
  FiGitBranch,
  FiDownload,
  FiCheck,
  FiCopy,
  FiCheckCircle,
  FiAlertTriangle
} from 'react-icons/fi'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@/utils/invokeMetrics'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import { IS_MAC, IS_WINDOWS } from '@/utils/platform'
import OnboardingNav from '../OnboardingNav'

interface ToolsStepProps {
  onNext: () => void
  onBack: () => void
}

type ToolId = 'python' | 'node' | 'git'
type ToolStatus =
  | 'checking'
  | 'available'
  | 'not-installed'
  | 'installing'        // Windows one-click install in progress
  | 'install-error'     // Windows install failed → show manual fallback
  | 'waiting-install'   // macOS/Linux: installer opened in browser, awaiting user
  | 'installed'

interface ToolState {
  status: ToolStatus
  version: string
  /** Download progress 0–100 during the Windows one-click install. */
  percent?: number
  /** Current install phase label (winget | downloading | installing | refreshing). */
  phase?: string
  /** Human-readable error when status === 'install-error'. */
  error?: string
}

// Maps the install phase emitted by the Rust backend to a short PT label.
const PHASE_LABELS: Record<string, string> = {
  winget: 'A instalar via winget…',
  downloading: 'A descarregar…',
  installing: 'A instalar…',
  refreshing: 'A verificar…',
}

// Links de download diretos e personalizados para Windows (substituir pelos links finais)
const WINDOWS_DOWNLOAD_LINKS: Record<ToolId, string> = {
  python: 'https://assets-tm.toquemedia.net/python-3.14.5-amd64.exe',
  node: 'https://assets-tm.toquemedia.net/node-v22.22.3-x64.msi',
  git: 'https://assets-tm.toquemedia.net/Git-2.54.0-64-bit.exe',
}

function ToolsStep({ onNext, onBack }: ToolsStepProps) {
  const t = useTranslation()
  const [tools, setTools] = useState<Record<ToolId, ToolState>>({
    python: { status: 'checking', version: '' },
    node: { status: 'checking', version: '' },
    git: { status: 'checking', version: '' },
  })

  const [copiedStatus, setCopiedStatus] = useState<Record<ToolId, boolean>>({
    python: false,
    node: false,
    git: false,
  })

  // 1. Detect Python 3
  const detectPython = useCallback(async (): Promise<ToolState> => {
    try {
      // First try python3
      const res3 = await invoke<{
        stdout: string; stderr: string; exitCode: number; success: boolean; timedOut: boolean
      }>('execute_command', {
        command: 'python3 --version',
        cwd: IS_WINDOWS ? 'C:\\' : '/tmp',
        timeoutSecs: 5,
      })

      if (res3.success && res3.exitCode === 0) {
        const out = (res3.stdout || res3.stderr || '').trim()
        const match = out.match(/Python\s+([0-9.]+)/i)
        if (match) {
          return { status: 'available', version: match[1] }
        }
        return { status: 'available', version: out.replace(/Python\s+/i, '') || '3.x' }
      }
    } catch {
      // Ignore and fallback to python
    }

    try {
      // Fallback to python
      const res = await invoke<{
        stdout: string; stderr: string; exitCode: number; success: boolean; timedOut: boolean
      }>('execute_command', {
        command: 'python --version',
        cwd: IS_WINDOWS ? 'C:\\' : '/tmp',
        timeoutSecs: 5,
      })

      if (res.success && res.exitCode === 0) {
        const out = (res.stdout || res.stderr || '').trim()
        if (out.toLowerCase().includes('python 3') || out.startsWith('3.')) {
          const match = out.match(/Python\s+([0-9.]+)/i)
          if (match) {
            return { status: 'available', version: match[1] }
          }
          return { status: 'available', version: out.replace(/Python\s+/i, '') || '3.x' }
        }
      }
    } catch {
      // Failed
    }

    return { status: 'not-installed', version: '' }
  }, [])

  // 2. Detect Node.js
  const detectNode = useCallback(async (): Promise<ToolState> => {
    try {
      const res = await invoke<{
        stdout: string; stderr: string; exitCode: number; success: boolean; timedOut: boolean
      }>('execute_command', {
        command: 'node --version',
        cwd: IS_WINDOWS ? 'C:\\' : '/tmp',
        timeoutSecs: 5,
      })

      if (res.success && res.exitCode === 0) {
        const out = (res.stdout || res.stderr || '').trim()
        return { status: 'available', version: out }
      }
    } catch {
      // Failed
    }
    return { status: 'not-installed', version: '' }
  }, [])

  // 3. Detect Git
  const detectGit = useCallback(async (): Promise<ToolState> => {
    try {
      const res = await invoke<{
        stdout: string; stderr: string; exitCode: number; success: boolean; timedOut: boolean
      }>('execute_command', {
        command: 'git --version',
        cwd: IS_WINDOWS ? 'C:\\' : '/tmp',
        timeoutSecs: 5,
      })

      if (res.success && res.exitCode === 0) {
        const out = (res.stdout || res.stderr || '').trim()
        const match = out.match(/git\s+version\s+([0-9.]+)/i)
        if (match) {
          return { status: 'available', version: match[1] }
        }
        return { status: 'available', version: out.replace(/git version\s+/i, '') || 'vX' }
      }
    } catch {
      // Failed
    }
    return { status: 'not-installed', version: '' }
  }, [])

  // Run all active detections with loading feedback
  const detectAllTools = useCallback(async () => {
    setTools({
      python: { status: 'checking', version: '' },
      node: { status: 'checking', version: '' },
      git: { status: 'checking', version: '' },
    })

    const [pyRes, nodeRes, gitRes] = await Promise.all([
      detectPython(),
      detectNode(),
      detectGit(),
    ])

    setTools({
      python: pyRes,
      node: nodeRes,
      git: gitRes,
    })
  }, [detectPython, detectNode, detectGit])

  // Silent background verification routine (reduces friction - auto resolves once installed)
  const verifyMissingToolsSilently = useCallback(async () => {
    const pyPromise = detectPython()
    const nodePromise = detectNode()
    const gitPromise = detectGit()

    const [pyRes, nodeRes, gitRes] = await Promise.all([
      pyPromise,
      nodePromise,
      gitPromise,
    ])

    setTools((prev) => {
      const updated = { ...prev }
      let updatedAny = false

      // Python silent update
      if (pyRes.status === 'available' && prev.python.status !== 'available') {
        updated.python = pyRes
        updatedAny = true
      } else if (pyRes.status === 'not-installed' && prev.python.status === 'checking') {
        updated.python = pyRes
        updatedAny = true
      }

      // Node silent update
      if (nodeRes.status === 'available' && prev.node.status !== 'available') {
        updated.node = nodeRes
        updatedAny = true
      } else if (nodeRes.status === 'not-installed' && prev.node.status === 'checking') {
        updated.node = nodeRes
        updatedAny = true
      }

      // Git silent update
      if (gitRes.status === 'available' && prev.git.status !== 'available') {
        updated.git = gitRes
        updatedAny = true
      } else if (gitRes.status === 'not-installed' && prev.git.status === 'checking') {
        updated.git = gitRes
        updatedAny = true
      }

      return updatedAny ? updated : prev
    })
  }, [detectPython, detectNode, detectGit])

  // Initial detection on mount
  useEffect(() => {
    detectAllTools()
  }, [detectAllTools])

  // Setup periodic silent auto-detection interval
  useEffect(() => {
    const interval = setInterval(() => {
      // Don't poll if everything is already detected/available
      const isAllReady = Object.values(tools).every(
        (t) => t.status === 'available' || t.status === 'installed'
      )
      if (!isAllReady) {
        verifyMissingToolsSilently()
      }
    }, 4000)

    return () => clearInterval(interval)
  }, [tools, verifyMissingToolsSilently])

  // Get low-friction direct download links based on current OS
  const getDownloadUrl = useCallback((toolId: ToolId): string => {
    if (IS_WINDOWS) {
      return WINDOWS_DOWNLOAD_LINKS[toolId]
    } else if (IS_MAC) {
      switch (toolId) {
        case 'python':
          return 'https://www.python.org/ftp/python/3.12.3/python-3.12.3-macos11.pkg'
        case 'node':
          return 'https://nodejs.org/dist/v20.13.1/node-v20.13.1.pkg'
        case 'git':
          return 'https://sourceforge.net/projects/git-osx-installer/files/latest/download'
      }
    } else {
      // Linux
      switch (toolId) {
        case 'python':
          return 'https://docs.python-guide.org/starting/install3/linux/'
        case 'node':
          return 'https://nodejs.org/en/download/package-manager'
        case 'git':
          return 'https://git-scm.com/download/linux'
      }
    }
  }, [])

  // Get CLI Commands for terminal option
  const getManualCommand = useCallback((toolId: ToolId): string => {
    if (IS_WINDOWS) {
      switch (toolId) {
        case 'python':
          return 'winget install Python.Python.3.12'
        case 'node':
          return 'winget install OpenJS.NodeJS.LTS'
        case 'git':
          return 'winget install Git.Git'
      }
    } else if (IS_MAC) {
      switch (toolId) {
        case 'python':
          return 'brew install python'
        case 'node':
          return 'brew install node'
        case 'git':
          return 'brew install git'
      }
    } else {
      switch (toolId) {
        case 'python':
          return 'sudo apt update && sudo apt install -y python3'
        case 'node':
          return 'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs'
        case 'git':
          return 'sudo apt update && sudo apt install -y git'
      }
    }
  }, [])

  // Trigger automated link open (instantly starts download)
  const handleDownload = useCallback(async (toolId: ToolId) => {
    const url = getDownloadUrl(toolId)
    setTools((prev) => ({
      ...prev,
      [toolId]: { ...prev[toolId], status: 'waiting-install' },
    }))

    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
    } catch {
      window.open(url, '_blank')
    }
  }, [getDownloadUrl])

  // ── Windows one-click install ──────────────────────────────────────────────
  // Listen to the backend's live progress events and reflect them on the card.
  // Terminal phases (done/error) are handled by the invoke() result below, so
  // we only mirror the intermediate phases here.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<{ tool: ToolId; phase: string; percent: number | null; message: string | null }>(
      'tool-install-progress',
      (event) => {
        const { tool, phase, percent } = event.payload
        setTools((prev) => {
          if (!prev[tool]) return prev
          if (phase === 'done' || phase === 'error') return prev
          return {
            ...prev,
            [tool]: {
              ...prev[tool],
              status: 'installing',
              phase,
              percent: phase === 'downloading' ? percent ?? prev[tool].percent : undefined,
            },
          }
        })
      }
    ).then((fn) => { unlisten = fn })
    return () => { if (unlisten) unlisten() }
  }, [])

  // Runs the in-app installer (download + silent install + PATH refresh) in Rust,
  // then re-detects to capture the version. On failure, falls back to the manual
  // panel (step-by-step + terminal command) that already exists below.
  const handleInstall = useCallback(async (toolId: ToolId) => {
    const url = getDownloadUrl(toolId)
    setTools((prev) => ({
      ...prev,
      [toolId]: { ...prev[toolId], status: 'installing', phase: 'winget', percent: undefined, error: undefined },
    }))

    try {
      const res = await invoke<{ success: boolean; method: string; message: string }>('install_dev_tool', {
        toolId,
        downloadUrl: url,
      })

      if (res.success) {
        // Backend already refreshed the process PATH and verified with `where`.
        // Re-detect to surface the actual version on the card.
        const detectors: Record<ToolId, () => Promise<ToolState>> = {
          python: detectPython,
          node: detectNode,
          git: detectGit,
        }
        const fresh = await detectors[toolId]()
        setTools((prev) => ({
          ...prev,
          [toolId]: fresh.status === 'available' ? fresh : { status: 'available', version: '' },
        }))
      } else {
        setTools((prev) => ({
          ...prev,
          [toolId]: { ...prev[toolId], status: 'install-error', error: res.message },
        }))
      }
    } catch (err) {
      setTools((prev) => ({
        ...prev,
        [toolId]: { ...prev[toolId], status: 'install-error', error: String(err) },
      }))
    }
  }, [getDownloadUrl, detectPython, detectNode, detectGit])

  // Install every still-missing tool, one at a time so the UAC prompts don't stack.
  const handleInstallAll = useCallback(async () => {
    const missing = (Object.keys(tools) as ToolId[]).filter((id) => {
      const s = tools[id].status
      return s === 'not-installed' || s === 'install-error'
    })
    for (const id of missing) {
      await handleInstall(id)
    }
  }, [tools, handleInstall])

  // The primary card action: native install on Windows, browser download elsewhere.
  const handlePrimaryAction = useCallback((toolId: ToolId) => {
    if (IS_WINDOWS) return handleInstall(toolId)
    return handleDownload(toolId)
  }, [handleInstall, handleDownload])

  // Copy command helpers
  const handleCopyCommand = useCallback((toolId: ToolId, command: string) => {
    navigator.clipboard.writeText(command)
    setCopiedStatus((prev) => ({ ...prev, [toolId]: true }))
    setTimeout(() => {
      setCopiedStatus((prev) => ({ ...prev, [toolId]: false }))
    }, 2000)
  }, [])

  const availableCount = Object.values(tools).filter(
    (t) => t.status === 'available' || t.status === 'installed'
  ).length
  const progressPercent = (availableCount / 3) * 100
  const isReady = availableCount === 3
  const isCheckingAny = Object.values(tools).some((t) => t.status === 'checking')
  const anyInstalling = Object.values(tools).some((t) => t.status === 'installing')
  const hasMissing = Object.values(tools).some(
    (t) => t.status === 'not-installed' || t.status === 'install-error'
  )

  const toolDetails = [
    {
      id: 'python' as ToolId,
      name: 'Python 3',
      desc: t('onboarding.tools.benefit1'),
      icon: FiTerminal,
      instructions: IS_WINDOWS
        ? [
            'Abra o instalador descarregado.',
            'Marque obrigatoriamente a opção "Add Python.exe to PATH" antes de instalar.',
            'Clique em "Install Now" e conclua o instalador.',
          ]
        : [
            'Abra o instalador de pacotes (.pkg) descarregado.',
            'Siga o assistente de instalação padrão clicando em Continuar.',
            'Introduza a palavra-passe do sistema, caso seja solicitado, para concluir.',
          ],
    },
    {
      id: 'node' as ToolId,
      name: 'Node.js',
      desc: t('onboarding.tools.benefit2'),
      icon: FiLayers,
      instructions: IS_WINDOWS
        ? [
            'Execute o instalador de pacotes (.msi) descarregado.',
            'Avance com as opções padrão clicando em "Next".',
            'Garanta que a opção "Add to PATH" está activa (activa por defeito) e finalize.',
          ]
        : [
            'Abra o instalador (.pkg) descarregado.',
            'Prossiga com o assistente padrão clicando em Continuar.',
            'Introduza os seus dados administrativos para concluir o processo.',
          ],
    },
    {
      id: 'git' as ToolId,
      name: 'Git',
      desc: t('onboarding.tools.benefit3'),
      icon: FiGitBranch,
      instructions: IS_WINDOWS
        ? [
            'Abra o instalador (.exe) descarregado do Git.',
            'Avance pelas opções padrão (as opções padrão são optimizadas e seguras).',
            'Clique em "Install" e aguarde a finalização.',
          ]
        : [
            'Abra o arquivo descarregado (.dmg ou .pkg).',
            'Se bloqueado pela Apple por segurança, clique com o botão direito no instalador e seleccione "Abrir".',
            'Siga o assistente e conclua o processo de instalação.',
          ],
    },
  ]

  return (
    <Flex direction="column" align="center" textAlign="center" width="100%" maxW="600px" px={4}>
      {/* Title */}
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        style={{ marginBottom: '8px' }}
      >
        <Text fontSize="24px" fontWeight="700" letterSpacing="-0.3px" lineHeight="1.3">
          {t('onboarding.tools.title')}
        </Text>
      </motion.div>

      {/* Subtitle */}
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.14 }}
        style={{ marginBottom: '24px' }}
      >
        <Text fontSize="13px" color={tokens.colors.text.secondary} maxW="450px" lineHeight="1.4">
          {t('onboarding.tools.subtitle')}
        </Text>
      </motion.div>

      {/* Progress Bar Header */}
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.18 }}
        style={{ width: '100%', marginBottom: '20px' }}
      >
        <Box w="100%" px={1}>
          <Flex justify="space-between" align="center" mb={2}>
            <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.secondary}>
              Progresso da Configuração
            </Text>
            <Text
              fontSize="12px"
              fontWeight="700"
              color={isReady ? '#4ADE80' : tokens.colors.accent.primary}
              transition={`color ${tokens.transition.normal}`}
            >
              {availableCount} de 3 detectados
            </Text>
          </Flex>
          {/* Progress Track */}
          <Box w="100%" h="6px" bg="rgba(255, 255, 255, 0.04)" borderRadius="full" overflow="hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
              style={{
                height: '100%',
                background: isReady ? tokens.gradient.accentGreen : tokens.gradient.accentPrimary,
                borderRadius: 'full',
                boxShadow: isReady
                  ? '0 0 10px rgba(74, 222, 128, 0.3)'
                  : '0 0 10px rgba(254, 16, 99, 0.3)',
              }}
            />
          </Box>
        </Box>
      </motion.div>

      {/* Tools Status List Header */}
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        style={{ width: '100%', marginBottom: '12px' }}
      >
        <Flex justify="space-between" align="center" w="100%" px={1}>
          <Text fontSize="11px" fontWeight="700" textTransform="uppercase" letterSpacing="0.05em" color={tokens.colors.text.muted}>
            Ferramentas Requeridas
          </Text>
          <Flex align="center" gap={3}>
            {/* One-click "install everything" — Windows only */}
            {IS_WINDOWS && hasMissing && (
              <button
                type="button"
                className="ob-option"
                onClick={handleInstallAll}
                disabled={anyInstalling}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 12px',
                  borderRadius: '8px',
                  border: `1px solid ${tokens.colors.accent.primaryBorder}`,
                  background: tokens.colors.accent.primarySubtle,
                  cursor: anyInstalling ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  color: tokens.colors.accent.primary,
                  fontSize: '11px',
                  fontWeight: 600,
                  opacity: anyInstalling ? 0.5 : 1,
                  transition: `all ${tokens.transition.normal}`,
                }}
              >
                <FiZap size={12} />
                {anyInstalling ? 'A instalar…' : 'Instalar tudo'}
              </button>
            )}
            <button
              type="button"
              onClick={detectAllTools}
              disabled={isCheckingAny}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: isCheckingAny ? 'not-allowed' : 'pointer',
                fontSize: '11px',
                fontWeight: 600,
                color: tokens.colors.accent.primary,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                opacity: isCheckingAny ? 0.5 : 1,
                transition: `all ${tokens.transition.normal}`,
              }}
            >
              <FiZap
                size={12}
                style={{
                  transform: isCheckingAny ? 'rotate(360deg)' : 'none',
                  transition: isCheckingAny ? 'transform 1s linear infinite' : 'transform 0.3s ease',
                }}
              />
              {t('onboarding.tools.redetect')}
            </button>
          </Flex>
        </Flex>
      </motion.div>

      {/* Vertical list of Tools Cards */}
      <div style={{ width: '100%', marginBottom: '24px' }}>
        <Flex direction="column" gap={3.5}>
          {toolDetails.map(({ id, name, desc, icon: Icon, instructions }, index) => {
            const toolState = tools[id]
            const isMissing = toolState.status === 'not-installed'
            const isWaiting = toolState.status === 'waiting-install'
            const isInstalling = toolState.status === 'installing'
            const isInstallError = toolState.status === 'install-error'
            const isAvailable = toolState.status === 'available' || toolState.status === 'installed'
            const manualCommand = getManualCommand(id)
            // The step-by-step + terminal fallback panel: on macOS/Linux it appears
            // after the browser download starts; on Windows only if the one-click
            // install failed.
            const showManualPanel = isWaiting || isInstallError

            return (
              <motion.div
                key={id}
                initial={{ x: -20, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ delay: 0.2 + index * 0.08 }}
                style={{ width: '100%' }}
              >
                <Flex
                  direction="column"
                  w="100%"
                  px={5}
                  py={4}
                  borderRadius="16px"
                  bg={
                    isAvailable
                      ? 'rgba(74, 222, 128, 0.015)'
                      : isWaiting
                      ? 'rgba(254, 16, 99, 0.02)'
                      : 'rgba(255, 255, 255, 0.015)'
                  }
                  border="1px solid"
                  borderColor={
                    isAvailable
                      ? 'rgba(74, 222, 128, 0.15)'
                      : isWaiting
                      ? `${tokens.colors.accent.primary}35`
                      : 'rgba(255, 255, 255, 0.05)'
                  }
                  boxShadow={
                    isAvailable
                      ? '0 4px 20px rgba(74, 222, 128, 0.02), inset 0 1px 0 rgba(255, 255, 255, 0.02)'
                      : isWaiting
                      ? `0 4px 24px rgba(254, 16, 99, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.02)`
                      : 'inset 0 1px 0 rgba(255, 255, 255, 0.01)'
                  }
                  _hover={{
                    bg: isAvailable
                      ? 'rgba(74, 222, 128, 0.02)'
                      : isWaiting
                      ? 'rgba(254, 16, 99, 0.03)'
                      : 'rgba(255, 255, 255, 0.03)',
                    borderColor: isAvailable
                      ? 'rgba(74, 222, 128, 0.3)'
                      : isWaiting
                      ? `${tokens.colors.accent.primary}50`
                      : 'rgba(255, 255, 255, 0.1)',
                    transform: 'translateY(-1px)',
                    boxShadow: isAvailable
                      ? '0 6px 24px rgba(74, 222, 128, 0.04)'
                      : isWaiting
                      ? '0 6px 28px rgba(254, 16, 99, 0.06)'
                      : '0 4px 16px rgba(0, 0, 0, 0.15)'
                  }}
                  transition={`all ${tokens.transition.normal}`}
                  gap={3}
                >
                  <Flex
                    direction={{ base: 'column', sm: 'row' }}
                    align={{ base: 'flex-start', sm: 'center' }}
                    justify="space-between"
                    gap={3}
                    w="100%"
                  >
                    {/* Left: Icon and details */}
                    <Flex align="center" gap={3.5} flex={1}>
                      <Flex
                        w="42px"
                        h="42px"
                        borderRadius="12px"
                        bg={
                          isAvailable
                            ? 'rgba(74, 222, 128, 0.08)'
                            : isWaiting
                            ? 'rgba(254, 16, 99, 0.08)'
                            : tokens.colors.accent.primarySubtle
                        }
                        align="center"
                        justify="center"
                        flexShrink={0}
                        boxShadow={
                          isAvailable
                            ? '0 4px 12px rgba(74, 222, 128, 0.1)'
                            : isWaiting
                            ? '0 4px 12px rgba(254, 16, 99, 0.1)'
                            : 'none'
                        }
                        transition={`all ${tokens.transition.normal}`}
                      >
                        <Icon
                          size={18}
                          color={
                            isAvailable
                              ? '#4ADE80'
                              : tokens.colors.accent.primary
                          }
                        />
                      </Flex>
                      <Flex direction="column" align="left" textAlign="left">
                        <Text fontSize="14px" fontWeight="600" color={tokens.colors.text.primary}>
                          {name}
                        </Text>
                        <Text fontSize="11.5px" color={tokens.colors.text.secondary} maxW="330px" lineHeight="1.3">
                          {desc}
                        </Text>
                      </Flex>
                    </Flex>

                    {/* Right: Status and Download Button */}
                    <Flex
                      align="center"
                      gap={3.5}
                      justify={{ base: 'space-between', sm: 'flex-end' }}
                      w={{ base: '100%', sm: 'auto' }}
                      flexShrink={0}
                    >
                      {/* Status Indicator */}
                      <Flex align="center" gap={2}>
                        {toolState.status === 'checking' && (
                          <>
                            <Box
                              w="8px"
                              h="8px"
                              borderRadius="full"
                              bg={tokens.colors.accent.orange}
                              css={{
                                animation: 'pulse-checking 1.5s ease-in-out infinite',
                                '@keyframes pulse-checking': {
                                  '0%, 100%': { opacity: 1 },
                                  '50%': { opacity: 0.3 },
                                },
                              }}
                            />
                            <Text fontSize="12px" color={tokens.colors.text.muted}>
                              A verificar...
                            </Text>
                          </>
                        )}
                        {isAvailable && (
                          <Flex
                            align="center"
                            gap={1.5}
                            px={2.5}
                            py={1}
                            bg="rgba(74, 222, 128, 0.08)"
                            border="1px solid rgba(74, 222, 128, 0.15)"
                            borderRadius="full"
                          >
                            <Box w="6px" h="6px" borderRadius="full" bg="#4ADE80" />
                            <Text fontSize="11.5px" color="#4ADE80" fontWeight="600">
                              {toolState.version ? `${toolState.version} ` : ''}
                              {t('onboarding.tools.detected')}
                            </Text>
                          </Flex>
                        )}
                        {isMissing && (
                          <Flex
                            align="center"
                            gap={1.5}
                            px={2.5}
                            py={1}
                            bg="rgba(255, 255, 255, 0.03)"
                            border="1px solid rgba(255, 255, 255, 0.05)"
                            borderRadius="full"
                          >
                            <Box w="6px" h="6px" borderRadius="full" bg={tokens.colors.text.disabled} />
                            <Text fontSize="11.5px" color={tokens.colors.text.muted}>
                              {t('onboarding.tools.notInstalled')}
                            </Text>
                          </Flex>
                        )}
                        {isWaiting && (
                          <Flex
                            align="center"
                            gap={1.5}
                            px={2.5}
                            py={1}
                            bg="rgba(247, 127, 0, 0.08)"
                            border="1px solid rgba(247, 127, 0, 0.15)"
                            borderRadius="full"
                          >
                            <Box
                              w="6px"
                              h="6px"
                              borderRadius="full"
                              bg={tokens.colors.accent.orange}
                              css={{
                                animation: 'pulse-waiting 1.2s ease-in-out infinite',
                                '@keyframes pulse-waiting': {
                                  '0%, 100%': { opacity: 1, transform: 'scale(1)' },
                                  '50%': { opacity: 0.4, transform: 'scale(1.2)' },
                                },
                              }}
                            />
                            <Text fontSize="11.5px" color={tokens.colors.accent.orange} fontWeight="600">
                              Instalação pendente...
                            </Text>
                          </Flex>
                        )}
                        {isInstalling && (
                          <Flex
                            align="center"
                            gap={1.5}
                            px={2.5}
                            py={1}
                            bg="rgba(247, 127, 0, 0.08)"
                            border="1px solid rgba(247, 127, 0, 0.15)"
                            borderRadius="full"
                          >
                            <Box
                              w="6px"
                              h="6px"
                              borderRadius="full"
                              bg={tokens.colors.accent.orange}
                              css={{
                                animation: 'pulse-waiting 1.2s ease-in-out infinite',
                                '@keyframes pulse-waiting': {
                                  '0%, 100%': { opacity: 1, transform: 'scale(1)' },
                                  '50%': { opacity: 0.4, transform: 'scale(1.2)' },
                                },
                              }}
                            />
                            <Text fontSize="11.5px" color={tokens.colors.accent.orange} fontWeight="600">
                              {toolState.phase === 'downloading' && toolState.percent != null
                                ? `A descarregar… ${Math.round(toolState.percent)}%`
                                : PHASE_LABELS[toolState.phase || ''] || 'A instalar…'}
                            </Text>
                          </Flex>
                        )}
                        {isInstallError && (
                          <Flex
                            align="center"
                            gap={1.5}
                            px={2.5}
                            py={1}
                            bg="rgba(239, 68, 68, 0.06)"
                            border="1px solid rgba(239, 68, 68, 0.15)"
                            borderRadius="full"
                          >
                            <FiAlertTriangle size={11} color={tokens.colors.accent.red} />
                            <Text fontSize="11.5px" color={tokens.colors.accent.red} fontWeight="600">
                              Falhou
                            </Text>
                          </Flex>
                        )}
                      </Flex>

                      {/* Primary action button — native install (Windows) or
                          browser download (macOS/Linux). Hidden while installing. */}
                      {!isAvailable && !isInstalling && (
                        <button
                          type="button"
                          className="ob-option"
                          onClick={() => handlePrimaryAction(id)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '8px 16px',
                            borderRadius: '10px',
                            border: `1px solid ${
                              isWaiting
                                ? `${tokens.colors.accent.orange}40`
                                : tokens.colors.accent.primaryBorder
                            }`,
                            background: isWaiting
                              ? 'rgba(247, 127, 0, 0.06)'
                              : tokens.colors.accent.primarySubtle,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            color: isWaiting
                              ? tokens.colors.accent.orange
                              : tokens.colors.accent.primary,
                            fontSize: '12px',
                            fontWeight: 600,
                            transition: `all ${tokens.transition.normal}`,
                            boxShadow: isWaiting
                              ? 'none'
                              : '0 2px 8px rgba(254, 16, 99, 0.15)',
                          }}
                        >
                          {IS_WINDOWS ? <FiZap size={13} /> : <FiDownload size={13} />}
                          {IS_WINDOWS
                            ? (isInstallError ? 'Tentar de novo' : 'Instalar')
                            : (isWaiting ? 'Baixar Novamente' : 'Baixar')}
                        </button>
                      )}
                    </Flex>
                  </Flex>

                  {/* Step-by-step Interactive Assistance Panel */}
                  {showManualPanel && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      style={{
                        marginTop: '8px',
                        padding: '14px 16px',
                        borderRadius: '12px',
                        background: 'rgba(0, 0, 0, 0.15)',
                        border: '1px solid rgba(255, 255, 255, 0.03)',
                        textAlign: 'left',
                        overflow: 'hidden',
                      }}
                    >
                      <Flex align="flex-start" gap={3} mb={3.5}>
                        <Box mt="2px" flexShrink={0}>
                          {isInstallError ? (
                            <FiAlertTriangle size={15} color={tokens.colors.accent.red} />
                          ) : (
                            <FiCheckCircle size={15} color="#4ADE80" style={{ filter: 'drop-shadow(0 0 4px rgba(74, 222, 128, 0.2))' }} />
                          )}
                        </Box>
                        <Box>
                          <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary} mb={0.5}>
                            {isInstallError
                              ? 'A instalação automática não foi concluída. Instale manualmente:'
                              : 'Download Iniciado! Siga os Passos para Instalar:'}
                          </Text>
                          <Text fontSize="11px" color={tokens.colors.text.secondary} lineHeight="1.4">
                            {isInstallError
                              ? (toolState.error || 'Pode usar o instalador oficial ou o comando abaixo. O TM Code detecta automaticamente assim que terminar.')
                              : 'O assistente oficial foi descarregado. Prossiga com a instalação local e o assistente de segundo plano do TM Code irá detectar automaticamente em instantes.'}
                          </Text>
                        </Box>
                      </Flex>

                      {/* Numbered Step Checklist */}
                      <Flex direction="column" gap={2} mb={3.5} pl={1}>
                        {instructions.map((step, idx) => (
                          <Flex key={idx} align="flex-start" gap={2.5}>
                            <Flex
                              w="16px"
                              h="16px"
                              borderRadius="full"
                              bg="rgba(254, 16, 99, 0.12)"
                              border="1px solid rgba(254, 16, 99, 0.25)"
                              align="center"
                              justify="center"
                              flexShrink={0}
                              mt="2px"
                            >
                              <Text fontSize="9px" fontWeight="700" color={tokens.colors.accent.primary}>
                                {idx + 1}
                              </Text>
                            </Flex>
                            <Text fontSize="11px" color={tokens.colors.text.secondary} lineHeight="1.4">
                              {step}
                            </Text>
                          </Flex>
                        ))}
                      </Flex>

                      {/* Direct Terminal Command Alternative */}
                      <Box pt={3} borderTop="1px solid rgba(255, 255, 255, 0.05)">
                        <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} mb={2}>
                          Alternativa para Programadores (Consola/Terminal):
                        </Text>
                        
                        {/* Terminal Box UI */}
                        <Box
                          bg="#080808"
                          borderRadius="10px"
                          border="1px solid rgba(255, 255, 255, 0.05)"
                          overflow="hidden"
                          width="100%"
                        >
                          {/* Terminal Header */}
                          <Flex
                            align="center"
                            justify="space-between"
                            bg="#111"
                            px={3}
                            py={1.5}
                            borderBottom="1px solid rgba(255, 255, 255, 0.04)"
                          >
                            <Flex gap={1.5}>
                              <Box w="8px" h="8px" borderRadius="full" bg="#ff5f56" />
                              <Box w="8px" h="8px" borderRadius="full" bg="#ffbd2e" />
                              <Box w="8px" h="8px" borderRadius="full" bg="#27c93f" />
                            </Flex>
                            <Text fontSize="10px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.text.muted}>
                              {IS_WINDOWS ? 'PowerShell' : 'zsh'}
                            </Text>
                            <Box w="30px" />
                          </Flex>

                          {/* Terminal Body */}
                          <Flex align="center" justify="space-between" px={3} py={2} gap={2}>
                            <Text
                              fontSize="11px"
                              fontFamily={tokens.fontFamily.mono}
                              color="#4ADE80"
                              textAlign="left"
                              whiteSpace="nowrap"
                              overflow="hidden"
                              textOverflow="ellipsis"
                              flex={1}
                            >
                              <Text as="span" color={tokens.colors.accent.primary} mr={1.5}>
                                $
                              </Text>
                              {manualCommand}
                            </Text>

                            <button
                              type="button"
                              onClick={() => handleCopyCommand(id, manualCommand)}
                              style={{
                                background: 'rgba(255, 255, 255, 0.04)',
                                border: '1px solid rgba(255, 255, 255, 0.08)',
                                borderRadius: '6px',
                                padding: '5px 10px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px',
                                color: copiedStatus[id] ? '#4ADE80' : tokens.colors.text.primary,
                                fontSize: '10.5px',
                                fontWeight: 600,
                                transition: 'all 0.15s ease',
                              }}
                            >
                              {copiedStatus[id] ? (
                                <>
                                  <FiCheck size={11} />
                                  Copiado!
                                </>
                              ) : (
                                <>
                                  <FiCopy size={11} />
                                  Copiar
                                </>
                              )}
                            </button>
                          </Flex>
                        </Box>
                      </Box>
                    </motion.div>
                  )}
                </Flex>
              </motion.div>
            )
          })}
        </Flex>
      </div>

      {/* Blocking Warning message if not ready */}
      {!isReady && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          style={{ width: '100%', marginBottom: '24px' }}
        >
          <Flex
            align="center"
            gap={2.5}
            px={4}
            py={3.2}
            borderRadius="12px"
            bg="rgba(239, 68, 68, 0.04)"
            border="1px solid rgba(239, 68, 68, 0.12)"
            justify="center"
            boxShadow="0 4px 12px rgba(239, 68, 68, 0.02)"
          >
            <FiShield size={14} color={tokens.colors.accent.red} />
            <Text fontSize="12px" color={tokens.colors.accent.red} fontWeight="600" textAlign="left" letterSpacing="-0.1px">
              {t('onboarding.tools.blockingWarning')}
            </Text>
          </Flex>
        </motion.div>
      )}

      {/* Onboarding Nav Panel */}
      <OnboardingNav
        onBack={onBack}
        onNext={onNext}
        backLabel={t('onboarding.back')}
        nextLabel={t('onboarding.continue')}
        nextDisabled={!isReady}
        delay={0.35}
      />
    </Flex>
  )
}

export default ToolsStep
