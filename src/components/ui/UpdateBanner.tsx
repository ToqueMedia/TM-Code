import { memo, useState } from 'react'
import { Box, Button, Flex, Text, HStack, Badge } from '@chakra-ui/react'
import { motion, AnimatePresence } from 'framer-motion'
import { useUpdateStore } from '../../stores/updateStore'
import { installUpdate } from '../../services/updateService'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'
import { FiDownload, FiClock } from 'react-icons/fi'

const MotionBox = motion.create(Box)

function UpdateBanner() {
  const t = useTranslation()
  const { pendingUpdate, isBannerVisible, snoozeBanner } = useUpdateStore()
  const [isUpdating, setIsUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleUpdate = async () => {
    setIsUpdating(true)
    setError(null)
    try {
      await installUpdate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsUpdating(false)
    }
  }

  if (!pendingUpdate || !isBannerVisible) return null

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
          minWidth: '460px'
        }}
      >
        <Box
          position="relative"
          overflow="hidden"
          p="1px" // Border gradient trick
          borderRadius="14px"
          bgGradient={`linear(to-br, ${tokens.colors.accent.primary}aa, ${tokens.colors.accent.purple}aa)`}
          boxShadow="0 12px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)"
        >
          <Box
            bg="rgba(15, 15, 15, 0.85)"
            backdropFilter="blur(16px)"
            borderRadius="13px"
            px={5}
            py={3}
          >
            <Flex align="center" justify="space-between" gap={8}>
              <HStack gap={4}>
                <Box position="relative">
                  <MotionBox
                    animate={{ 
                      scale: [1, 1.2, 1],
                      opacity: [0.5, 0.2, 0.5]
                    }}
                    transition={{ 
                      duration: 2, 
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                    position="absolute"
                    inset="-4px"
                    bg={tokens.colors.accent.primary}
                    borderRadius="full"
                    filter="blur(8px)"
                  />
                  <Flex 
                    bgGradient={`linear(to-tr, ${tokens.colors.accent.primary}, ${tokens.colors.accent.purple})`}
                    w="36px" h="36px"
                    borderRadius="10px"
                    align="center" justify="center"
                    color="white"
                    boxShadow="0 4px 12px rgba(254, 16, 99, 0.3)"
                    position="relative"
                  >
                    <FiDownload size={18} />
                  </Flex>
                </Box>

                <Box>
                  <HStack gap={2} mb={0.5}>
                    <Text fontSize="14px" fontWeight="700" color="white" letterSpacing="-0.01em">
                      TM Code
                    </Text>
                    <Badge 
                      bg="rgba(254, 16, 99, 0.15)" 
                      color={tokens.colors.accent.primary}
                      fontSize="10px"
                      px={2}
                      borderRadius="full"
                      border="1px solid rgba(254, 16, 99, 0.2)"
                    >
                      v{pendingUpdate.version}
                    </Badge>
                  </HStack>
                  <Text fontSize="12px" color="whiteAlpha.800" fontWeight="500">
                    {error ? (
                      <Text as="span" color="red.300">{error}</Text>
                    ) : (
                      t('settings.updateAvailable')
                    )}
                  </Text>
                </Box>
              </HStack>

              <HStack gap={3}>
                <Button
                  size="xs"
                  variant="ghost"
                  color="whiteAlpha.700"
                  _hover={{ color: "white", bg: "whiteAlpha.100" }}
                  onClick={snoozeBanner}
                  disabled={isUpdating}
                  fontSize="12px"
                  fontWeight="600"
                  h="30px"
                  px={3}
                  borderRadius="8px"
                >
                  <FiClock size={13} style={{ marginRight: 6 }} />
                  {t('common.later')}
                </Button>
                
                <Button
                  size="xs"
                  bg={tokens.colors.accent.primary}
                  color="white"
                  _hover={{ 
                    bg: tokens.colors.accent.primaryHover,
                    transform: "translateY(-1px)",
                    boxShadow: "0 4px 12px rgba(254, 16, 99, 0.4)"
                  }}
                  _active={{ transform: "translateY(0)" }}
                  fontWeight="700"
                  fontSize="12px"
                  h="30px"
                  px={4}
                  borderRadius="8px"
                  onClick={handleUpdate}
                  loading={isUpdating}
                  loadingText={t('settings.updateDownloading')}
                  transition="all 0.2s"
                >
                  {t('settings.updateNow')}
                </Button>
              </HStack>
            </Flex>
          </Box>
        </Box>
      </MotionBox>
    </AnimatePresence>
  )
}

export default memo(UpdateBanner)
