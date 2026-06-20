import React, { useState, useCallback, useRef, useEffect } from 'react'
import {
  Box,
  Button,
  Flex,
  Heading,
  Text,
  Dialog,
  Portal,
  Input,
  VStack,
} from '@chakra-ui/react'
import {
  LuGitBranch,
  LuFolderOpen,
  LuLoader,
  LuCheck,
  LuCircleAlert,
  LuGithub,
  LuExternalLink,
  LuCopy,
} from 'react-icons/lu'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@/utils/invokeMetrics'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { VITE_GITHUB_CLIENT_ID } from '@/utils/viteEnv'
import {
  githubTokenStatus,
  githubAccount,
  githubDisconnect,
  githubDeviceStart,
  pollDeviceFlow,
  type DeviceCode,
} from '@/services/githubAuth'

type CloneStatus = 'idle' | 'cloning' | 'success' | 'error' | 'needsAuth'

const GIT_URL_REGEX = /^(https?:\/\/.+\.git|git@.+:.+\.git|https?:\/\/(github|gitlab|bitbucket)\..+\/.+\/.+)$/i

function extractRepoName(url: string): string {
  const match = url.match(/\/([^/]+?)(?:\.git)?$/)
  return match?.[1] || ''
}

function isValidGitUrl(url: string): boolean {
  if (!url.trim()) return false
  return GIT_URL_REGEX.test(url.trim()) || url.includes('github.com/') || url.includes('gitlab.com/')
}

function isGitHubHttpsUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\//i.test(url.trim())
}

/**
 * Does this clone failure look like a missing/invalid credential? GitHub masks
 * private repos you can't see as "Repository not found" (404) to avoid leaking
 * their existence, so that string counts as auth too.
 */
function looksLikeAuthError(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return (
    s.includes('could not read username') ||
    s.includes('authentication failed') ||
    s.includes('terminal prompts disabled') ||
    s.includes('repository not found') ||
    s.includes('403 forbidden') ||
    (s.includes('fatal: unable to access') && s.includes('403'))
  )
}

function lastMeaningfulLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || ''
}

/** Text before the first colon — used to collapse repeated "Receiving objects: N%" ticks. */
function progressPrefix(line: string): string {
  const idx = line.indexOf(':')
  return idx > 0 ? line.slice(0, idx) : line
}

function joinPath(base: string, child: string): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${sep}${child}`
}

function replaceLastPathSegment(path: string, segment: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx < 0) return path
  return `${path.slice(0, idx + 1)}${segment}`
}

const inputStyles = {
  bg: 'rgba(255, 255, 255, 0.04)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: '10px',
  color: tokens.colors.text.primary,
  fontSize: '13px',
  height: '40px',
  _placeholder: { color: tokens.colors.text.disabled },
  _focus: {
    borderColor: `${tokens.colors.accent.purple}90`,
    boxShadow: `0 0 0 1px ${tokens.colors.accent.purple}30`,
    bg: 'rgba(255, 255, 255, 0.06)',
  },
  transition: 'all 0.2s ease',
}

interface CloneDialogProps {
  dialog: ReturnType<typeof import('@chakra-ui/react').useDialog>
  onCloned?: (projectPath: string) => void
  /**
   * Reports whether a clone is in flight. The parent wires this into the
   * dialog machine (closeOnEscape / closeOnInteractOutside) so the dialog
   * can't be dismissed mid-clone — there's no way to cancel an in-progress
   * git clone, and tearing the dialog down would orphan the operation and
   * leave a half-written destination directory.
   */
  onBusyChange?: (busy: boolean) => void
}

const CloneDialog: React.FC<CloneDialogProps> = ({ dialog, onCloned, onBusyChange }) => {
  const [repoUrl, setRepoUrl] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [branch, setBranch] = useState('')
  const [status, setStatus] = useState<CloneStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [progressLines, setProgressLines] = useState<string[]>([])

  // GitHub connection state
  const [githubConnected, setGithubConnected] = useState(false)
  const [githubLogin, setGithubLogin] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null)
  const [connectError, setConnectError] = useState('')

  const urlInputRef = useRef<HTMLInputElement>(null)
  const progressBoxRef = useRef<HTMLDivElement>(null)
  // Cancellation token shared with the in-flight device-flow poll loop.
  const cancelRef = useRef<{ cancelled: boolean } | null>(null)
  // Set when a clone stalled on auth, so a successful connect resumes it.
  const autoCloneRef = useRef(false)

  const repoName = extractRepoName(repoUrl)
  const isUrlValid = isValidGitUrl(repoUrl)
  const canClone = isUrlValid && localPath.trim().length > 0 && status !== 'cloning' && !connecting
  const purpleAccent = tokens.colors.accent.purple
  const latestLine = progressLines.length ? progressLines[progressLines.length - 1] : ''

  // Focus URL input on open + check GitHub connection; reset everything on close.
  useEffect(() => {
    if (dialog.open) {
      setTimeout(() => urlInputRef.current?.focus(), 100)
      githubTokenStatus()
        .then((connected) => {
          setGithubConnected(connected)
          if (connected) githubAccount().then(setGithubLogin).catch(() => {})
        })
        .catch(() => setGithubConnected(false))
    } else {
      // Stop any in-flight device-flow poll so it doesn't resolve into a closed dialog.
      if (cancelRef.current) cancelRef.current.cancelled = true
      autoCloneRef.current = false
      setRepoUrl('')
      setLocalPath('')
      setBranch('')
      setStatus('idle')
      setErrorMsg('')
      setProgressLines([])
      setConnecting(false)
      setDeviceCode(null)
      setConnectError('')
      setGithubLogin(null)
    }
  }, [dialog.open])

  // Auto-fill repo name into path
  useEffect(() => {
    if (repoName && localPath && !localPath.endsWith(repoName)) {
      const next = replaceLastPathSegment(localPath, repoName)
      if (next !== localPath) {
        setLocalPath(next)
      }
    }
  }, [repoName])

  // Keep the progress log scrolled to the newest line.
  useEffect(() => {
    const el = progressBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [progressLines])

  // Lock the dialog closed while a clone is running — the parent turns the
  // escape key and outside-click off based on this. Resets on unmount so a
  // teardown can never leave the dialog permanently un-closable.
  const isCloning = status === 'cloning'
  useEffect(() => {
    onBusyChange?.(isCloning)
    return () => { onBusyChange?.(false) }
  }, [isCloning, onBusyChange])

  const handleBrowse = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('clone.browseTitle'),
      })
      if (selected) {
        const name = repoName || 'project'
        setLocalPath(joinPath(selected as string, name))
      }
    } catch { /* user cancelled */ }
  }, [repoName])

  const handleClone = useCallback(async () => {
    if (!isValidGitUrl(repoUrl) || !localPath.trim()) return

    setStatus('cloning')
    setErrorMsg('')
    setProgressLines([])

    const progressId = crypto.randomUUID()
    let unlisten: UnlistenFn | null = null

    try {
      // Stream git's --progress output (stderr) line-by-line. Repeated percentage
      // ticks that share a "label:" prefix update in place instead of stacking.
      unlisten = await listen<{ line: string }>(`git-clone-progress-${progressId}`, (e) => {
        const line = e.payload?.line
        if (!line) return
        setProgressLines((prev) => {
          if (prev.length) {
            const last = prev[prev.length - 1]
            if (line.includes('%') && progressPrefix(last) === progressPrefix(line)) {
              const copy = prev.slice()
              copy[copy.length - 1] = line
              return copy
            }
          }
          const next = [...prev, line]
          return next.length > 300 ? next.slice(-300) : next
        })
      })

      const result = await invoke<{ stdout: string; stderr: string; exitCode: number; success: boolean }>('git_clone_repository', {
        repoUrl: repoUrl.trim(),
        destinationPath: localPath.trim(),
        branch: branch.trim() || null,
        progressId,
      })

      if (!result.success) {
        const stderr = result.stderr || result.stdout || ''
        // A private github.com repo that we can't read → offer to connect/reconnect
        // instead of dumping a cryptic "Repository not found" at the user.
        if (isGitHubHttpsUrl(repoUrl) && looksLikeAuthError(stderr)) {
          autoCloneRef.current = true
          setStatus('needsAuth')
          return
        }
        const msg = lastMeaningfulLine(stderr) || t('clone.failed')
        setErrorMsg(msg.length > 160 ? msg.slice(0, 160) + '…' : msg)
        setStatus('error')
        return
      }

      setStatus('success')
      setTimeout(() => {
        dialog.setOpen(false)
        onCloned?.(localPath.trim())
      }, 800)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(msg.length > 160 ? msg.slice(0, 160) + '…' : msg)
      setStatus('error')
    } finally {
      unlisten?.()
    }
  }, [repoUrl, branch, localPath, dialog, onCloned])

  const openVerificationPage = useCallback(async (uri: string) => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(uri)
    } catch { /* user can click the link manually */ }
  }, [])

  const handleConnect = useCallback(async () => {
    const clientId = (VITE_GITHUB_CLIENT_ID || '').trim()
    if (!clientId) {
      setConnectError(t('clone.githubNotConfigured'))
      return
    }

    setConnectError('')
    setConnecting(true)
    const cancel = { cancelled: false }
    cancelRef.current = cancel

    try {
      const device = await githubDeviceStart(clientId)
      if (cancel.cancelled) return
      setDeviceCode(device)
      await openVerificationPage(device.verificationUri)

      const result = await pollDeviceFlow(clientId, device, cancel)
      if (cancel.cancelled) return

      if (result === 'authorized') {
        setGithubConnected(true)
        setDeviceCode(null)
        setConnecting(false)
        githubAccount().then(setGithubLogin).catch(() => {})
        // Resume a clone that was blocked waiting for authorization.
        if (autoCloneRef.current) {
          autoCloneRef.current = false
          setStatus('idle')
          setTimeout(() => { void handleClone() }, 0)
        } else if (status === 'needsAuth') {
          setStatus('idle')
        }
      } else {
        setConnecting(false)
        setDeviceCode(null)
        setConnectError(
          result === 'denied'
            ? t('clone.githubDenied')
            : result === 'expired'
              ? t('clone.githubExpired')
              : t('clone.githubConnectFailed'),
        )
      }
    } catch (err) {
      setConnecting(false)
      setDeviceCode(null)
      setConnectError(err instanceof Error ? err.message : String(err))
    }
  }, [status, handleClone, openVerificationPage])

  const cancelConnect = useCallback(() => {
    if (cancelRef.current) cancelRef.current.cancelled = true
    autoCloneRef.current = false
    setConnecting(false)
    setDeviceCode(null)
    if (status === 'needsAuth') setStatus('idle')
  }, [status])

  const handleDisconnect = useCallback(async () => {
    try { await githubDisconnect() } catch { /* ignore */ }
    setGithubConnected(false)
    setGithubLogin(null)
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canClone) {
      handleClone()
    }
  }

  const smallBtn = {
    fontSize: '11px',
    fontWeight: '600',
    height: '26px',
    px: 2.5,
    borderRadius: '7px',
    minW: 'auto',
  }

  return (
    <Dialog.RootProvider value={dialog}>
      <Portal>
        <Dialog.Backdrop bg="rgba(0, 0, 0, 0.7)" backdropFilter="blur(16px)" />
        <Dialog.Positioner display="flex" alignItems="center" justifyContent="center" h="100dvh">
          <Dialog.Content
            bg="rgba(15, 15, 15, 0.98)"
            border="1px solid rgba(163, 113, 247, 0.15)"
            borderRadius="20px"
            color={tokens.colors.text.primary}
            maxW="520px"
            w="92%"
            boxShadow={`0 32px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(163, 113, 247, 0.08), 0 0 60px -20px ${purpleAccent}15`}
            overflow="hidden"
            position="relative"
            onKeyDown={handleKeyDown}
          >
            {/* Top gradient line */}
            <Box
              position="absolute"
              top="0"
              left="0"
              right="0"
              height="2px"
              background={`linear-gradient(90deg, transparent, ${purpleAccent}, transparent)`}
              opacity={0.5}
            />

            {/* Subtle corner glow */}
            <Box
              position="absolute"
              top="-40px"
              right="-40px"
              width="120px"
              height="120px"
              bg={`radial-gradient(circle, ${purpleAccent}10 0%, transparent 70%)`}
              borderRadius="full"
              pointerEvents="none"
            />

            {/* Header */}
            <Flex align="center" gap={3} pt={7} px={7} pb={0}>
              <Flex
                width="38px"
                height="38px"
                borderRadius="11px"
                alignItems="center"
                justifyContent="center"
                bg={`${purpleAccent}12`}
                border={`1px solid ${purpleAccent}25`}
                flexShrink={0}
              >
                <LuGitBranch size={18} color={purpleAccent} />
              </Flex>
              <Box>
                <Heading fontSize="17px" fontWeight="700" color="white" lineHeight="1.2">
                  {t('clone.title')}
                </Heading>
                <Text fontSize="12px" color={tokens.colors.text.muted} mt="2px">
                  {t('clone.subtitle')}
                </Text>
              </Box>
            </Flex>

            <Dialog.CloseTrigger asChild>
              <Button
                position="absolute"
                top="18px"
                right="18px"
                bg="none"
                border="none"
                color={tokens.colors.text.disabled}
                fontSize="18px"
                cursor={isCloning ? 'not-allowed' : 'pointer'}
                p={1}
                borderRadius="8px"
                minW="auto"
                lineHeight="1"
                // Can't bail out of an in-flight clone — disable the × so the
                // only way out is letting it finish (or fail).
                disabled={isCloning}
                opacity={isCloning ? 0.3 : 1}
                _hover={isCloning ? undefined : {
                  bg: 'rgba(255, 255, 255, 0.06)',
                  color: tokens.colors.text.secondary,
                }}
                transition="all 0.15s"
              >
                &times;
              </Button>
            </Dialog.CloseTrigger>

            {/* Body */}
            <Dialog.Body px={7} py={5}>
              <VStack gap={4} align="stretch">
                {/* Repository URL */}
                <Box>
                  <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} mb="6px"
                    textTransform="uppercase" letterSpacing="0.05em">
                    {t('clone.repoUrl')}
                  </Text>
                  <Input
                    ref={urlInputRef}
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder={t('clone.repoUrlPlaceholder')}
                    {...inputStyles}
                    borderColor={repoUrl && !isUrlValid ? 'rgba(248, 81, 73, 0.4)' : inputStyles.border}
                  />
                  {repoUrl && !isUrlValid && (
                    <Text fontSize="11px" color={tokens.colors.accent.red} mt={1} opacity={0.8}>
                      {t('clone.invalidUrl')}
                    </Text>
                  )}
                </Box>

                {/* Local Path */}
                <Box>
                  <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} mb="6px"
                    textTransform="uppercase" letterSpacing="0.05em">
                    {t('clone.destination')}
                  </Text>
                  <Flex gap={2}>
                    <Input
                      flex={1}
                      value={localPath}
                      onChange={(e) => setLocalPath(e.target.value)}
                      placeholder={t('clone.destinationPlaceholder')}
                      {...inputStyles}
                    />
                    <Button
                      onClick={handleBrowse}
                      bg="rgba(255, 255, 255, 0.05)"
                      border="1px solid rgba(255, 255, 255, 0.08)"
                      borderRadius="10px"
                      color={tokens.colors.text.secondary}
                      px={3}
                      height="40px"
                      minW="auto"
                      _hover={{
                        bg: 'rgba(255, 255, 255, 0.08)',
                        borderColor: `${purpleAccent}40`,
                        color: tokens.colors.text.primary,
                      }}
                      transition="all 0.15s"
                    >
                      <LuFolderOpen size={16} />
                    </Button>
                  </Flex>
                </Box>

                {/* Branch */}
                <Box>
                  <Text fontSize="11px" fontWeight="600" color={tokens.colors.text.muted} mb="6px"
                    textTransform="uppercase" letterSpacing="0.05em">
                    {t('clone.branch')}
                    <Text as="span" fontWeight="400" textTransform="none" letterSpacing="0" ml={1} opacity={0.6}>
                      {t('clone.optional')}
                    </Text>
                  </Text>
                  <Input
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder={t('clone.branchPlaceholder')}
                    {...inputStyles}
                  />
                </Box>

                {/* GitHub connection row */}
                <Flex
                  align="center"
                  justify="space-between"
                  gap={2}
                  py={2}
                  px={3}
                  bg="rgba(255, 255, 255, 0.02)"
                  borderRadius="10px"
                  border="1px solid rgba(255, 255, 255, 0.06)"
                >
                  <Flex align="center" gap={2} minW={0}>
                    <LuGithub
                      size={15}
                      color={githubConnected ? tokens.colors.accent.green : tokens.colors.text.muted}
                    />
                    <Text
                      fontSize="12px"
                      color={tokens.colors.text.secondary}
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                    >
                      {githubConnected
                        ? (githubLogin
                            ? t('clone.githubConnectedAs').replace('{login}', githubLogin)
                            : t('clone.githubConnected'))
                        : t('clone.githubConnectHint')}
                    </Text>
                  </Flex>
                  {githubConnected ? (
                    <Button
                      {...smallBtn}
                      onClick={handleDisconnect}
                      bg="transparent"
                      color={tokens.colors.text.muted}
                      _hover={{ bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.primary }}
                    >
                      {t('clone.githubDisconnect')}
                    </Button>
                  ) : (
                    <Button
                      {...smallBtn}
                      onClick={handleConnect}
                      disabled={connecting}
                      bg="rgba(255,255,255,0.06)"
                      color={tokens.colors.text.primary}
                      flexShrink={0}
                      _hover={{ bg: 'rgba(255,255,255,0.1)' }}
                    >
                      {t('clone.githubConnect')}
                    </Button>
                  )}
                </Flex>

                {connectError && !connecting && (
                  <Text fontSize="11px" color={tokens.colors.accent.red} opacity={0.85} mt="-6px">
                    {connectError}
                  </Text>
                )}

                {/* Device-flow panel */}
                {connecting && (
                  <Flex
                    direction="column"
                    gap={2.5}
                    py={3}
                    px={3.5}
                    bg="rgba(163, 113, 247, 0.06)"
                    borderRadius="10px"
                    border="1px solid rgba(163, 113, 247, 0.12)"
                  >
                    {deviceCode ? (
                      <>
                        <Text fontSize="11px" color={tokens.colors.text.muted}>
                          {t('clone.githubEnterCode')}
                        </Text>
                        <Flex align="center" gap={2}>
                          <Text
                            fontFamily={tokens.fontFamily.mono}
                            fontSize="20px"
                            fontWeight="700"
                            letterSpacing="0.18em"
                            color="white"
                          >
                            {deviceCode.userCode}
                          </Text>
                          <Button
                            {...smallBtn}
                            title={t('clone.githubCopyCode')}
                            onClick={() => { void navigator.clipboard?.writeText(deviceCode.userCode) }}
                            bg="rgba(255,255,255,0.06)"
                            color={tokens.colors.text.secondary}
                            _hover={{ bg: 'rgba(255,255,255,0.1)', color: tokens.colors.text.primary }}
                          >
                            <LuCopy size={13} />
                          </Button>
                        </Flex>
                        <Flex align="center" gap={2}>
                          <Box css={{ animation: 'spin 1s linear infinite', '@keyframes spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } } }}>
                            <LuLoader size={13} color={purpleAccent} />
                          </Box>
                          <Text fontSize="12px" color={purpleAccent}>
                            {t('clone.githubWaiting')}
                          </Text>
                        </Flex>
                        <Flex align="center" justify="space-between" gap={2}>
                          <Button
                            onClick={() => openVerificationPage(deviceCode.verificationUri)}
                            variant="ghost"
                            fontSize="11px"
                            height="24px"
                            px={0}
                            minW="auto"
                            color={tokens.colors.text.muted}
                            _hover={{ color: tokens.colors.text.primary, bg: 'transparent' }}
                          >
                            <LuExternalLink size={12} style={{ marginRight: 4 }} />
                            {t('clone.githubOpenPage')}
                          </Button>
                          <Button
                            {...smallBtn}
                            onClick={cancelConnect}
                            bg="transparent"
                            color={tokens.colors.text.muted}
                            _hover={{ bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.primary }}
                          >
                            {t('misc.cancel')}
                          </Button>
                        </Flex>
                      </>
                    ) : (
                      <Flex align="center" gap={2}>
                        <Box css={{ animation: 'spin 1s linear infinite', '@keyframes spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } } }}>
                          <LuLoader size={13} color={purpleAccent} />
                        </Box>
                        <Text fontSize="12px" color={purpleAccent}>
                          {t('clone.githubStarting')}
                        </Text>
                      </Flex>
                    )}
                  </Flex>
                )}

                {/* Cloning + live progress output */}
                {status === 'cloning' && (
                  <Box
                    py={2}
                    px={3}
                    bg="rgba(163, 113, 247, 0.06)"
                    borderRadius="10px"
                    border="1px solid rgba(163, 113, 247, 0.1)"
                  >
                    <Flex align="center" gap={2}>
                      <Box css={{ animation: 'spin 1s linear infinite', '@keyframes spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } } }}>
                        <LuLoader size={14} color={purpleAccent} />
                      </Box>
                      <Text
                        fontSize="12px"
                        color={purpleAccent}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        {latestLine || t('clone.cloning')}
                      </Text>
                    </Flex>
                    {progressLines.length > 0 && (
                      <Box
                        ref={progressBoxRef}
                        mt={2}
                        maxH="110px"
                        overflowY="auto"
                        fontFamily={tokens.fontFamily.mono}
                        fontSize="10.5px"
                        lineHeight="1.6"
                        color={tokens.colors.text.muted}
                        whiteSpace="pre-wrap"
                        wordBreak="break-word"
                      >
                        {progressLines.join('\n')}
                      </Box>
                    )}
                  </Box>
                )}

                {status === 'success' && (
                  <Flex
                    align="center"
                    gap={2}
                    py={2}
                    px={3}
                    bg="rgba(46, 160, 67, 0.08)"
                    borderRadius="10px"
                    border="1px solid rgba(46, 160, 67, 0.15)"
                  >
                    <LuCheck size={14} color={tokens.colors.accent.green} />
                    <Text fontSize="12px" color={tokens.colors.accent.green}>
                      {t('clone.success')}
                    </Text>
                  </Flex>
                )}

                {/* Private repo needs GitHub authorization */}
                {status === 'needsAuth' && !connecting && (
                  <Flex
                    direction="column"
                    gap={2.5}
                    py={2.5}
                    px={3}
                    bg="rgba(248, 81, 73, 0.06)"
                    borderRadius="10px"
                    border="1px solid rgba(248, 81, 73, 0.12)"
                  >
                    <Flex align="flex-start" gap={2}>
                      <Box mt="1px" flexShrink={0}>
                        <LuCircleAlert size={14} color={tokens.colors.accent.red} />
                      </Box>
                      <Text fontSize="12px" color={tokens.colors.text.secondary} lineHeight="1.5">
                        {githubConnected ? t('clone.githubAuthStaleHint') : t('clone.githubAuthNeeded')}
                      </Text>
                    </Flex>
                    <Button
                      onClick={handleConnect}
                      alignSelf="flex-start"
                      background={tokens.gradient.accentPurple}
                      color="white"
                      fontSize="12px"
                      fontWeight="600"
                      height="32px"
                      px={4}
                      borderRadius="9px"
                      _hover={{ transform: 'translateY(-1px)', boxShadow: `0 8px 24px ${purpleAccent}30` }}
                    >
                      <LuGithub size={14} style={{ marginRight: 6 }} />
                      {githubConnected ? t('clone.githubReconnect') : t('clone.githubConnect')}
                    </Button>
                  </Flex>
                )}

                {status === 'error' && (
                  <Flex
                    align="flex-start"
                    gap={2}
                    py={2}
                    px={3}
                    bg="rgba(248, 81, 73, 0.06)"
                    borderRadius="10px"
                    border="1px solid rgba(248, 81, 73, 0.12)"
                  >
                    <Box mt="1px" flexShrink={0}>
                      <LuCircleAlert size={14} color={tokens.colors.accent.red} />
                    </Box>
                    <Text fontSize="12px" color={tokens.colors.accent.red} lineHeight="1.5">
                      {errorMsg || t('clone.failed')}
                    </Text>
                  </Flex>
                )}
              </VStack>
            </Dialog.Body>

            {/* Footer */}
            <Flex justify="flex-end" gap={2} px={7} pb={6} pt={0}>
              <Button
                variant="ghost"
                onClick={() => dialog.setOpen(false)}
                color={tokens.colors.text.muted}
                fontSize="13px"
                fontWeight="500"
                borderRadius="10px"
                height="36px"
                px={4}
                disabled={status === 'cloning'}
                _hover={{
                  bg: 'rgba(255, 255, 255, 0.05)',
                  color: tokens.colors.text.primary,
                }}
                transition="all 0.15s"
              >
                {t('misc.cancel')}
              </Button>
              <Button
                onClick={handleClone}
                disabled={!canClone}
                background={tokens.gradient.accentPurple}
                color="white"
                fontSize="13px"
                fontWeight="600"
                borderRadius="10px"
                height="36px"
                px={5}
                opacity={canClone ? 1 : 0.4}
                _hover={canClone ? {
                  transform: 'translateY(-1px)',
                  boxShadow: `0 8px 24px ${purpleAccent}30`,
                } : {}}
                _active={canClone ? { transform: 'scale(0.98)' } : {}}
                transition="all 0.2s ease"
              >
                {status === 'cloning' ? t('clone.buttonCloning') : t('clone.buttonClone')}
              </Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.RootProvider>
  )
}

export default CloneDialog
