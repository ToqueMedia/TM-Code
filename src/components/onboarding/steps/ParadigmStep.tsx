import { Box, Flex, Text } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import OnboardingNav from '../OnboardingNav'

interface ParadigmStepProps {
  onNext: () => void
  onBack: () => void
}

const MotionBox = motion.create(Box)

/* Simulated IDE silhouettes — pure CSS, no external assets */
function TraditionalIDE() {
  return (
    <Box
      width="100%"
      height="160px"
      borderRadius="10px"
      border={`1px solid ${tokens.colors.border.default}`}
      bg={tokens.colors.bg.panel}
      overflow="hidden"
      opacity={0.5}
    >
      <Flex height="20px" bg={tokens.colors.bg.sidebar} align="center" px={2} gap="4px">
        <Box width="6px" height="6px" borderRadius="full" bg={tokens.colors.windowControl.close} />
        <Box width="6px" height="6px" borderRadius="full" bg={tokens.colors.windowControl.minimize} />
        <Box width="6px" height="6px" borderRadius="full" bg={tokens.colors.windowControl.maximize} />
      </Flex>
      <Flex flex="1" height="140px">
        <Box flex="3" p={2}>
          {[...Array(7)].map((_, i) => (
            <Box
              key={i}
              height="6px"
              borderRadius="2px"
              bg={tokens.colors.bg.hoverSubtle}
              mb="5px"
              width={`${55 + Math.sin(i * 1.5) * 25}%`}
            />
          ))}
        </Box>
        <Box width="60px" borderLeft={`1px solid ${tokens.colors.border.default}`} p={1.5}>
          <Box height="6px" borderRadius="2px" bg="rgba(254, 16, 99, 0.15)" mb="4px" width="80%" />
          <Box height="6px" borderRadius="2px" bg={tokens.colors.bg.hoverSubtle} mb="4px" width="90%" />
          <Box height="6px" borderRadius="2px" bg={tokens.colors.bg.hoverSubtle} width="60%" />
        </Box>
      </Flex>
    </Box>
  )
}

function TMCodeIDE() {
  return (
    <Box
      width="100%"
      height="160px"
      borderRadius="10px"
      border={`1px solid ${tokens.colors.accent.primaryBorder}`}
      bg={tokens.colors.bg.panel}
      overflow="hidden"
      boxShadow="0 0 30px rgba(254, 16, 99, 0.08)"
    >
      <Flex height="20px" bg={tokens.colors.bg.sidebar} align="center" px={2} gap="4px">
        <Box width="6px" height="6px" borderRadius="full" bg={tokens.colors.windowControl.close} />
        <Box width="6px" height="6px" borderRadius="full" bg={tokens.colors.windowControl.minimize} />
        <Box width="6px" height="6px" borderRadius="full" bg={tokens.colors.windowControl.maximize} />
      </Flex>
      <Flex flex="1" height="140px">
        <Box flex="2" p={2}>
          <Box
            p={1.5}
            mb="6px"
            borderRadius="6px"
            bg={tokens.colors.chat.userBubble}
            border="1px solid rgba(254, 16, 99, 0.12)"
          >
            <Box height="5px" borderRadius="2px" bg="rgba(254, 16, 99, 0.25)" width="75%" mb="3px" />
            <Box height="5px" borderRadius="2px" bg="rgba(254, 16, 99, 0.15)" width="50%" />
          </Box>
          <Box p={1.5} borderRadius="6px" bg={tokens.colors.chat.assistantBubble}>
            <Box height="5px" borderRadius="2px" bg={tokens.colors.bg.hoverSubtle} width="90%" mb="3px" />
            <Box height="5px" borderRadius="2px" bg={tokens.colors.bg.hoverSubtle} width="70%" mb="3px" />
            <Box
              p={1}
              mt={1}
              borderRadius="4px"
              bg={tokens.colors.bg.codeBlock}
              border={`1px solid ${tokens.colors.border.default}`}
            >
              <Box height="4px" borderRadius="1px" bg={tokens.colors.accent.primarySubtle} width="60%" mb="2px" />
              <Box height="4px" borderRadius="1px" bg={tokens.colors.accent.greenSubtle} width="80%" />
            </Box>
          </Box>
        </Box>
        <Box
          width="90px"
          borderLeft={`1px solid ${tokens.colors.border.default}`}
          p={1.5}
          display="flex"
          flexDirection="column"
          gap="4px"
        >
          <Text fontSize="7px" color={tokens.colors.text.muted} fontWeight="500">Preview</Text>
          <Box
            flex="1"
            borderRadius="4px"
            bg={tokens.colors.bg.app}
            border={`1px solid ${tokens.colors.border.default}`}
            p={1}
          >
            <Box height="4px" borderRadius="1px" bg={tokens.colors.accent.primarySubtle} width="70%" mb="3px" />
            <Box height="10px" borderRadius="2px" bg={tokens.colors.bg.hoverSubtle} width="100%" mb="3px" />
            <Box height="4px" borderRadius="1px" bg={tokens.colors.bg.hoverSubtle} width="50%" />
          </Box>
        </Box>
      </Flex>
    </Box>
  )
}

function ParadigmStep({ onNext, onBack }: ParadigmStepProps) {
  const t = useTranslation()

  return (
    <Flex direction="column" align="center" textAlign="center">
      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        mb={2}
      >
        <Text fontSize="24px" fontWeight="700" letterSpacing="-0.3px" lineHeight="1.3">
          {t('onboarding.paradigm.title')}
        </Text>
      </MotionBox>

      <MotionBox
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        mb={8}
      >
        <Text fontSize="13px" color={tokens.colors.text.secondary} lineHeight="1.6" maxWidth="380px">
          {t('onboarding.paradigm.subtitle')}
        </Text>
      </MotionBox>

      <MotionBox
        initial={{ y: 30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        width="100%"
        mb={8}
      >
        <Flex gap={4} width="100%">
          <Box flex="1">
            <TraditionalIDE />
            <Text fontSize="11px" color={tokens.colors.text.muted} mt={2} fontWeight="500">
              {t('onboarding.paradigm.traditional')}
            </Text>
          </Box>
          <Box flex="1">
            <TMCodeIDE />
            <Text fontSize="11px" color={tokens.colors.accent.primary} mt={2} fontWeight="600">
              {t('onboarding.paradigm.tmcode')}
            </Text>
          </Box>
        </Flex>
      </MotionBox>

      <OnboardingNav
        onBack={onBack}
        onNext={onNext}
        backLabel={t('onboarding.back')}
        nextLabel={t('onboarding.continue')}
      />
    </Flex>
  )
}

export default ParadigmStep
