import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { Box, Flex, Text, Portal, Textarea, Input, HStack } from '@chakra-ui/react'
import { FiX, FiCamera, FiSend, FiCheck, FiAlertCircle, FiMonitor } from 'react-icons/fi'
import { invoke } from '@/utils/invokeMetrics'
import { tokens } from '@/theme/tokens'
import { useAuthStore } from '@/stores/authStore'
import { useTranslation } from '@/i18n'
import { t as tStatic } from '@/i18n'

const MAX_SCREENSHOTS = 5

/** Build the template using current translations (called at render time, not module load) */
function buildDescriptionTemplate(): string {
  return `${tStatic('issueReporter.tplProblem')}

${tStatic('issueReporter.tplSteps')}
1.
2.
3.

${tStatic('issueReporter.tplExpected')}

${tStatic('issueReporter.tplActual')}

${tStatic('issueReporter.tplTime')} ${new Date().toLocaleString()}`
}

function getSystemInfo(): string {
  const ua = navigator.userAgent
  const platform = navigator.platform || 'Unknown'
  const lang = navigator.language
  const screen = `${window.screen.width}x${window.screen.height}`
  const dpr = window.devicePixelRatio
  const memory = (navigator as any).deviceMemory
    ? `${(navigator as any).deviceMemory} GB`
    : 'N/A'

  return [
    `Platform: ${platform}`,
    `Screen: ${screen} @${dpr}x`,
    `Language: ${lang}`,
    `Memory: ${memory}`,
    `User Agent: ${ua}`,
    `App Version: TM Code 0.1.0`,
  ].join('\n')
}

/** Max screenshot dimension — keeps base64 payload reasonable (~200-400KB each) */
const MAX_SCREENSHOT_WIDTH = 1280

/**
 * Downscale and compress an image (canvas or data URL) to JPEG.
 * Keeps width ≤ MAX_SCREENSHOT_WIDTH. Returns a data URL.
 */
function compressImage(source: HTMLCanvasElement | HTMLImageElement): string {
  let canvas = document.createElement('canvas')
  const srcW = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth
  const srcH = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight

  if (srcW > MAX_SCREENSHOT_WIDTH) {
    const ratio = MAX_SCREENSHOT_WIDTH / srcW
    canvas.width = MAX_SCREENSHOT_WIDTH
    canvas.height = Math.round(srcH * ratio)
  } else {
    canvas.width = srcW
    canvas.height = srcH
  }

  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  }
  return canvas.toDataURL('image/jpeg', 0.7)
}

/**
 * Compress an uploaded/pasted image data URL via an offscreen <img>.
 * Returns a promise that resolves to a compressed JPEG data URL.
 */
function compressDataUrl(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(compressImage(img))
    img.onerror = () => resolve(dataUrl) // fallback to original on error
    img.src = dataUrl
  })
}

/**
 * Capture screenshot of the current window.
 * html2canvas renders the DOM — canvas-based elements (Monaco, xterm)
 * won't appear, but the overall layout/file tree/chat is captured.
 *
 * Uses `ignoreElements` to exclude the issue reporter overlay itself,
 * so "Capture Window" works correctly even while the dialog is open.
 * Output is downscaled to MAX_SCREENSHOT_WIDTH and compressed as JPEG.
 */
async function captureScreenshot(): Promise<string | null> {
  try {
    const html2canvas = (await import('html2canvas')).default
    const fullCanvas = await html2canvas(document.documentElement, {
      backgroundColor: '#0a0a0a',
      scale: 1,
      logging: false,
      useCORS: true,
      allowTaint: true,
      ignoreElements: (el: Element) => el.hasAttribute('data-issue-reporter-overlay'),
    })
    return compressImage(fullCanvas)
  } catch (err) {
    console.error('Screenshot capture failed:', err)
    return null
  }
}

interface IssueReporterDialogProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * The dialog renders straight to the `ready` state with an empty screenshot
 * list. Users attach screenshots explicitly via the "Capture Window" button
 * or the drop zone. The previous auto-capture-on-open path was removed
 * because html2canvas runs synchronously on the main thread for ~hundreds of
 * ms and stalled the agent's streaming counters; also, the developer didn't
 * always want a screenshot of the moment they opened the dialog.
 */
function IssueReporterDialog({ isOpen, onClose }: IssueReporterDialogProps) {
  const t = useTranslation()
  const user = useAuthStore(s => s.user)
  const [phase, setPhase] = useState<'idle' | 'ready'>('idle')
  const [description, setDescription] = useState('')
  const [email, setEmail] = useState(user?.email || '')
  const [screenshots, setScreenshots] = useState<string[]>([])
  const [includeSystemInfo, setIncludeSystemInfo] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)
  const [isCapturing, setIsCapturing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const templateRef = useRef('')

  // Reset on open/close. No auto screenshot — the user decides.
  useEffect(() => {
    if (!isOpen) {
      setPhase('idle')
      setScreenshots([])
      return
    }

    setResult(null)
    setIsSending(false)
    const tpl = buildDescriptionTemplate()
    templateRef.current = tpl
    setDescription(tpl)
    setEmail(user?.email || '')
    setScreenshots([])
    setPhase('ready')
  }, [isOpen, user?.email])

  // Escape to close
  useEffect(() => {
    if (phase !== 'ready') return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [phase, onClose])

  const handleAddScreenshot = useCallback(async () => {
    if (screenshots.length >= MAX_SCREENSHOTS) return
    setIsCapturing(true)
    const shot = await captureScreenshot()
    setIsCapturing(false)
    if (shot) {
      setScreenshots(prev => [...prev, shot])
    }
  }, [screenshots.length])

  const handleRemoveScreenshot = useCallback((index: number) => {
    setScreenshots(prev => prev.filter((_, i) => i !== index))
  }, [])

  /** Read a File as data URL, compress it, then add to screenshots */
  const addImageFile = useCallback((file: File) => {
    if (file.size > 20 * 1024 * 1024) return
    if (!file.type.startsWith('image/')) return

    const reader = new FileReader()
    reader.onload = async () => {
      const compressed = await compressDataUrl(reader.result as string)
      setScreenshots(prev => {
        if (prev.length >= MAX_SCREENSHOTS) return prev
        return [...prev, compressed]
      })
    }
    reader.readAsDataURL(file)
  }, [])

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach(addImageFile)
    e.target.value = ''
  }, [addImageFile])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    Array.from(e.dataTransfer.files).forEach(addImageFile)
  }, [addImageFile])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile()
        if (blob) addImageFile(blob)
      }
    }
  }, [addImageFile])

  // Description is valid only if user modified it beyond the template
  const descriptionModified = description.trim() !== '' && description.trim() !== templateRef.current.trim()

  const handleSubmit = useCallback(async () => {
    if (!descriptionModified || isSending) return
    setIsSending(true)
    setResult(null)

    try {
      // Strip data URL prefix from all screenshots for Resend attachments
      const screenshotsBase64 = screenshots
        .map(s => s.split(',')[1])
        .filter((b): b is string => !!b)

      const systemInfo = includeSystemInfo ? getSystemInfo() : null

      const res = await invoke<{ success: boolean; message: string }>('send_issue_report', {
        input: {
          description: description.trim(),
          email: email.trim() || 'anonymous@tmcode.user',
          screenshots: screenshotsBase64,
          systemInfo: systemInfo,
        }
      })

      setResult(res)
      if (res.success) {
        setTimeout(() => {
          onClose()
          setScreenshots([])
          setDescription('')
          setResult(null)
        }, 2000)
      }
    } catch (err) {
      setResult({ success: false, message: String(err) })
    } finally {
      setIsSending(false)
    }
  }, [descriptionModified, description, email, screenshots, includeSystemInfo, isSending, onClose])

  if (phase === 'idle') return null

  return (
    <Portal>
      {/* Backdrop — data attr lets captureScreenshot() exclude it via ignoreElements */}
      <Flex
        data-issue-reporter-overlay=""
        position="fixed"
        inset={0}
        zIndex={tokens.zIndex.modal}
        bg={tokens.colors.dialog.backdrop}
        align="center"
        justify="center"
        onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
        onClick={onClose}
      >
        {/* Dialog */}
        <Box
          bg={tokens.colors.bg.app}
          border={`1px solid ${tokens.colors.border.default}`}
          borderRadius="12px"
          boxShadow="0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(254, 16, 99, 0.08)"
          w="560px"
          maxH="85vh"
          display="flex"
          flexDirection="column"
          overflow="hidden"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          onPaste={handlePaste}
        >
          {/* Header */}
          <Flex
            align="center"
            justify="space-between"
            px={5}
            py={3.5}
            bg={tokens.colors.bg.overlay}
            borderBottom={`1px solid ${tokens.colors.border.default}`}
            flexShrink={0}
          >
            <HStack gap={2}>
              <Box
                w="8px"
                h="8px"
                borderRadius="full"
                bg={tokens.colors.accent.primary}
                boxShadow={`0 0 8px ${tokens.colors.accent.primaryMuted}`}
              />
              <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary}>
                {t('issueReporter.title')}
              </Text>
            </HStack>
            <Box
              as="button"
              display="flex"
              alignItems="center"
              justifyContent="center"
              w="24px"
              h="24px"
              borderRadius="6px"
              color={tokens.colors.text.secondary}
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
              onClick={onClose}
            >
              <FiX size={14} />
            </Box>
          </Flex>

          {/* Body */}
          <Box flex="1" overflowY="auto" px={5} py={4} css={{
            '&::-webkit-scrollbar': { width: '5px' },
            '&::-webkit-scrollbar-track': { background: 'transparent' },
            '&::-webkit-scrollbar-thumb': { background: tokens.colors.border.panel, borderRadius: '3px' },
          }}>
            {/* Screenshot section */}
            <Box mb={5}>
              <HStack mb={2} justify="space-between">
                <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary}>
                  {t('issueReporter.screenshot')}
                  <Text as="span" fontSize="11px" color={tokens.colors.text.muted} ml={2} fontWeight="400">
                    {screenshots.length}/{MAX_SCREENSHOTS}
                  </Text>
                </Text>
                {screenshots.length < MAX_SCREENSHOTS && (
                  <Box
                    as="button"
                    display="flex"
                    alignItems="center"
                    gap="4px"
                    px={2}
                    py={1}
                    borderRadius="6px"
                    fontSize="11px"
                    color={tokens.colors.accent.primary}
                    cursor="pointer"
                    transition={`all ${tokens.transition.fast}`}
                    _hover={{ bg: tokens.colors.accent.primarySubtle }}
                    onClick={handleAddScreenshot}
                    _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
                    aria-disabled={isCapturing}
                  >
                    <FiCamera size={12} />
                    {isCapturing ? t('issueReporter.capturing') : t('issueReporter.captureWindow')}
                  </Box>
                )}
              </HStack>

              {/* Drop zone */}
              <Box
                border={`1px dashed ${tokens.colors.border.input}`}
                borderRadius="8px"
                p={4}
                textAlign="center"
                cursor="pointer"
                transition={`all ${tokens.transition.fast}`}
                _hover={{ borderColor: tokens.colors.accent.primaryMuted, bg: tokens.colors.accent.primarySubtle }}
                onClick={() => fileInputRef.current?.click()}
                onDrop={handleDrop}
                onDragOver={(e: React.DragEvent) => e.preventDefault()}
              >
                <Text fontSize="12px" color={tokens.colors.text.muted}>
                  {t('issueReporter.dropzone')}
                </Text>
                <Text fontSize="11px" color={tokens.colors.text.disabled} mt={1}>
                  {t('issueReporter.dropzoneFormats')}
                </Text>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif"
                  multiple
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                />
              </Box>

              {/* Screenshot thumbnails */}
              {screenshots.length > 0 && (
                <HStack gap={2} mt={3} flexWrap="wrap">
                  {screenshots.map((shot, i) => (
                    <Box key={i} position="relative" flexShrink={0}>
                      <img
                        src={shot}
                        alt={`Screenshot ${i + 1}`}
                        style={{
                          width: '100px',
                          height: '65px',
                          objectFit: 'cover',
                          borderRadius: '6px',
                          border: `1px solid ${tokens.colors.border.default}`,
                        }}
                      />
                      <Box
                        as="button"
                        position="absolute"
                        top="-6px"
                        right="-6px"
                        w="18px"
                        h="18px"
                        borderRadius="full"
                        bg={tokens.colors.accent.red}
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        cursor="pointer"
                        transition={`all ${tokens.transition.fast}`}
                        _hover={{ transform: 'scale(1.1)' }}
                        onClick={() => handleRemoveScreenshot(i)}
                      >
                        <FiX size={10} color="#fff" />
                      </Box>
                      <Text
                        fontSize="9px"
                        color={tokens.colors.text.muted}
                        textAlign="center"
                        mt={0.5}
                      >
                        {`Image ${i + 1}`}
                      </Text>
                    </Box>
                  ))}
                </HStack>
              )}
            </Box>

            {/* Description */}
            <Box mb={5}>
              <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary} mb={2}>
                {t('issueReporter.description')}
                <Text as="span" color={tokens.colors.accent.red} ml={0.5}>*</Text>
              </Text>
              <Textarea
                value={description}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
                bg={tokens.colors.bg.input}
                border={`1px solid ${tokens.colors.border.input}`}
                borderRadius="8px"
                color={tokens.colors.text.primary}
                fontSize="12px"
                fontFamily={tokens.fontFamily.mono}
                rows={8}
                resize="vertical"
                placeholder={t('issueReporter.descriptionPlaceholder')}
                transition={`border-color ${tokens.transition.fast}`}
                _hover={{ borderColor: tokens.colors.border.inputAlt }}
                _focus={{ borderColor: tokens.colors.accent.primary, boxShadow: `0 0 0 1px ${tokens.colors.accent.primaryMuted}` }}
                css={{
                  '&::-webkit-scrollbar': { width: '4px' },
                  '&::-webkit-scrollbar-thumb': { background: tokens.colors.border.panel, borderRadius: '2px' },
                }}
              />
            </Box>

            {/* Email */}
            <Box mb={5}>
              <Text fontSize="12px" fontWeight="600" color={tokens.colors.text.primary} mb={2}>
                {t('issueReporter.email')}
              </Text>
              <Input
                value={email}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                bg={tokens.colors.bg.input}
                border={`1px solid ${tokens.colors.border.input}`}
                borderRadius="8px"
                color={tokens.colors.text.primary}
                fontSize="12px"
                h="36px"
                placeholder="email@example.com"
                transition={`border-color ${tokens.transition.fast}`}
                _hover={{ borderColor: tokens.colors.border.inputAlt }}
                _focus={{ borderColor: tokens.colors.accent.primary, boxShadow: `0 0 0 1px ${tokens.colors.accent.primaryMuted}` }}
              />
            </Box>

            {/* Information notice */}
            <Box mb={4}>
              <Text fontSize="11px" color={tokens.colors.text.muted} mb={3}>
                {t('issueReporter.infoNotice')}
              </Text>
              <HStack gap={4} flexWrap="wrap">
                <CheckboxItem
                  icon={FiMonitor}
                  label={t('issueReporter.systemInfo')}
                  checked={includeSystemInfo}
                  onChange={() => setIncludeSystemInfo(!includeSystemInfo)}
                />
              </HStack>
            </Box>

            {/* Result message */}
            {result && (
              <Flex
                align="center"
                gap={2}
                p={3}
                borderRadius="8px"
                bg={result.success ? tokens.colors.accent.greenSubtle : tokens.colors.accent.redSubtle}
                border={`1px solid ${result.success ? tokens.colors.accent.greenMuted : tokens.colors.accent.redMuted}`}
                mb={3}
              >
                {result.success ? (
                  <FiCheck size={14} color={tokens.colors.accent.green} />
                ) : (
                  <FiAlertCircle size={14} color={tokens.colors.accent.red} />
                )}
                <Text fontSize="12px" color={result.success ? tokens.colors.accent.green : tokens.colors.accent.red}>
                  {result.success ? t('issueReporter.sent') : result.message}
                </Text>
              </Flex>
            )}
          </Box>

          {/* Footer */}
          <Flex
            align="center"
            justify="flex-end"
            gap={2}
            px={5}
            py={3}
            borderTop={`1px solid ${tokens.colors.border.default}`}
            bg={tokens.colors.bg.overlay}
            flexShrink={0}
          >
            <Box
              as="button"
              px={4}
              py="7px"
              borderRadius="8px"
              fontSize="12px"
              fontWeight="500"
              color={tokens.colors.text.secondary}
              bg="transparent"
              border={`1px solid ${tokens.colors.border.input}`}
              cursor="pointer"
              transition={`all ${tokens.transition.fast}`}
              _hover={{ bg: tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
              onClick={onClose}
            >
              {t('settings.cancel')}
            </Box>
            <Box
              as="button"
              px={4}
              py="7px"
              borderRadius="8px"
              fontSize="12px"
              fontWeight="600"
              color="#fff"
              bg={tokens.colors.accent.primary}
              cursor={!descriptionModified || isSending ? 'not-allowed' : 'pointer'}
              opacity={!descriptionModified || isSending ? 0.5 : 1}
              transition={`all ${tokens.transition.fast}`}
              _hover={descriptionModified && !isSending ? { bg: tokens.colors.accent.primaryDark, boxShadow: tokens.shadow.dialogButton } : {}}
              onClick={handleSubmit}
              display="flex"
              alignItems="center"
              gap="6px"
            >
              <FiSend size={12} />
              {isSending ? t('issueReporter.sending') : t('issueReporter.submit')}
            </Box>
          </Flex>
        </Box>
      </Flex>
    </Portal>
  )
}

// ─── Checkbox Item ─────────────────────────────────────────────────────────────

function CheckboxItem(props: {
  icon: React.ElementType
  label: string
  checked: boolean
  onChange: () => void
}) {
  const Icon = props.icon
  return (
    <HStack
      as="button"
      gap={1.5}
      cursor="pointer"
      onClick={props.onChange}
      transition={`all ${tokens.transition.fast}`}
    >
      <Flex
        w="16px"
        h="16px"
        borderRadius="4px"
        border={`1px solid ${props.checked ? tokens.colors.accent.primary : tokens.colors.border.input}`}
        bg={props.checked ? tokens.colors.accent.primary : 'transparent'}
        align="center"
        justify="center"
        transition={`all ${tokens.transition.fast}`}
      >
        {props.checked && <FiCheck size={10} color="#fff" />}
      </Flex>
      <Icon size={12} color={tokens.colors.text.muted} />
      <Text fontSize="11px" color={tokens.colors.text.secondary}>
        {props.label}
      </Text>
    </HStack>
  )
}

export default memo(IssueReporterDialog)
