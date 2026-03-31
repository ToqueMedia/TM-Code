import {
  HStack,
  VStack,
  Text,
  IconButton,
  Button,
  Badge
} from '@chakra-ui/react'
import {
  FiPlay,
  FiPause,
  FiSquare,
  FiSkipForward,
  FiArrowDown,
  FiArrowUp
} from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import type { DebuggerControlsProps } from './types'

function DebuggerControls({
  activeSession,
  isDebugging,
  loading,
  onShowConfig,
  onDebugAction,
  onStopDebug
}: DebuggerControlsProps) {
  return (
    <VStack gap={3} align="stretch">
      <HStack>
        {!activeSession ? (
          <Button
            size="sm"
            onClick={onShowConfig}
            disabled={loading}
            bg={tokens.colors.accent.green}
            color={tokens.colors.text.inverse}
            _hover={{ bg: tokens.colors.accent.greenHover }}
          >
            <FiPlay style={{ marginRight: '8px' }} />
            Start Debugging
          </Button>
        ) : (
          <HStack gap={2}>
            <IconButton
              aria-label={isDebugging ? 'Pause' : 'Continue'}
              size="sm"
              onClick={() => onDebugAction(isDebugging ? 'pause' : 'continue')}
              disabled={loading}
              bg={isDebugging ? tokens.colors.accent.orange : tokens.colors.accent.green}
              color={tokens.colors.text.inverse}
            >
              {isDebugging ? <FiPause /> : <FiPlay />}
            </IconButton>

            <IconButton
              aria-label={t("misc.stopDebugging")}
              size="sm"
              onClick={onStopDebug}
              disabled={loading}
              bg={tokens.colors.accent.red}
              color={tokens.colors.text.inverse}
            >
              <FiSquare />
            </IconButton>

            <IconButton
              aria-label={t("misc.stepOver")}
              size="sm"
              onClick={() => onDebugAction('step-over')}
              disabled={isDebugging || loading}
            >
              <FiSkipForward />
            </IconButton>

            <IconButton
              aria-label={t("misc.stepInto")}
              size="sm"
              onClick={() => onDebugAction('step-into')}
              disabled={isDebugging || loading}
            >
              <FiArrowDown />
            </IconButton>

            <IconButton
              aria-label={t("misc.stepOut")}
              size="sm"
              onClick={() => onDebugAction('step-out')}
              disabled={isDebugging || loading}
            >
              <FiArrowUp />
            </IconButton>
          </HStack>
        )}
      </HStack>

      {activeSession && (
        <HStack>
          <Badge colorScheme={isDebugging ? 'green' : 'orange'}>
            {isDebugging ? 'Running' : 'Paused'}
          </Badge>
          <Text fontSize="sm" color={tokens.colors.text.secondary}>
            Session: {activeSession.slice(0, 8)}...
          </Text>
        </HStack>
      )}
    </VStack>
  )
}

export default DebuggerControls
