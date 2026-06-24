/**
 * Shared helpers, markdown components, and Error Boundary for CMD mode terminal UI.
 */
import React, { type ComponentProps } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiAlertTriangle } from 'react-icons/fi'
import type { Components } from 'react-markdown'
import { tokens } from '@/theme/tokens'
import { logger } from '../../utils/logger'
import { t } from '@/i18n/useTranslation'

// ─── Formatters ───

export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m ${remSecs}s`
}

export function formatTokens(count: number): string {
  if (count === 0) return '0'
  if (count < 1000) return String(count)
  if (count < 1_000_000) {
    const k = count / 1000
    return k >= 100 ? `${Math.round(k)}k` : k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`
  }
  const m = count / 1_000_000
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`
}

// ─── Markdown components ───

const inlineCodeStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.07)',
  borderRadius: tokens.radius.sm,
  padding: '1px 5px',
  fontSize: '12px',
  fontFamily: tokens.fontFamily.mono,
  color: tokens.colors.terminal.inlineCode,
  border: '1px solid rgba(255, 255, 255, 0.05)',
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
}

export const terminalMarkdownComponents: Components = {
  p: ({ children }) => (
    <span style={{ display: 'block', whiteSpace: 'pre-wrap', marginBottom: '8px' }}>{children}</span>
  ),
  code: ({ className, children, ...rest }: ComponentProps<'code'> & { className?: string }) => {
    const isInline = !className
    if (isInline) return <code style={inlineCodeStyle}>{children}</code>
    return <code {...rest} className={className}>{children}</code>
  },
  pre: ({ children }) => (
    <pre style={{
      margin: '4px 0',
      padding: '6px',
      background: 'rgba(0,0,0,0.3)',
      borderRadius: '3px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      overflowWrap: 'anywhere',
    }}>
      {children}
    </pre>
  ),
  a: ({ href, children }) => (
    <a href={href} style={{ color: tokens.colors.accent.purple, textDecoration: 'underline' }} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong style={{ color: '#ffffff', fontWeight: 600 }}>{children}</strong>
  ),
  ul: ({ children }) => (
    <ul style={{ paddingLeft: '16px', margin: '3px 0' }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ paddingLeft: '16px', margin: '3px 0' }}>{children}</ol>
  ),
  li: ({ children }) => (
    <li style={{ marginBottom: '1px', lineHeight: '1.5' }}>{children}</li>
  ),
  h1: ({ children }) => (
    <span style={{ fontWeight: 700, fontSize: '14px', color: '#ffffff' }}>{children}</span>
  ),
  h2: ({ children }) => (
    <span style={{ fontWeight: 700, fontSize: '13px', color: '#ffffff' }}>{children}</span>
  ),
  h3: ({ children }) => (
    <span style={{ fontWeight: 600, fontSize: '12px', color: '#ffffff' }}>{children}</span>
  ),
  blockquote: ({ children }) => (
    <span style={{
      borderLeft: `2px solid ${tokens.colors.accent.purpleMuted}`,
      paddingLeft: '10px',
      color: tokens.colors.text.secondary,
      fontStyle: 'italic',
      display: 'block',
      margin: '3px 0',
    }}>
      {children}
    </span>
  ),
  // Markdown tables — flat (refined-terminal): no outer card/radius/border;
  // a single 1px rule under the header is the only separation cue.
  table: ({ children }) => (
    <div style={{
      margin: '8px 0',
      overflowX: 'auto',
    }}>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '11px',
        fontFamily: tokens.fontFamily.mono,
        lineHeight: '1.5',
      }}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead style={{
      borderBottom: `1px solid ${tokens.colors.border.subtle}`,
    }}>
      {children}
    </thead>
  ),
  tbody: ({ children }) => (
    <tbody>
      {children}
    </tbody>
  ),
  tr: ({ children }) => (
    <tr style={{
      borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    }}>
      {children}
    </tr>
  ),
  th: ({ children }) => (
    <th style={{
      padding: '6px 10px',
      textAlign: 'left',
      fontWeight: 600,
      color: '#ffffff',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{
      padding: '5px 10px',
      color: tokens.colors.text.secondary,
      verticalAlign: 'top',
    }}>
      {children}
    </td>
  ),
}

// ─── Error Boundary ───

type ErrorBoundaryState = { hasError: boolean; error: Error | null }
/** A static node, or a render-prop that receives the error + a reset() to retry. */
type ErrorBoundaryFallback =
  | React.ReactNode
  | ((error: Error | null, reset: () => void) => React.ReactNode)
type ErrorBoundaryProps = { children: React.ReactNode; fallback?: ErrorBoundaryFallback }

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  private reset = () => this.setState({ hasError: false, error: null })

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Terminal mode previously swallowed per-message render errors silently —
    // the message just vanished with no trace. Log with the componentStack so
    // these are diagnosable (directly aids the React #185 investigation, whose
    // root cause was pending a componentStack).
    logger.error(
      'terminal',
      `message render error: ${error.message}`,
      error,
      info.componentStack,
    )
  }

  render() {
    if (this.state.hasError) {
      const { fallback } = this.props
      if (typeof fallback === 'function') return fallback(this.state.error, this.reset)
      if (fallback) return fallback
      const message = this.state.error?.message || 'unknown render error'
      // Refined-terminal contract: flat, mono, single red accent. Frame it as
      // "this one message failed" (the rest of the transcript is intact) rather
      // than dumping a raw stack — and clamp the reason so a giant React error
      // string doesn't blow out the scrollback.
      return (
        <Flex
          px={2}
          py="6px"
          my="2px"
          borderRadius={tokens.radius.sm}
          bg="rgba(248, 81, 73, 0.06)"
          border="1px solid rgba(248, 81, 73, 0.18)"
          gap={2}
          align="flex-start"
          data-ui-chrome
        >
          <Box color={tokens.colors.accent.red} flexShrink={0} mt="1px" display="flex">
            <FiAlertTriangle size={12} />
          </Box>
          <Box minW={0} flex={1}>
            <Text fontSize="11px" fontWeight="600" color={tokens.colors.accent.red} fontFamily={tokens.fontFamily.mono}>
              {t('terminalMode.view.renderErrorTitle')}
            </Text>
            <Text
              fontSize="10px"
              color={tokens.colors.text.muted}
              fontFamily={tokens.fontFamily.mono}
              mt="2px"
              css={{
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}
            >
              {message}
            </Text>
          </Box>
        </Flex>
      )
    }
    return this.props.children
  }
}

// ─── Top-level crash fallback ───
//
// Shown when a render error escapes the per-message boundaries (status line,
// prompt, a banner). Previously such an error white-screened the whole app
// (React #185). This degrades to a calm, recoverable terminal panel: Retry
// re-renders the subtree (transient errors), Reload restarts the window.
export function TerminalCrashFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const message = error?.message || 'unknown error'
  return (
    <Flex direction="column" flex="1" minH={0} align="center" justify="center" gap={3} px={6} data-ui-chrome>
      <Flex align="center" gap={2} color={tokens.colors.accent.red}>
        <FiAlertTriangle size={18} />
        <Text fontFamily={tokens.fontFamily.mono} fontSize="13px" fontWeight="700">
          {t('terminalMode.view.crashTitle')}
        </Text>
      </Flex>
      <Text
        fontFamily={tokens.fontFamily.mono}
        fontSize="11px"
        color={tokens.colors.text.muted}
        maxW="520px"
        textAlign="center"
        css={{
          display: '-webkit-box',
          WebkitLineClamp: 4,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          wordBreak: 'break-word',
        }}
      >
        {message}
      </Text>
      <Flex gap={2}>
        <Box
          as="button"
          fontFamily={tokens.fontFamily.mono}
          fontSize="11px"
          fontWeight="600"
          px={3}
          py="6px"
          borderRadius={tokens.radius.sm}
          cursor="pointer"
          transition={`all ${tokens.transition.fast}`}
          color={tokens.colors.accent.purple}
          bg="rgba(163, 113, 247, 0.12)"
          border="1px solid rgba(163, 113, 247, 0.3)"
          _hover={{ bg: 'rgba(163, 113, 247, 0.2)' }}
          onClick={onRetry}
        >
          {t('terminalMode.view.crashRetry')}
        </Box>
        <Box
          as="button"
          fontFamily={tokens.fontFamily.mono}
          fontSize="11px"
          fontWeight="600"
          px={3}
          py="6px"
          borderRadius={tokens.radius.sm}
          cursor="pointer"
          transition={`all ${tokens.transition.fast}`}
          color={tokens.colors.text.secondary}
          bg={tokens.colors.bg.hoverSubtle}
          border={`1px solid ${tokens.colors.border.panel}`}
          _hover={{ color: tokens.colors.text.primary, borderColor: tokens.colors.border.glass }}
          onClick={() => window.location.reload()}
        >
          {t('terminalMode.view.crashReload')}
        </Box>
      </Flex>
    </Flex>
  )
}
