import { memo } from 'react'
import { Box, Flex, Text, HStack } from '@chakra-ui/react'
import { motion, AnimatePresence } from 'framer-motion'
import { FiSlash } from 'react-icons/fi'
import { useAuthStore } from '../../stores/authStore'

const MotionBox = motion.create(Box)

/**
 * Non-dismissable banner shown while the signed-in account is suspended by an
 * admin (users/{uid}.blocked). Mounted globally in App.tsx; the App shell also
 * forces the Welcome screen so Chat/Terminal are unreachable while blocked.
 */
function UserBlockedBanner() {
  const user = useAuthStore(state => state.user)
  const blocked = user?.blocked === true
  const reason = user?.blockedReason

  if (!blocked) return null

  return (
    <AnimatePresence>
      <MotionBox
        initial={{ y: -70, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -70, opacity: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        style={{
          position: 'fixed',
          top: '52px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999,
          width: 'auto',
          minWidth: '460px',
          maxWidth: '90vw',
        }}
      >
        <Box
          position="relative"
          overflow="hidden"
          p="1px"
          borderRadius="14px"
          bgGradient="linear(to-br, rgba(239,68,68,0.8), rgba(190,18,60,0.8))"
          boxShadow="0 12px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)"
        >
          <Box
            bg="rgba(15, 15, 15, 0.9)"
            backdropFilter="blur(16px)"
            borderRadius="13px"
            px={5}
            py={3}
          >
            <Flex align="center" gap={4}>
              <Flex
                bg="rgba(239,68,68,0.18)"
                w="36px"
                h="36px"
                borderRadius="10px"
                align="center"
                justify="center"
                color="red.300"
                flexShrink={0}
              >
                <FiSlash size={18} />
              </Flex>
              <Box>
                <HStack gap={2} mb={0.5}>
                  <Text fontSize="14px" fontWeight="700" color="white" letterSpacing="-0.01em">
                    Conta suspensa
                  </Text>
                </HStack>
                <Text fontSize="12px" color="whiteAlpha.800" fontWeight="500">
                  O acesso foi suspenso por um administrador. Contacte o suporte.
                  {reason && reason !== 'admin' ? (
                    <Text as="span" color="red.200"> ({reason})</Text>
                  ) : null}
                </Text>
              </Box>
            </Flex>
          </Box>
        </Box>
      </MotionBox>
    </AnimatePresence>
  )
}

export default memo(UserBlockedBanner)
