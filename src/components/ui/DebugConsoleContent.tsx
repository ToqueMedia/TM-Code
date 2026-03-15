import { memo } from 'react'
import { Text, ScrollArea } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const DebugConsoleContent = memo(() => (
  <ScrollArea.Root flex="1">
    <ScrollArea.Viewport p={3} fontFamily="mono" fontSize="sm">
      <Text color="text.muted" mb={1}>
        Debug session started
      </Text>
      <Text color={tokens.colors.status.info} mb={1}>
        Breakpoint hit: App.tsx:25
      </Text>
      <Text color="text.primary" mb={1}>
        &gt; console.log(user)
      </Text>
      <Text color={tokens.colors.accent.green} mb={1}>
        {`{ id: 1, name: "John Doe", email: "john@example.com" }`}
      </Text>
      <Text color="text.muted">
        Ready for evaluation
      </Text>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar orientation="vertical">
      <ScrollArea.Thumb />
    </ScrollArea.Scrollbar>
  </ScrollArea.Root>
))

DebugConsoleContent.displayName = 'DebugConsoleContent'

export default DebugConsoleContent
