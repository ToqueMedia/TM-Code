import { memo, useId, type ReactNode } from 'react'
import { Box, Text } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { tokens } from '@/theme/tokens'
import { t, type TranslationKey } from '@/i18n'
import { emptySessionPeriod, type EmptySessionPeriod } from './emptySessionPeriod'

const MotionBox = motion.create(Box)

const GREETING_KEY: Record<EmptySessionPeriod, TranslationKey> = {
  morning: 'chat.empty.greeting.morning',
  afternoon: 'chat.empty.greeting.afternoon',
  evening: 'chat.empty.greeting.evening',
}

/** Top half of the TM outline. Clipped so the mark stops where the
 *  greeting begins — it lands on the text, it does not run through it. */
function BrandMarkOutline() {
  const uid = useId().replace(/:/g, '')
  const filterId = `tmMarkOutline-${uid}`
  return (
    <Box
      w={{ base: '240px', md: '360px' }}
      h={{ base: '144px', md: '216px' }}
      overflow="hidden"
      pointerEvents="none"
      userSelect="none"
      aria-hidden
      position="relative"
      flexShrink={0}
    >
      <Box w="100%" h={{ base: '288px', md: '432px' }}>
        <svg
          viewBox="0 0 5000 6000"
          width="100%"
          height="100%"
          fill="none"
          role="presentation"
        >
          <defs>
            <filter id={filterId} x="-15%" y="-15%" width="130%" height="130%" colorInterpolationFilters="sRGB">
              <feMorphology in="SourceAlpha" operator="dilate" radius="18" result="dilated" />
              <feComposite in="dilated" in2="SourceAlpha" operator="out" result="ring" />
              <feFlood floodColor={tokens.colors.accent.primary} floodOpacity="0.45" result="tint" />
              <feComposite in="tint" in2="ring" operator="in" />
            </filter>
          </defs>
          <g transform="translate(-34104 -8123.9)" filter={`url(#${filterId})`}>
            <polygon fill="#fff" points="34578 8756.3 38671 8756.3 38671 8333 34578 8333" />
            <polygon fill="#fff" points="36977 10270 37436 10270 37436 9955.8 38177 9955.8 38177 10270 38671 10270 38671 9497.2 36977 9497.2" />
            <polygon fill="#fff" points="34543 12216 35037 12216 35037 10077 34543 10077" />
            <polygon fill="#fff" points="35778 12216 36236 12216 36236 10077 35778 10077" />
            <polygon fill="#fff" points="38177 12216 38671 12216 38671 10270 38177 10270" />
            <polygon fill="#fff" points="36977 12216 37436 12216 37436 10270 36977 10270" />
            <polygon fill="#fff" points="34543 10077 35037 10077 35037 9955.8 35778 9955.8 35778 10077 36236 10077 36236 9497.2 34543 9497.2" />
            <polygon fill="#fff" points="35778 13152 37436 13152 37436 12216 36977 12216 36977 13131 36236 13131 36236 12216 35778 12216" />
            <polygon fill="#fff" points="37436 13152 35778 13152 35778 13589 37436 13589" />
            <polygon fill="#fff" points="35037 12216 34543 12216 34543 13166 35037 13166" />
            <polygon fill="#fff" points="38671 12216 38177 12216 38177 13166 38671 13166" />
          </g>
        </svg>
      </Box>
      <Box
        position="absolute"
        left={0}
        right={0}
        bottom={0}
        h="22px"
        pointerEvents="none"
        background={`linear-gradient(180deg, ${tokens.colors.bg.app}00 0%, ${tokens.colors.bg.app} 100%)`}
      />
    </Box>
  )
}

function ChatSuggestions({ children }: { children?: ReactNode }) {
  const period = emptySessionPeriod(new Date().getHours())
  const greeting = t(GREETING_KEY[period])

  return (
    <MotionBox
      position="relative"
      w="100%"
      flexShrink={0}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <Box
        position="absolute"
        left="50%"
        bottom="100%"
        transform="translateX(-50%)"
        display="flex"
        flexDirection="column"
        alignItems="center"
        mb={{ base: 5, md: 6 }}
        pointerEvents="none"
      >
        <BrandMarkOutline />
        <Text
          as="h1"
          mt="-6px"
          w="max-content"
          maxW="min(640px, 92vw)"
          zIndex={1}
          fontSize={{ base: '26px', md: '34px' }}
          fontWeight="600"
          color={tokens.colors.text.inverse}
          letterSpacing="-0.035em"
          lineHeight="1.2"
          textAlign="center"
        >
          {greeting}
        </Text>
      </Box>

      <Box position="relative" zIndex={3}>
        {children}
      </Box>
    </MotionBox>
  )
}

export default memo(ChatSuggestions)
