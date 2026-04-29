import { memo, useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { t } from '@/i18n'
import { Flex, Box, Text, Input } from '@chakra-ui/react'
import { FiSend, FiClock, FiChevronDown, FiTrash2, FiEye, FiEyeOff, FiAlertCircle, FiCheck, FiPlus, FiX, FiCopy } from 'react-icons/fi'
import { useHttpClientStore, type HttpMethod, type AuthType, type BodyType, type RequestTab } from '../../stores/httpClientStore'
import { useLayoutStore, selectBackendUrl } from '../../stores/layoutStore'
import KeyValueEditor from './KeyValueEditor'
import JsonBodyEditor from './JsonBodyEditor'
import ResponseViewer from './ResponseViewer'
import { tokens } from '@/theme/tokens'

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

const METHOD_COLORS: Record<string, string> = {
  GET: tokens.colors.accent.green,
  POST: tokens.colors.accent.purple,
  PUT: tokens.colors.accent.orange,
  PATCH: '#e3b341',
  DELETE: tokens.colors.accent.red,
  HEAD: tokens.colors.text.secondary,
  OPTIONS: tokens.colors.text.secondary,
}

const METHOD_BG: Record<string, string> = {
  GET: tokens.colors.accent.greenSubtle,
  POST: 'rgba(163, 113, 247, 0.1)',
  PUT: 'rgba(247, 127, 0, 0.1)',
  PATCH: 'rgba(227, 179, 65, 0.1)',
  DELETE: tokens.colors.accent.redSubtle,
  HEAD: tokens.colors.bg.card,
  OPTIONS: tokens.colors.bg.card,
}

const TABS: { key: RequestTab; label: string }[] = [
  { key: 'auth', label: 'Auth' },
  { key: 'headers', label: 'Headers' },
  { key: 'params', label: 'Params' },
  { key: 'body', label: 'Body' },
]

const MIN_REQUEST_HEIGHT = 140
const MAX_REQUEST_HEIGHT = 500
const DEFAULT_REQUEST_HEIGHT = 260
const REQUEST_HEIGHT_KEY = 'http-client-request-height'

const inputBase = {
  bg: 'transparent',
  border: 'none',
  color: tokens.colors.text.primary,
  fontSize: tokens.fontSize.sm,
  fontFamily: tokens.fontFamily.mono,
  _placeholder: { color: tokens.colors.text.disabled },
  _focus: { outline: 'none', boxShadow: 'none' },
  _focusVisible: { outline: 'none', boxShadow: 'none' },
  autoComplete: 'off' as const,
  autoCorrect: 'off' as const,
  spellCheck: false as const,
}

function HttpClientPanel() {
  const method = useHttpClientStore(s => s.method)
  const url = useHttpClientStore(s => s.url)
  const headers = useHttpClientStore(s => s.headers)
  const params = useHttpClientStore(s => s.params)
  const body = useHttpClientStore(s => s.body)
  const bodyType = useHttpClientStore(s => s.bodyType)
  const formData = useHttpClientStore(s => s.formData)
  const auth = useHttpClientStore(s => s.auth)
  const response = useHttpClientStore(s => s.response)
  const isLoading = useHttpClientStore(s => s.isLoading)
  const error = useHttpClientStore(s => s.error)
  const activeRequestTab = useHttpClientStore(s => s.activeRequestTab)
  const activeResponseTab = useHttpClientStore(s => s.activeResponseTab)
  const history = useHttpClientStore(s => s.history)
  const isHistoryOpen = useHttpClientStore(s => s.isHistoryOpen)
  const tabs = useHttpClientStore(s => s.tabs)
  const activeTabId = useHttpClientStore(s => s.activeTabId)
  // HTTP Client base URL: prefer explicit backendUrl; fall back to frontendUrl
  // for monolithic fullstack (Next.js API routes) where one URL serves both.
  const previewUrl = useLayoutStore(selectBackendUrl)

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [tabContextMenu, setTabContextMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const tabContextRef = useRef<HTMLDivElement>(null)

  const [isMethodOpen, setIsMethodOpen] = useState(false)
  const [requestHeight, setRequestHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(REQUEST_HEIGHT_KEY)
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (parsed >= MIN_REQUEST_HEIGHT && parsed <= MAX_REQUEST_HEIGHT) return parsed
      }
    } catch { /* ignore */ }
    return DEFAULT_REQUEST_HEIGHT
  })
  const [isResizing, setIsResizing] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const methodRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const resizeHandleRef = useRef<HTMLDivElement>(null)

  const store = useHttpClientStore

  // Pre-fill URL from dev server
  useEffect(() => {
    if (previewUrl) {
      store.getState().setBaseUrl(previewUrl)
    }
  }, [previewUrl])

  // Close dropdowns on outside click or ESC key
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (isMethodOpen && methodRef.current && !methodRef.current.contains(e.target as Node)) {
        setIsMethodOpen(false)
      }
      if (isHistoryOpen && historyRef.current && !historyRef.current.contains(e.target as Node)) {
        store.getState().toggleHistory()
      }
      if (tabContextMenu && tabContextRef.current && !tabContextRef.current.contains(e.target as Node)) {
        setTabContextMenu(null)
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isMethodOpen) setIsMethodOpen(false)
        if (isHistoryOpen) store.getState().toggleHistory()
        if (tabContextMenu) setTabContextMenu(null)
        if (renamingTabId) setRenamingTabId(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [isMethodOpen, isHistoryOpen, tabContextMenu, renamingTabId])

  const handleRenameSubmit = useCallback((tabId: string) => {
    const trimmed = renameValue.trim()
    if (trimmed) store.getState().renameTab(tabId, trimmed)
    setRenamingTabId(null)
  }, [renameValue])

  // Vertical resize handle
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const el = resizeHandleRef.current
    if (!el) return

    const pid = e.pointerId
    try { el.setPointerCapture(pid) } catch { /* ignore */ }

    const startY = e.clientY
    const startH = requestHeight
    let currentH = requestHeight
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    setIsResizing(true)

    function onMove(pe: PointerEvent) {
      let next = startH + (pe.clientY - startY)
      if (next < MIN_REQUEST_HEIGHT) next = MIN_REQUEST_HEIGHT
      if (next > MAX_REQUEST_HEIGHT) next = MAX_REQUEST_HEIGHT
      currentH = next
      setRequestHeight(next)
    }

    function onUp() {
      try { localStorage.setItem(REQUEST_HEIGHT_KEY, String(currentH)) } catch { /* ignore */ }
      try { el?.releasePointerCapture(pid) } catch { /* ignore */ }
      el?.removeEventListener('pointermove', onMove)
      el?.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setIsResizing(false)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }, [requestHeight])

  const handleSend = useCallback(() => {
    store.getState().sendRequest()
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      store.getState().sendRequest()
    }
  }, [])

  // URL input: user types after "/", we strip the leading "/" for display
  const displayPath = url.startsWith('/') ? url.slice(1) : url
  const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    // Always ensure "/" prefix
    store.getState().setUrl('/' + val.replace(/^\/+/, ''))
  }, [])

  const enabledHeaderCount = headers.filter(h => h.enabled && h.key).length
  const enabledParamCount = params.filter(p => p.enabled && p.key).length

  // JSON validation for body tab
  const jsonStatus = useMemo(() => {
    if (bodyType !== 'json' || !body.trim()) return null
    try {
      JSON.parse(body)
      return 'valid' as const
    } catch {
      return 'invalid' as const
    }
  }, [body, bodyType])

  return (
    <Flex direction="column" flex="1" overflow="hidden" onKeyDown={handleKeyDown}>
      {/* ═══ Request Tabs Bar ═══ */}
      <Flex
        align="center"
        borderBottom={`1px solid ${tokens.colors.border.glass}`}
        flexShrink={0}
        overflow="hidden"
        bg="rgba(255, 255, 255, 0.015)"
      >
        <Flex
          flex="1"
          overflowX="auto"
          align="center"
          gap="2px"
          px="4px"
          py="4px"
          css={{
            '&::-webkit-scrollbar': { height: '0px' },
          }}
        >
          {tabs.map(tab => {
            const isActive = activeTabId === tab.id
            const methodColor = METHOD_COLORS[tab.method]
            return (
              <Flex
                key={tab.id}
                align="center"
                gap="6px"
                px="10px"
                py="5px"
                fontSize="11px"
                fontWeight={isActive ? 600 : 400}
                color={isActive ? tokens.colors.text.primary : tokens.colors.text.disabled}
                bg={isActive ? 'rgba(255, 255, 255, 0.07)' : 'transparent'}
                borderRadius="6px"
                cursor="pointer"
                transition={`all ${tokens.transition.fast}`}
                position="relative"
                _hover={{
                  color: tokens.colors.text.secondary,
                  bg: isActive ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.04)',
                }}
                flexShrink={0}
                className="group"
                onClick={() => store.getState().setActiveTab(tab.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setTabContextMenu({ id: tab.id, x: e.clientX, y: e.clientY })
                }}
                onDoubleClick={() => {
                  setRenamingTabId(tab.id)
                  setRenameValue(tab.name)
                }}
              >
                <Text
                  fontSize="9px"
                  fontWeight={700}
                  fontFamily="mono"
                  color={methodColor}
                  letterSpacing="0.02em"
                  lineHeight="1"
                  flexShrink={0}
                >
                  {tab.method}
                </Text>
                {renamingTabId === tab.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => handleRenameSubmit(tab.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleRenameSubmit(tab.id)
                      if (e.key === 'Escape') setRenamingTabId(null)
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: tokens.colors.text.primary,
                      fontSize: '11px',
                      fontFamily: tokens.fontFamily.mono,
                      width: '80px',
                      padding: 0,
                    }}
                  />
                ) : (
                  <Text
                    fontSize="11px"
                    fontFamily={tokens.fontFamily.mono}
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    maxW="120px"
                    lineHeight="1"
                  >
                    {tab.name}
                  </Text>
                )}
                {tabs.length > 1 && (
                  <Flex
                    align="center"
                    justify="center"
                    w="14px"
                    h="14px"
                    borderRadius="4px"
                    flexShrink={0}
                    color={tokens.colors.text.disabled}
                    opacity={isActive ? 0.7 : 0}
                    _groupHover={{ opacity: isActive ? 0.8 : 0.5 }}
                    css={{
                      '&:hover': {
                        opacity: '1 !important',
                        color: tokens.colors.text.secondary,
                        background: 'rgba(255,255,255,0.1)',
                      },
                    }}
                    transition={`all ${tokens.transition.fast}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      store.getState().removeTab(tab.id)
                    }}
                  >
                    <FiX size={9} />
                  </Flex>
                )}
              </Flex>
            )
          })}
        </Flex>

        {/* Add tab button */}
        <Flex
          as="button"
          align="center"
          justify="center"
          w="28px"
          h="28px"
          mr="4px"
          flexShrink={0}
          cursor="pointer"
          borderRadius="6px"
          color={tokens.colors.text.disabled}
          _hover={{ color: tokens.colors.text.secondary, bg: 'rgba(255, 255, 255, 0.06)' }}
          transition={`all ${tokens.transition.fast}`}
          onClick={() => store.getState().addTab()}
        >
          <FiPlus size={12} />
        </Flex>
      </Flex>

      {/* Tab context menu */}
      {tabContextMenu && (
        <Box
          ref={tabContextRef}
          position="fixed"
          top={`${tabContextMenu.y}px`}
          left={`${tabContextMenu.x}px`}
          bg={tokens.colors.bg.overlay}
          border={`1px solid ${tokens.colors.border.panel}`}
          borderRadius="8px"
          py={1}
          zIndex={tokens.zIndex.dropdown}
          boxShadow={tokens.shadow.overlay}
          minW="140px"
        >
          {[
            { label: 'Duplicate', icon: FiCopy, action: () => store.getState().duplicateTab(tabContextMenu.id) },
            { label: 'Rename', icon: FiCheck, action: () => {
              const tab = tabs.find(t => t.id === tabContextMenu.id)
              if (tab) { setRenamingTabId(tab.id); setRenameValue(tab.name) }
            }},
            ...(tabs.length > 1 ? [{
              label: 'Close', icon: FiX, action: () => store.getState().removeTab(tabContextMenu.id),
            }] : []),
          ].map(item => (
            <Flex
              key={item.label}
              as="button"
              w="100%"
              align="center"
              gap={2}
              px={3}
              py="6px"
              fontSize={tokens.fontSize.xs}
              color={tokens.colors.text.secondary}
              cursor="pointer"
              _hover={{ bg: tokens.colors.bg.hoverSubtle }}
              transition={`background ${tokens.transition.fast}`}
              onClick={() => {
                item.action()
                setTabContextMenu(null)
              }}
            >
              <item.icon size={12} />
              {item.label}
            </Flex>
          ))}
        </Box>
      )}

      {/* ═══ URL Bar ═══ */}
      <Flex
        align="center"
        gap={2}
        px={4}
        py={3}
        borderBottom={`1px solid ${tokens.colors.border.glass}`}
        flexShrink={0}
      >
        {/* Method selector */}
        <Box ref={methodRef} position="relative" flexShrink={0}>
          <Flex
            as="button"
            align="center"
            gap="4px"
            px={3}
            py="7px"
            bg={METHOD_BG[method]}
            borderRadius="6px"
            color={METHOD_COLORS[method]}
            fontWeight={700}
            fontSize={tokens.fontSize.sm}
            fontFamily="mono"
            cursor="pointer"
            _hover={{ opacity: 0.85 }}
            transition={`all ${tokens.transition.fast}`}
            onClick={() => setIsMethodOpen(!isMethodOpen)}
          >
            {method}
            <FiChevronDown size={11} style={{
              transform: isMethodOpen ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s ease',
            }} />
          </Flex>

          {isMethodOpen && (
            <Box
              position="absolute"
              top="calc(100% + 4px)"
              left={0}
              bg={tokens.colors.bg.overlay}
              border={`1px solid ${tokens.colors.border.panel}`}
              borderRadius="8px"
              py={1}
              zIndex={tokens.zIndex.dropdown}
              minW="110px"
              boxShadow={tokens.shadow.overlay}
              overflow="hidden"
            >
              {HTTP_METHODS.map(m => (
                <Flex
                  key={m}
                  as="button"
                  w="100%"
                  px={3}
                  py="6px"
                  align="center"
                  gap={2}
                  color={METHOD_COLORS[m]}
                  fontWeight={600}
                  fontSize={tokens.fontSize.sm}
                  fontFamily="mono"
                  cursor="pointer"
                  bg={m === method ? tokens.colors.bg.hoverSubtle : 'transparent'}
                  _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                  transition={`background ${tokens.transition.fast}`}
                  onClick={() => {
                    store.getState().setMethod(m)
                    setIsMethodOpen(false)
                  }}
                >
                  <Box w="6px" h="6px" borderRadius="full" bg={METHOD_COLORS[m]} />
                  {m}
                </Flex>
              ))}
            </Box>
          )}
        </Box>

        {/* URL input with fixed "/" prefix */}
        <Flex
          align="center"
          flex="1"
          bg={tokens.colors.bg.input}
          borderRadius="6px"
          overflow="hidden"
        >
          <Text
            pl={3}
            color={tokens.colors.text.muted}
            fontFamily="mono"
            fontSize={tokens.fontSize.sm}
            userSelect="none"
            flexShrink={0}
          >
            /
          </Text>
          <Input
            {...inputBase}
            flex="1"
            px={1}
            py="7px"
            placeholder="api/tasks"
            value={displayPath}
            onChange={handleUrlChange}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </Flex>

        {/* History button */}
        <Box ref={historyRef} position="relative" flexShrink={0}>
          <Flex
            as="button"
            align="center"
            justify="center"
            w="34px"
            h="34px"
            borderRadius="6px"
            cursor="pointer"
            color={isHistoryOpen ? tokens.colors.accent.primary : tokens.colors.text.disabled}
            _hover={{ bg: tokens.colors.bg.hoverSubtle, color: tokens.colors.text.secondary }}
            transition={`all ${tokens.transition.fast}`}
            onClick={() => store.getState().toggleHistory()}
            position="relative"
          >
            <FiClock size={15} />
            {history.length > 0 && (
              <Box
                position="absolute"
                top="4px"
                right="4px"
                w="6px"
                h="6px"
                borderRadius="full"
                bg={tokens.colors.accent.primary}
              />
            )}
          </Flex>

          {/* History dropdown */}
          {isHistoryOpen && (
            <Box
              position="absolute"
              top="calc(100% + 4px)"
              right={0}
              w="380px"
              maxH="320px"
              bg={tokens.colors.bg.overlay}
              border={`1px solid ${tokens.colors.border.panel}`}
              borderRadius="10px"
              zIndex={tokens.zIndex.dropdown}
              boxShadow={tokens.shadow.overlay}
              overflow="hidden"
              display="flex"
              flexDirection="column"
            >
              <Flex
                align="center"
                justify="space-between"
                px={3}
                py={2}
                borderBottom={`1px solid ${tokens.colors.border.glass}`}
                flexShrink={0}
              >
                <Text fontSize={tokens.fontSize.xs} fontWeight={600} color={tokens.colors.text.secondary}>
                  Recent Requests
                </Text>
                {history.length > 0 && (
                  <Flex
                    as="button"
                    align="center"
                    gap={1}
                    px={2}
                    py="2px"
                    borderRadius="4px"
                    fontSize="10px"
                    color={tokens.colors.text.disabled}
                    cursor="pointer"
                    _hover={{ color: tokens.colors.accent.red }}
                    transition={`color ${tokens.transition.fast}`}
                    onClick={() => store.getState().clearHistory()}
                  >
                    <FiTrash2 size={10} />
                    Clear
                  </Flex>
                )}
              </Flex>

              <Box
                flex="1"
                overflowY="auto"
                css={{
                  '&::-webkit-scrollbar': { width: '3px' },
                  '&::-webkit-scrollbar-thumb': { background: tokens.colors.scrollbar.thumb, borderRadius: '2px' },
                }}
              >
                {history.length === 0 ? (
                  <Flex align="center" justify="center" py={6}>
                    <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
                      No history yet
                    </Text>
                  </Flex>
                ) : (
                  history.map(entry => (
                    <Flex
                      key={entry.id}
                      align="center"
                      gap={2}
                      px={3}
                      py="7px"
                      cursor="pointer"
                      _hover={{ bg: tokens.colors.bg.hoverSubtle }}
                      transition={`background ${tokens.transition.fast}`}
                      onClick={() => store.getState().loadFromHistory(entry)}
                    >
                      <Text
                        fontSize="10px"
                        fontWeight={700}
                        fontFamily="mono"
                        color={METHOD_COLORS[entry.method]}
                        w="52px"
                        flexShrink={0}
                      >
                        {entry.method}
                      </Text>
                      <Text
                        flex="1"
                        fontSize={tokens.fontSize.xs}
                        fontFamily="mono"
                        color={tokens.colors.text.secondary}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        {entry.url}
                      </Text>
                      <Box
                        px="5px"
                        py="1px"
                        borderRadius="3px"
                        bg={`${getStatusColor(entry.status)}15`}
                      >
                        <Text fontSize="10px" fontFamily="mono" fontWeight={600} color={getStatusColor(entry.status)}>
                          {entry.status}
                        </Text>
                      </Box>
                      <Text fontSize="10px" fontFamily="mono" color={tokens.colors.text.disabled} flexShrink={0}>
                        {entry.durationMs}ms
                      </Text>
                      <Flex
                        align="center"
                        justify="center"
                        w="20px"
                        flexShrink={0}
                        color={tokens.colors.text.disabled}
                        _hover={{ color: tokens.colors.accent.red }}
                        transition={`color ${tokens.transition.fast}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          store.getState().removeFromHistory(entry.id)
                        }}
                      >
                        <FiTrash2 size={10} />
                      </Flex>
                    </Flex>
                  ))
                )}
              </Box>
            </Box>
          )}
        </Box>

        {/* Send button */}
        <Flex
          as="button"
          align="center"
          gap="6px"
          px={4}
          py="7px"
          bg={isLoading ? tokens.colors.accent.primarySubtle : tokens.gradient.accentPrimary}
          color="white"
          borderRadius="6px"
          fontSize={tokens.fontSize.sm}
          fontWeight={600}
          cursor={isLoading ? 'default' : 'pointer'}
          opacity={!url ? 0.4 : 1}
          _hover={!isLoading && url ? { opacity: 0.9 } : {}}
          transition={`all ${tokens.transition.fast}`}
          flexShrink={0}
          onClick={handleSend}
          pointerEvents={isLoading || !url ? 'none' : 'auto'}
        >
          {isLoading ? (
            <Box
              w="14px"
              h="14px"
              borderRadius="full"
              border="2px solid rgba(255,255,255,0.3)"
              borderTopColor="white"
              css={{ animation: 'spin 0.6s linear infinite', '@keyframes spin': { to: { transform: 'rotate(360deg)' } } }}
            />
          ) : (
            <FiSend size={13} />
          )}
          {isLoading ? 'Sending' : 'Send'}
        </Flex>
      </Flex>

      {/* ═══ Request Section ═══ */}
      <Flex direction="column" h={`${requestHeight}px`} flexShrink={0} overflow="hidden">
        {/* Tab bar: Auth → Headers → Params → Body */}
        <Flex
          borderBottom={`1px solid ${tokens.colors.border.glass}`}
          px={2}
          flexShrink={0}
        >
          {TABS.map(tab => {
            const badge =
              tab.key === 'headers' && enabledHeaderCount > 0 ? enabledHeaderCount
              : tab.key === 'params' && enabledParamCount > 0 ? enabledParamCount
              : tab.key === 'auth' && auth.type !== 'none' ? auth.type
              : undefined

            return (
              <Box
                key={tab.key}
                as="button"
                px={3}
                py="8px"
                fontSize={tokens.fontSize.xs}
                fontWeight={500}
                color={activeRequestTab === tab.key ? tokens.colors.text.primary : tokens.colors.text.disabled}
                borderBottom={`2px solid ${activeRequestTab === tab.key ? tokens.colors.accent.primary : 'transparent'}`}
                cursor="pointer"
                transition={`all ${tokens.transition.fast}`}
                _hover={{ color: tokens.colors.text.secondary }}
                onClick={() => store.getState().setActiveRequestTab(tab.key)}
                mb="-1px"
              >
                {tab.label}
                {typeof badge === 'number' && (
                  <Text as="span" ml="4px" fontSize="10px" color={tokens.colors.accent.primary} fontWeight={600}>
                    {badge}
                  </Text>
                )}
                {typeof badge === 'string' && (
                  <Text as="span" ml="4px" fontSize="10px" color={tokens.colors.accent.primary} fontWeight={600} textTransform="capitalize">
                    {badge}
                  </Text>
                )}
              </Box>
            )
          })}
        </Flex>

        {/* Tab content */}
        <Box flex="1" overflow="hidden">
          {/* ── Auth tab ── */}
          {activeRequestTab === 'auth' && (
            <Flex direction="column" p={4} gap={4}>
              <Flex gap={1}>
                {(['none', 'bearer', 'basic'] as AuthType[]).map(type => (
                  <Box
                    key={type}
                    as="button"
                    px={3}
                    py="6px"
                    borderRadius="6px"
                    fontSize={tokens.fontSize.xs}
                    fontWeight={auth.type === type ? 600 : 400}
                    color={auth.type === type ? tokens.colors.text.primary : tokens.colors.text.disabled}
                    bg={auth.type === type ? tokens.colors.bg.whiteSubtle : 'transparent'}
                    border={`1px solid ${auth.type === type ? tokens.colors.border.input : 'transparent'}`}
                    cursor="pointer"
                    transition={`all ${tokens.transition.fast}`}
                    _hover={{ color: tokens.colors.text.secondary, bg: tokens.colors.bg.hoverSubtle }}
                    onClick={() => store.getState().setAuth({ type })}
                  >
                    {type === 'none' ? 'No Auth' : type === 'bearer' ? 'Bearer Token' : 'Basic Auth'}
                  </Box>
                ))}
              </Flex>

              {auth.type === 'bearer' && (
                <Flex direction="column" gap={2}>
                  <Text fontSize="10px" fontWeight={600} color={tokens.colors.text.disabled} textTransform="uppercase" letterSpacing="0.5px">
                    Token
                  </Text>
                  <Input
                    {...inputBase}
                    px={3}
                    py="8px"
                    bg={tokens.colors.bg.input}
                    borderRadius="6px"
                    placeholder={t("misc.pasteToken")}
                    value={auth.token}
                    onChange={(e) => store.getState().setAuth({ token: e.target.value })}
                  />
                  <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily="mono">
                    Authorization: Bearer &lt;token&gt;
                  </Text>
                </Flex>
              )}

              {auth.type === 'basic' && (
                <Flex direction="column" gap={3}>
                  <Flex direction="column" gap={1}>
                    <Text fontSize="10px" fontWeight={600} color={tokens.colors.text.disabled} textTransform="uppercase" letterSpacing="0.5px">
                      Username
                    </Text>
                    <Input
                      {...inputBase}
                      px={3}
                      py="8px"
                      bg={tokens.colors.bg.input}
                      borderRadius="6px"
                      placeholder={t("misc.username")}
                      value={auth.username}
                      onChange={(e) => store.getState().setAuth({ username: e.target.value })}
                    />
                  </Flex>
                  <Flex direction="column" gap={1}>
                    <Text fontSize="10px" fontWeight={600} color={tokens.colors.text.disabled} textTransform="uppercase" letterSpacing="0.5px">
                      Password
                    </Text>
                    <Flex align="center" bg={tokens.colors.bg.input} borderRadius="6px" overflow="hidden">
                      <Input
                        {...inputBase}
                        flex="1"
                        px={3}
                        py="8px"
                        type={showPassword ? 'text' : 'password'}
                        placeholder={t("misc.password")}
                        value={auth.password}
                        onChange={(e) => store.getState().setAuth({ password: e.target.value })}
                      />
                      <Flex
                        as="button"
                        align="center"
                        justify="center"
                        w="32px"
                        h="32px"
                        flexShrink={0}
                        cursor="pointer"
                        color={tokens.colors.text.disabled}
                        _hover={{ color: tokens.colors.text.secondary }}
                        transition={`color ${tokens.transition.fast}`}
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? <FiEyeOff size={13} /> : <FiEye size={13} />}
                      </Flex>
                    </Flex>
                  </Flex>
                  <Text fontSize="10px" color={tokens.colors.text.disabled} fontFamily="mono">
                    Authorization: Basic &lt;base64(username:password)&gt;
                  </Text>
                </Flex>
              )}

              {auth.type === 'none' && (
                <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
                  No authentication will be applied to this request.
                </Text>
              )}
            </Flex>
          )}

          {/* ── Headers tab ── */}
          {activeRequestTab === 'headers' && (
            <KeyValueEditor
              pairs={headers}
              onAdd={() => store.getState().addHeader()}
              onUpdate={(id, f, v) => store.getState().updateHeader(id, f, v)}
              onRemove={(id) => store.getState().removeHeader(id)}
              keyPlaceholder="Header"
              valuePlaceholder="Value"
              withHeaderSuggestions
            />
          )}

          {/* ── Params tab ── */}
          {activeRequestTab === 'params' && (
            <KeyValueEditor
              pairs={params}
              onAdd={() => store.getState().addParam()}
              onUpdate={(id, f, v) => store.getState().updateParam(id, f, v)}
              onRemove={(id) => store.getState().removeParam(id)}
              keyPlaceholder="Parameter"
              valuePlaceholder="Value"
            />
          )}

          {/* ── Body tab ── */}
          {activeRequestTab === 'body' && (
            <Flex direction="column" flex="1" h="100%" overflow="hidden">
              {/* Body type selector + JSON tools */}
              <Flex px={3} py="6px" gap={1} borderBottom={`1px solid ${tokens.colors.border.glass}`} flexShrink={0} align="center">
                {(['json', 'text', 'form-urlencoded'] as BodyType[]).map(type => (
                  <Box
                    key={type}
                    as="button"
                    px="8px"
                    py="3px"
                    borderRadius="4px"
                    fontSize="10px"
                    fontWeight={500}
                    color={bodyType === type ? tokens.colors.text.primary : tokens.colors.text.disabled}
                    bg={bodyType === type ? tokens.colors.bg.whiteSubtle : 'transparent'}
                    cursor="pointer"
                    transition={`all ${tokens.transition.fast}`}
                    _hover={{ color: tokens.colors.text.secondary }}
                    onClick={() => store.getState().setBodyType(type)}
                    textTransform="uppercase"
                  >
                    {type}
                  </Box>
                ))}

                {/* JSON tools — format button + validation */}
                {bodyType === 'json' && body.trim() && (
                  <Flex align="center" gap={2} ml="auto">
                    {jsonStatus && (
                      <Flex align="center" gap={1}>
                        {jsonStatus === 'valid' ? (
                          <FiCheck size={11} color={tokens.colors.accent.green} />
                        ) : (
                          <FiAlertCircle size={11} color={tokens.colors.accent.red} />
                        )}
                        <Text fontSize="10px" color={jsonStatus === 'valid' ? tokens.colors.accent.green : tokens.colors.accent.red}>
                          {jsonStatus === 'valid' ? 'Valid' : 'Invalid'}
                        </Text>
                      </Flex>
                    )}
                    <Box
                      as="button"
                      px="6px"
                      py="2px"
                      borderRadius="3px"
                      fontSize="10px"
                      color={tokens.colors.text.disabled}
                      _hover={{ color: tokens.colors.accent.primary, bg: tokens.colors.bg.hoverSubtle }}
                      cursor="pointer"
                      transition={`all ${tokens.transition.fast}`}
                      onClick={() => store.getState().formatJson()}
                    >
                      Format
                    </Box>
                  </Flex>
                )}
              </Flex>

              {/* Body content */}
              {bodyType === 'form-urlencoded' ? (
                <KeyValueEditor
                  pairs={formData}
                  onAdd={() => store.getState().addFormData()}
                  onUpdate={(id, f, v) => store.getState().updateFormData(id, f, v)}
                  onRemove={(id) => store.getState().removeFormData(id)}
                  keyPlaceholder="Field"
                  valuePlaceholder="Value"
                />
              ) : bodyType === 'json' ? (
                <JsonBodyEditor
                  value={body}
                  onChange={(v) => store.getState().setBody(v)}
                  placeholder={'{\n  "key": "value"\n}'}
                />
              ) : (
                <textarea
                  style={{
                    flex: 1,
                    width: '100%',
                    background: 'transparent',
                    color: tokens.colors.text.primary,
                    fontFamily: tokens.fontFamily.mono,
                    fontSize: tokens.fontSize.xs,
                    lineHeight: '1.7',
                    padding: '12px',
                    border: 'none',
                    outline: 'none',
                    resize: 'none',
                  }}
                  placeholder={t("misc.plainTextBody")}
                  value={body}
                  onChange={(e) => store.getState().setBody(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                />
              )}
            </Flex>
          )}
        </Box>
      </Flex>

      {/* ═══ Resize Handle ═══ */}
      <Box
        ref={resizeHandleRef}
        h="4px"
        cursor="row-resize"
        flexShrink={0}
        bg={isResizing ? tokens.colors.accent.primary : 'transparent'}
        transition={isResizing ? 'none' : `background ${tokens.transition.fast}`}
        _hover={{ bg: tokens.colors.accent.primary }}
        onPointerDown={handleResizeStart}
        zIndex={2}
      />

      {/* ═══ Response Section ═══ */}
      <Flex
        direction="column"
        flex="1"
        overflow="hidden"
        bg={tokens.colors.bg.app}
        borderTop={`1px solid ${tokens.colors.border.glass}`}
      >
        <ResponseViewer
          response={response}
          error={error}
          isLoading={isLoading}
          activeTab={activeResponseTab}
          onTabChange={(tab) => store.getState().setActiveResponseTab(tab)}
        />
      </Flex>
    </Flex>
  )
}

function getStatusColor(status: number): string {
  if (status < 200) return '#60a5fa'
  if (status < 300) return tokens.colors.accent.green
  if (status < 400) return '#e3b341'
  if (status < 500) return tokens.colors.accent.orange
  return tokens.colors.accent.red
}

export default memo(HttpClientPanel)
