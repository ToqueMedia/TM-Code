import { memo } from 'react'
import { Text, ScrollArea } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const OutputContent = memo(() => (
  <ScrollArea.Root flex="1">
    <ScrollArea.Viewport p={3} fontFamily="mono" fontSize="sm">
      <Text color="text.muted" mb={2}>
        [Extension Host] Starting extension host process...
      </Text>
      <Text color={tokens.colors.status.info} mb={1}>
        [Info] TypeScript Language Server started
      </Text>
      <Text color={tokens.colors.accent.green} mb={1}>
        [Info] Code formatting enabled
      </Text>
      <Text color={tokens.colors.accent.orange} mb={1}>
        [Warn] Extension 'deprecated-ext' is deprecated
      </Text>
      <Text color="text.muted" mb={1}>
        [Debug] Watching for file changes...
      </Text>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar orientation="vertical">
      <ScrollArea.Thumb />
    </ScrollArea.Scrollbar>
  </ScrollArea.Root>
))

OutputContent.displayName = 'OutputContent'

export default OutputContent
