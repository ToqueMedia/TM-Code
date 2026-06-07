import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Box, Button, Text, VStack } from '@chakra-ui/react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  onRecover?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

function FallbackUI({
  error,
  onRetry,
  onGoHome,
}: {
  error: Error
  onRetry: () => void
  onGoHome: () => void
}) {
  return (
    <Box
      display="flex"
      alignItems="center"
      justifyContent="center"
      height="100vh"
      width="100%"
      bg="bg.canvas"
    >
      <VStack gap={6} maxW="500px" textAlign="center" p={8}>
        <Box fontSize="64px">💥</Box>

        <VStack gap={2}>
          <Text fontSize="2xl" fontWeight="bold" color="fg.error">
            Something went wrong
          </Text>

          <Text fontSize="md" color="fg.muted">
            An unexpected error occurred. You can try again or go back to the home screen.
          </Text>
        </VStack>

        {process.env.NODE_ENV === 'development' && error && (
          <Box
            w="full"
            bg="red.900"
            borderRadius="md"
            p={4}
            textAlign="left"
            overflowY="auto"
            maxH="200px"
          >
            <Text fontSize="xs" fontFamily="mono" color="red.200">
              {error.message}
            </Text>
          </Box>
        )}

        <VStack gap={3} w="full">
          <Button colorPalette="red" size="lg" w="full" onClick={onRetry}>
            Try Again
          </Button>

          <Button variant="outline" size="lg" w="full" onClick={onGoHome}>
            Go to Home
          </Button>
        </VStack>
      </VStack>
    </Box>
  )
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo })

    // Log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.group('ErrorBoundary caught an error:')
      console.error(error)
      console.error(errorInfo.componentStack)
      console.groupEnd()
    }

    // Call custom error handler
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    })
    this.props.onRecover?.()
  }

  handleGoHome = () => {
    // Navigate to welcome screen
    window.dispatchEvent(
      new CustomEvent('navigate-to-view', { detail: 'welcome' })
    )
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <FallbackUI
          error={this.state.error!}
          onRetry={this.handleRetry}
          onGoHome={this.handleGoHome}
        />
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
