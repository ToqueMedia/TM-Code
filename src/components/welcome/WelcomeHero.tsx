import React, { useEffect } from 'react'
import {
  Box,
  Flex,
  Grid,
  Heading,
  Text,
  VStack,
  HStack,
  Icon,
} from '@chakra-ui/react'
import { motion } from 'framer-motion'
import {
  LuMessageSquare,
  LuRocket,
  LuFolderOpen,
  LuGitBranch,
  LuTerminal,
  LuChevronRight,
  LuMonitor,
  LuWrench,
  LuBot,
} from 'react-icons/lu'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { GoalCelebration } from '../celebration/GoalCelebration'
import { WorldCupBadge } from '../celebration/WorldCupBadge'
import { FOOTBALL_MODE_ENABLED } from '@/utils/worldCup'
import { triggerGoalCelebration } from '@/stores/celebrationStore'

const MotionBox = motion.create(Box)

// Module-scoped so the kick-off burst plays at most once per app launch — not
// every time the user bounces back to the Welcome hero from a project/settings.
let welcomeKickoffPlayed = false

interface WelcomeHeroProps {
  onNewProject: () => void
  onOpenFolder: () => void
  onCloneRepository: () => void
  onCmdMode: () => void
  children?: React.ReactNode
}

const stagger = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.12, delayChildren: 0.1 },
  },
}

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] as const },
  },
}

const WelcomeHero: React.FC<WelcomeHeroProps> = ({
  onNewProject,
  onOpenFolder,
  onCloneRepository,
  onCmdMode,
  children,
}) => {
  const isMac = navigator.platform.toLowerCase().includes('mac')
  const mod = isMac ? '⌘' : 'Ctrl'

  // Kick-off burst — a one-shot goal celebration when the hero first appears
  // (the welcome screen has no agent run to "score" against). Guarded to once
  // per launch and to a short delay so the hero has painted first.
  useEffect(() => {
    if (!FOOTBALL_MODE_ENABLED || welcomeKickoffPlayed) return
    welcomeKickoffPlayed = true
    const tmo = setTimeout(() => triggerGoalCelebration('welcome_kickoff'), 700)
    return () => clearTimeout(tmo)
  }, [])

  return (
    <Flex
      flex="1"
      direction="column"
      align="center"
      justify="center"
      overflowY="auto"
      position="relative"
      px={8}
      py={6}
    >
      {/* Goal celebration overlay (World Cup 2026) — absolute, pointer-events none. */}
      <GoalCelebration />
      <MotionBox
        maxW="820px"
        w="full"
        variants={stagger}
        initial="hidden"
        animate="visible"
      >
        {/* Header */}
        <MotionBox variants={fadeUp}>
          {/* Seasonal eyebrow badge */}
          <Box mb={3}>
            <WorldCupBadge />
          </Box>
          <Heading
            fontSize="28px"
            fontWeight="700"
            color={tokens.colors.text.primary}
            mb={2}
          >
            {t('welcome.title')}{' '}
            <Text
              as="span"
              style={{
                background: tokens.gradient.accentPrimary,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              TM Code
            </Text>
          </Heading>
          <Text
            fontSize="15px"
            color={tokens.colors.text.secondary}
            mb={8}
          >
            {t('welcome.subtitle')}
          </Text>
        </MotionBox>

        {/* Promo banner (if applicable) */}
        {children && <MotionBox variants={fadeUp}>{children}</MotionBox>}

        {/* Two mode cards */}
        <Grid
          templateColumns={{ base: '1fr', md: '1fr 1fr' }}
          gap={5}
          mt={children ? 4 : 0}
          alignItems="stretch"
        >
          {/* ── Chat Mode ─────────────────────────────────────── */}
          <MotionBox
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            h="full"
            display="flex"
            flexDirection="column"
          >
            <Box
              bg="rgba(255, 255, 255, 0.05)"
              backdropFilter="blur(16px)"
              border="1px solid"
              borderColor="rgba(254, 16, 99, 0.2)"
              borderRadius="20px"
              p={6}
              position="relative"
              overflow="hidden"
              flex="1"
              display="flex"
              flexDirection="column"
              transition="all 0.35s cubic-bezier(0.4, 0, 0.2, 1)"
              _hover={{
                borderColor: `${tokens.colors.accent.primary}60`,
                bg: 'rgba(255, 255, 255, 0.08)',
                boxShadow: `0 20px 40px -12px ${tokens.colors.accent.primary}25`,
              }}
            >
              {/* Top gradient line */}
              <Box
                position="absolute"
                top="0"
                left="0"
                right="0"
                height="2px"
                background={`linear-gradient(90deg, transparent, ${tokens.colors.accent.primary}, transparent)`}
                opacity={0.6}
              />

              {/* Floating glow */}
              <Box
                position="absolute"
                top="-40px"
                right="-40px"
                width="120px"
                height="120px"
                bg={`radial-gradient(circle, ${tokens.colors.accent.primary}12 0%, transparent 70%)`}
                borderRadius="full"
                pointerEvents="none"
              />

              {/* Icon + Title + Tag */}
              <Flex align="center" gap={3} mb={4}>
                <Flex
                  width="44px"
                  height="44px"
                  borderRadius="12px"
                  align="center"
                  justify="center"
                  bg={`${tokens.colors.accent.primary}15`}
                >
                  <Icon
                    as={LuMessageSquare}
                    fontSize="22px"
                    color={tokens.colors.accent.primary}
                  />
                </Flex>
                <Box flex="1">
                  <Heading fontSize="17px" fontWeight="600" color={tokens.colors.text.primary}>
                    {t('welcome.chatMode')}
                  </Heading>
                </Box>
                <Box
                  px={2.5}
                  py={0.5}
                  borderRadius="full"
                  bg={`${tokens.colors.accent.primary}18`}
                  border="1px solid"
                  borderColor={`${tokens.colors.accent.primary}30`}
                >
                  <Text fontSize="10px" fontWeight="700" color={tokens.colors.accent.primary} letterSpacing="0.3px">
                    {t('welcome.recommended')}
                  </Text>
                </Box>
              </Flex>

              <Text fontSize="13px" color={tokens.colors.text.secondary} lineHeight="1.5" mb={5}>
                {t('welcome.chatModeDesc')}
              </Text>

              {/* Sub-actions */}
              <VStack align="stretch" gap={1}>
                {[
                  {
                    icon: LuRocket,
                    label: t('welcome.newProject'),
                    desc: t('welcome.newProjectDesc'),
                    color: tokens.colors.accent.primary,
                    shortcut: `${mod}+N`,
                    onClick: onNewProject,
                  },
                  {
                    icon: LuFolderOpen,
                    label: t('welcome.openProject'),
                    desc: t('welcome.openProjectDesc'),
                    color: tokens.colors.accent.greenBright,
                    shortcut: `${mod}+O`,
                    onClick: onOpenFolder,
                  },
                  {
                    icon: LuGitBranch,
                    label: t('welcome.cloneRepo'),
                    desc: t('welcome.cloneRepoDesc'),
                    color: tokens.colors.accent.purple,
                    shortcut: isMac ? '⌘+⇧+C' : 'Ctrl+Shift+C',
                    onClick: onCloneRepository,
                  },
                ].map((action) => (
                  <Flex
                    key={action.label}
                    align="center"
                    gap={3}
                    py={2.5}
                    px={3}
                    borderRadius="12px"
                    cursor="pointer"
                    transition="all 0.2s ease"
                    _hover={{
                      bg: 'rgba(255, 255, 255, 0.06)',
                      transform: 'translateX(4px)',
                    }}
                    onClick={action.onClick}
                  >
                    <Flex
                      width="32px"
                      height="32px"
                      borderRadius="10px"
                      align="center"
                      justify="center"
                      bg={`${action.color}15`}
                      flexShrink={0}
                    >
                      <Icon
                        as={action.icon}
                        fontSize="15px"
                        color={action.color}
                      />
                    </Flex>
                    <Box flex="1" minW={0}>
                      <Flex align="center" gap={2}>
                        <Text fontSize="13px" fontWeight="500" color={tokens.colors.text.primary}>
                          {action.label}
                        </Text>
                        <Box
                          px={1.5}
                          py={0}
                          borderRadius="4px"
                          bg="rgba(255, 255, 255, 0.06)"
                          border="1px solid"
                          borderColor="rgba(255, 255, 255, 0.08)"
                        >
                          <Text fontSize="10px" fontFamily="mono" color={tokens.colors.text.muted} lineHeight="16px">
                            {action.shortcut}
                          </Text>
                        </Box>
                      </Flex>
                      <Text fontSize="11px" color={tokens.colors.text.muted} lineHeight="1.3" lineClamp={1}>
                        {action.desc}
                      </Text>
                    </Box>
                    <Icon as={LuChevronRight} fontSize="14px" color={tokens.colors.text.muted} opacity={0.5} />
                  </Flex>
                ))}
              </VStack>
            </Box>
          </MotionBox>

          {/* ── Terminal Mode ─────────────────────────────────── */}
          <MotionBox
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            h="full"
            display="flex"
            flexDirection="column"
          >
            <Box
              bg="rgba(255, 255, 255, 0.05)"
              backdropFilter="blur(16px)"
              border="1px solid"
              borderColor="rgba(163, 113, 247, 0.2)"
              borderRadius="20px"
              p={6}
              position="relative"
              overflow="hidden"
              cursor="pointer"
              flex="1"
              display="flex"
              flexDirection="column"
              transition="all 0.35s cubic-bezier(0.4, 0, 0.2, 1)"
              _hover={{
                borderColor: `${tokens.colors.accent.purple}60`,
                bg: 'rgba(255, 255, 255, 0.08)',
                boxShadow: `0 20px 40px -12px ${tokens.colors.accent.purple}25`,
              }}
              onClick={onCmdMode}
            >
              {/* Top gradient line */}
              <Box
                position="absolute"
                top="0"
                left="0"
                right="0"
                height="2px"
                background={`linear-gradient(90deg, transparent, ${tokens.colors.accent.purple}, transparent)`}
                opacity={0.6}
              />

              {/* Floating glow */}
              <Box
                position="absolute"
                top="-40px"
                right="-40px"
                width="120px"
                height="120px"
                bg={`radial-gradient(circle, ${tokens.colors.accent.purple}12 0%, transparent 70%)`}
                borderRadius="full"
                pointerEvents="none"
              />

              {/* Icon + Title + Tag */}
              <Flex align="center" gap={3} mb={4}>
                <Flex
                  width="44px"
                  height="44px"
                  borderRadius="12px"
                  align="center"
                  justify="center"
                  bg={`${tokens.colors.accent.purple}15`}
                >
                  <Icon
                    as={LuTerminal}
                    fontSize="22px"
                    color={tokens.colors.accent.purple}
                  />
                </Flex>
                <Heading fontSize="17px" fontWeight="600" color={tokens.colors.text.primary}>
                  {t('welcome.terminalMode')}
                </Heading>
                <Box
                  px={2.5}
                  py={0.5}
                  borderRadius="full"
                  bg="rgba(255, 255, 255, 0.06)"
                  border="1px solid"
                  borderColor="rgba(255, 255, 255, 0.1)"
                >
                  <Text fontSize="10px" fontWeight="700" color={tokens.colors.text.secondary} letterSpacing="0.3px">
                    {t('welcome.powerUsers')}
                  </Text>
                </Box>
              </Flex>

              <Text fontSize="13px" color={tokens.colors.text.secondary} lineHeight="1.5" mb={5}>
                {t('welcome.terminalModeDesc')}
              </Text>

              {/* Capability chips */}
              <HStack gap={2} mb={6} flexWrap="wrap">
                {[
                  { icon: LuMonitor, label: t('welcome.capShell'), color: tokens.colors.accent.purple },
                  { icon: LuWrench, label: t('welcome.capAnyStack'), color: tokens.colors.accent.greenBright },
                  { icon: LuBot, label: t('welcome.capAgentic'), color: tokens.colors.accent.orange },
                ].map((cap) => (
                  <Flex
                    key={cap.label}
                    align="center"
                    gap={1.5}
                    px={2.5}
                    py={1}
                    borderRadius="10px"
                    bg={`${cap.color}10`}
                    border="1px solid"
                    borderColor={`${cap.color}20`}
                  >
                    <Icon as={cap.icon} fontSize="12px" color={cap.color} />
                    <Text fontSize="11px" fontWeight="500" color={cap.color}>
                      {cap.label}
                    </Text>
                  </Flex>
                ))}
              </HStack>

              {/* CTA button — pushed to bottom to align with Chat card */}
              <Flex
                align="center"
                justify="center"
                gap={2}
                mt="auto"
                bg={`${tokens.colors.accent.purple}20`}
                border="1px solid"
                borderColor={`${tokens.colors.accent.purple}40`}
                borderRadius="14px"
                py={3}
                px={5}
                transition="all 0.25s"
                _hover={{
                  bg: `${tokens.colors.accent.purple}30`,
                  borderColor: `${tokens.colors.accent.purple}60`,
                  transform: 'translateY(-1px)',
                }}
              >
                <Icon as={LuFolderOpen} fontSize="16px" color={tokens.colors.accent.purple} />
                <Text fontSize="14px" fontWeight="600" color={tokens.colors.accent.purple}>
                  {t('welcome.chooseFolder')}
                </Text>
              </Flex>
            </Box>
          </MotionBox>
        </Grid>
      </MotionBox>
    </Flex>
  )
}

export default WelcomeHero
