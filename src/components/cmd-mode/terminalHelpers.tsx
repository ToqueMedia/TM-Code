/**
 * Shared helpers, markdown components, and Error Boundary for CMD mode terminal UI.
 */
import React, { type ComponentProps } from 'react'
import { Flex, Text } from '@chakra-ui/react'
import { FiAlertTriangle } from 'react-icons/fi'
import type { Components } from 'react-markdown'
import { tokens } from '@/theme/tokens'

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
  borderRadius: '3px',
  padding: '1px 5px',
  fontSize: '12px',
  fontFamily: tokens.fontFamily.mono,
  color: '#e6a1c0',
  border: '1px solid rgba(255, 255, 255, 0.05)',
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
    <pre style={{ margin: '4px 0', padding: '6px', background: 'rgba(0,0,0,0.3)', borderRadius: '3px', overflowX: 'auto' }}>
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
}

// ─── Error Boundary ───

type ErrorBoundaryState = { hasError: boolean; error: Error | null }
type ErrorBoundaryProps = { children: React.ReactNode; fallback?: React.ReactNode }

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <Flex px={2} py={1} borderRadius="3px" bg="rgba(248,81,73,0.08)" border="1px solid rgba(248,81,73,0.2)" gap={2} align="center">
          <FiAlertTriangle color={tokens.colors.accent.red} size={11} />
          <Text fontSize="11px" color={tokens.colors.accent.red} fontFamily={tokens.fontFamily.mono}>
            {this.state.error?.message || 'render error'}
          </Text>
        </Flex>
      )
    }
    return this.props.children
  }
}
