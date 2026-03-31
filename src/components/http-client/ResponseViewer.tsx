import React, { memo, useState, useCallback, useMemo } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { FiCopy, FiCheck } from 'react-icons/fi'
import type { HttpResponse } from '../../stores/httpClientStore'
import { tokens } from '@/theme/tokens'

interface ResponseViewerProps {
  response: HttpResponse | null
  error: string | null
  isLoading: boolean
  activeTab: 'body' | 'headers'
  onTabChange: (tab: 'body' | 'headers') => void
}

const STATUS_COLORS: Record<string, string> = {
  '1': '#60a5fa',
  '2': tokens.colors.accent.green,
  '3': '#e3b341',
  '4': tokens.colors.accent.orange,
  '5': tokens.colors.accent.red,
}

function getStatusColor(status: number): string {
  return STATUS_COLORS[String(status)[0]] || tokens.colors.text.secondary
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/** Max body size (bytes) for JSON syntax highlighting — raw text above this. */
const MAX_HIGHLIGHT_SIZE = 102_400

function ResponseViewer({ response, error, isLoading, activeTab, onTabChange }: ResponseViewerProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!response?.body) return
    try {
      await navigator.clipboard.writeText(response.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }, [response?.body])

  // Loading state
  if (isLoading) {
    return (
      <Flex flex="1" align="center" justify="center" direction="column" gap={3}>
        <Box
          w="20px"
          h="20px"
          borderRadius="full"
          border={`2px solid ${tokens.colors.border.glass}`}
          borderTopColor={tokens.colors.accent.primary}
          css={{ animation: 'spin 0.6s linear infinite', '@keyframes spin': { to: { transform: 'rotate(360deg)' } } }}
        />
        <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
          Sending request...
        </Text>
      </Flex>
    )
  }

  // Error state
  if (error) {
    return (
      <Flex flex="1" direction="column" overflow="hidden">
        <Flex
          align="center"
          px={4}
          py="8px"
          borderBottom={`1px solid ${tokens.colors.border.glass}`}
          flexShrink={0}
        >
          <Box
            px={2}
            py="2px"
            borderRadius="4px"
            bg={tokens.colors.accent.redSubtle}
          >
            <Text fontSize={tokens.fontSize.xs} fontWeight={600} color={tokens.colors.accent.red}>
              Error
            </Text>
          </Box>
        </Flex>
        <Box flex="1" p={4} overflowY="auto">
          <Text
            fontSize={tokens.fontSize.sm}
            color={tokens.colors.accent.red}
            fontFamily="mono"
            whiteSpace="pre-wrap"
            lineHeight="1.6"
          >
            {error}
          </Text>
        </Box>
      </Flex>
    )
  }

  // Empty state
  if (!response) {
    return (
      <Flex flex="1" align="center" justify="center" direction="column" gap={2}>
        <Text fontSize="28px" opacity={0.15}>
          &lt;/&gt;
        </Text>
        <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled}>
          Send a request to see the response
        </Text>
      </Flex>
    )
  }

  const statusColor = getStatusColor(response.status)
  const headerCount = response.headerEntries.length

  return (
    <Flex flex="1" direction="column" overflow="hidden">
      {/* Status bar */}
      <Flex
        align="center"
        justify="space-between"
        px={4}
        py="8px"
        borderBottom={`1px solid ${tokens.colors.border.glass}`}
        flexShrink={0}
        gap={3}
      >
        <Flex align="center" gap={3}>
          {/* Status badge */}
          <Flex align="center" gap="6px">
            <Box w="7px" h="7px" borderRadius="full" bg={statusColor} />
            <Text fontSize={tokens.fontSize.sm} fontWeight={700} color={statusColor} fontFamily="mono">
              {response.status}
            </Text>
            <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.secondary}>
              {response.statusText}
            </Text>
          </Flex>

          {/* Timing */}
          <Box
            px="6px"
            py="1px"
            borderRadius="4px"
            bg={tokens.colors.bg.card}
          >
            <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily="mono">
              {formatDuration(response.durationMs)}
            </Text>
          </Box>

          {/* Size */}
          <Box
            px="6px"
            py="1px"
            borderRadius="4px"
            bg={tokens.colors.bg.card}
          >
            <Text fontSize="10px" color={tokens.colors.text.muted} fontFamily="mono">
              {formatBytes(response.sizeBytes)}
            </Text>
          </Box>
        </Flex>

        {/* Copy button */}
        <Flex
          as="button"
          align="center"
          gap={1}
          px={2}
          py="3px"
          borderRadius="4px"
          color={copied ? tokens.colors.accent.green : tokens.colors.text.disabled}
          fontSize="10px"
          cursor="pointer"
          _hover={{ color: copied ? tokens.colors.accent.green : tokens.colors.text.secondary, bg: tokens.colors.bg.hoverSubtle }}
          transition={`all ${tokens.transition.fast}`}
          onClick={handleCopy}
        >
          {copied ? <FiCheck size={11} /> : <FiCopy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </Flex>
      </Flex>

      {/* Response tabs */}
      <Flex
        borderBottom={`1px solid ${tokens.colors.border.glass}`}
        flexShrink={0}
        px={2}
      >
        {(['body', 'headers'] as const).map(tab => (
          <Box
            key={tab}
            as="button"
            px={3}
            py="7px"
            fontSize={tokens.fontSize.xs}
            fontWeight={500}
            color={activeTab === tab ? tokens.colors.text.primary : tokens.colors.text.disabled}
            borderBottom={`2px solid ${activeTab === tab ? tokens.colors.accent.primary : 'transparent'}`}
            cursor="pointer"
            transition={`all ${tokens.transition.fast}`}
            _hover={{ color: tokens.colors.text.secondary }}
            onClick={() => onTabChange(tab)}
            textTransform="capitalize"
            mb="-1px"
          >
            {tab}
            {tab === 'headers' && (
              <Text as="span" ml={1} fontSize="10px" color={tokens.colors.text.disabled}>
                ({headerCount})
              </Text>
            )}
          </Box>
        ))}
      </Flex>

      {/* Content */}
      <Box
        flex="1"
        overflowY="auto"
        css={{
          '&::-webkit-scrollbar': { width: '4px' },
          '&::-webkit-scrollbar-thumb': { background: tokens.colors.scrollbar.thumb, borderRadius: '2px' },
        }}
      >
        {activeTab === 'body' ? (
          <ResponseBody body={response.body} contentType={response.headers['content-type'] || ''} />
        ) : (
          <ResponseHeaders entries={response.headerEntries} />
        )}
      </Box>
    </Flex>
  )
}

// --- Response Body with JSON syntax highlighting ---

const JSON_TOKEN_REGEX = /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(true|false)|(null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

const TOKEN_COLORS = {
  key: tokens.colors.accent.purple,
  string: tokens.colors.accent.greenBright,
  boolean: tokens.colors.accent.blueBright,
  null: tokens.colors.text.disabled,
  number: tokens.colors.accent.orangeBright,
}

const ResponseBody = memo(function ResponseBody({
  body,
  contentType,
}: {
  body: string
  contentType: string
}) {
  // Only attempt JSON highlighting when content-type confirms JSON,
  // OR body looks like JSON AND is small enough to highlight efficiently
  const ct = contentType.toLowerCase()
  const isJsonContentType = ct.includes('json')
  const looksLikeJson = body.trimStart().startsWith('{') || body.trimStart().startsWith('[')
  const isJson = isJsonContentType || looksLikeJson
  const tooLarge = body.length > MAX_HIGHLIGHT_SIZE

  const highlighted = useMemo(() => {
    if (!isJson || tooLarge) return null
    try {
      const parsed = JSON.parse(body)
      const pretty = JSON.stringify(parsed, null, 2)
      return highlightJson(pretty)
    } catch {
      return null
    }
  }, [body, isJson, tooLarge])

  return (
    <Box
      p={3}
      fontFamily="mono"
      fontSize={tokens.fontSize.xs}
      lineHeight="1.7"
      whiteSpace="pre-wrap"
      wordBreak="break-all"
      color={tokens.colors.text.primary}
    >
      {highlighted ?? body}
      {tooLarge && isJson && (
        <Text mt={2} fontSize="10px" color={tokens.colors.text.disabled}>
          Response too large for syntax highlighting ({formatBytes(body.length)})
        </Text>
      )}
    </Box>
  )
})

function highlightJson(json: string): (string | React.JSX.Element)[] {
  const result: (string | React.JSX.Element)[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let keyId = 0

  const regex = new RegExp(JSON_TOKEN_REGEX.source, 'g')

  while ((match = regex.exec(json)) !== null) {
    if (match.index > lastIndex) {
      result.push(json.slice(lastIndex, match.index))
    }

    if (match[1]) {
      result.push(<span key={`k${keyId++}`} style={{ color: TOKEN_COLORS.key }}>{match[1]}</span>)
      result.push(':')
    } else if (match[2]) {
      result.push(<span key={`s${keyId++}`} style={{ color: TOKEN_COLORS.string }}>{match[2]}</span>)
    } else if (match[3]) {
      result.push(<span key={`b${keyId++}`} style={{ color: TOKEN_COLORS.boolean }}>{match[3]}</span>)
    } else if (match[4]) {
      result.push(<span key={`n${keyId++}`} style={{ color: TOKEN_COLORS.null }}>{match[4]}</span>)
    } else if (match[5]) {
      result.push(<span key={`d${keyId++}`} style={{ color: TOKEN_COLORS.number }}>{match[5]}</span>)
    }

    lastIndex = regex.lastIndex
  }

  if (lastIndex < json.length) {
    result.push(json.slice(lastIndex))
  }

  return result
}

// --- Response Headers table (preserves duplicates) ---

const ResponseHeaders = memo(function ResponseHeaders({
  entries,
}: {
  entries: [string, string][]
}) {
  const sorted = useMemo(
    () => [...entries].sort(([a], [b]) => a.localeCompare(b)),
    [entries],
  )

  return (
    <Box p={1}>
      {sorted.map(([key, value], i) => (
        <Flex
          key={`${key}-${i}`}
          py="4px"
          px={3}
          _hover={{ bg: tokens.colors.bg.hoverSubtle }}
          borderRadius="3px"
          transition={`background ${tokens.transition.fast}`}
        >
          <Text
            fontSize={tokens.fontSize.xs}
            fontFamily="mono"
            color={tokens.colors.accent.purple}
            fontWeight={500}
            w="200px"
            flexShrink={0}
          >
            {key}
          </Text>
          <Text
            fontSize={tokens.fontSize.xs}
            fontFamily="mono"
            color={tokens.colors.text.secondary}
            wordBreak="break-all"
          >
            {value}
          </Text>
        </Flex>
      ))}
    </Box>
  )
})

export default memo(ResponseViewer)
