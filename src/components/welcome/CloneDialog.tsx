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
import { LuGitBranch, LuFolderOpen, LuLoader, LuCheck, LuCircleAlert } from 'react-icons/lu'
import { invoke } from '@/utils/invokeMetrics'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

type CloneStatus = 'idle' | 'cloning' | 'success' | 'error'

const GIT_URL_REGEX = /^(https?:\/\/.+\.git|git@.+:.+\.git|https?:\/\/(github|gitlab|bitbucket)\..+\/.+\/.+)$/i

function extractRepoName(url: string): string {
  const match = url.match(/\/([^/]+?)(?:\.git)?$/)
  return match?.[1] || ''
}

function isValidGitUrl(url: string): boolean {
  if (!url.trim()) return false
  return GIT_URL_REGEX.test(url.trim()) || url.includes('github.com/') || url.includes('gitlab.com/')
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
}

const CloneDialog: React.FC<CloneDialogProps> = ({ dialog, onCloned }) => {
  const [repoUrl, setRepoUrl] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [branch, setBranch] = useState('')
  const [status, setStatus] = useState<CloneStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [progress, setProgress] = useState('')
  const urlInputRef = useRef<HTMLInputElement>(null)

  const repoName = extractRepoName(repoUrl)
  const isUrlValid = isValidGitUrl(repoUrl)
  const canClone = isUrlValid && localPath.trim().length > 0 && status !== 'cloning'

  // Focus URL input on open
  useEffect(() => {
    if (dialog.open) {
      setTimeout(() => urlInputRef.current?.focus(), 100)
    } else {
      // Reset on close
      setRepoUrl('')
      setLocalPath('')
      setBranch('')
      setStatus('idle')
      setErrorMsg('')
      setProgress('')
    }
  }, [dialog.open])

  // Auto-fill repo name into path
  useEffect(() => {
    if (repoName && localPath && !localPath.endsWith(repoName)) {
      const base = localPath.replace(/\/[^/]*$/, '')
      if (base !== localPath) {
        setLocalPath(`${base}/${repoName}`)
      }
    }
  }, [repoName])

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
        setLocalPath(`${selected as string}/${name}`)
      }
    } catch { /* user cancelled */ }
  }, [repoName])

  const handleClone = useCallback(async () => {
    if (!canClone) return

    setStatus('cloning')
    setErrorMsg('')
    setProgress(t('clone.connecting'))

    try {
      // Shell-escape inputs to prevent command injection
      const safeUrl = repoUrl.trim().replace(/'/g, "'\\''")
      const safePath = localPath.trim().replace(/'/g, "'\\''")
      let cmd = `git clone '${safeUrl}'`
      if (branch.trim()) {
        const safeBranch = branch.trim().replace(/'/g, "'\\''")
        cmd += ` --branch '${safeBranch}'`
      }
      cmd += ` '${safePath}'`

      const result = await invoke<{ stdout: string; stderr: string; exitCode: number; success: boolean }>('execute_command', {
        command: cmd,
        cwd: null,
        timeoutSecs: 120,
      })

      if (!result.success) {
        const errOutput = result.stderr || result.stdout || t('clone.failed')
        throw new Error(errOutput.split('\n').filter(Boolean).pop() || errOutput)
      }

      setStatus('success')
      setProgress('')

      // Auto-open after brief delay
      setTimeout(() => {
        dialog.setOpen(false)
        onCloned?.(localPath.trim())
      }, 800)

    } catch (err) {
      setStatus('error')
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(msg.length > 120 ? msg.slice(0, 120) + '...' : msg)
      setProgress('')
    }
  }, [canClone, repoUrl, branch, localPath, dialog, onCloned])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canClone) {
      handleClone()
    }
  }

  const purpleAccent = tokens.colors.accent.purple

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
                cursor="pointer"
                p={1}
                borderRadius="8px"
                minW="auto"
                lineHeight="1"
                _hover={{
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

                {/* Status messages */}
                {status === 'cloning' && (
                  <Flex
                    align="center"
                    gap={2}
                    py={2}
                    px={3}
                    bg="rgba(163, 113, 247, 0.06)"
                    borderRadius="10px"
                    border="1px solid rgba(163, 113, 247, 0.1)"
                  >
                    <Box css={{ animation: 'spin 1s linear infinite', '@keyframes spin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } } }}>
                      <LuLoader size={14} color={purpleAccent} />
                    </Box>
                    <Text fontSize="12px" color={purpleAccent}>
                      {progress || t('clone.cloning')}
                    </Text>
                  </Flex>
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
