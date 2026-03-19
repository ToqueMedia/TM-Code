import { memo } from 'react'
import { Flex, Box, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

const mod = isMac ? '⌘' : 'Ctrl'
const shift = isMac ? '⇧' : 'Shift'

interface Props {
  onBackToChat: () => void
  onToggleExplorer: () => void
  onToggleTerminal: () => void
}

function Kbd({ children }: { children: string }) {
  return (
    <Box
      px={1.5}
      py={0.5}
      borderRadius="4px"
      bg="rgba(255, 255, 255, 0.06)"
      border="1px solid rgba(255, 255, 255, 0.08)"
      minW="26px"
      textAlign="center"
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
    >
      <Text
        fontSize="11px"
        fontWeight="500"
        color={tokens.colors.text.disabled}
        fontFamily={tokens.fontFamily.mono}
        lineHeight="16px"
      >
        {children}
      </Text>
    </Box>
  )
}

function ShortcutRow({ label, keys, onClick }: { label: string; keys: string[]; onClick: () => void }) {
  return (
    <Flex
      as="button"
      align="center"
      justify="center"
      gap={3}
      cursor="pointer"
      onClick={onClick}
      py={1}
      _hover={{ '& .sl': { color: tokens.colors.text.secondary } }}
      transition={`all ${tokens.transition.fast}`}
    >
      <Text
        className="sl"
        fontSize="13px"
        color={tokens.colors.text.disabled}
        fontWeight="400"
        transition={`color ${tokens.transition.fast}`}
        minW="170px"
        textAlign="right"
      >
        {label}
      </Text>
      <Flex gap={1} minW="90px">
        {keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
      </Flex>
    </Flex>
  )
}

function EmptyEditorState({ onBackToChat, onToggleExplorer, onToggleTerminal }: Props) {
  return (
    <Flex flex="1" align="center" justify="center" direction="column" gap={5} bg={tokens.colors.bg.app}>
      <ShortcutRow label="Back to Chat" keys={[mod, 'L']} onClick={onBackToChat} />
      <ShortcutRow label="Open File" keys={[mod, 'P']} onClick={() => window.dispatchEvent(new CustomEvent('quickopen:toggle'))} />
      <ShortcutRow label="Toggle Explorer" keys={[mod, 'B']} onClick={onToggleExplorer} />
      <ShortcutRow label="Toggle Terminal" keys={[mod, 'J']} onClick={onToggleTerminal} />
      <ShortcutRow label="Show All Commands" keys={[shift, mod, 'P']} onClick={() => window.dispatchEvent(new CustomEvent('command:palette'))} />
    </Flex>
  )
}

export default memo(EmptyEditorState)
