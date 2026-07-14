import React, { useEffect, useRef } from 'react'
import {
  Box,
  Flex,
  Grid,
  Heading,
  Text,
  HStack,
  Icon,
} from '@chakra-ui/react'
import { motion } from 'framer-motion'
import {
  LuMessageSquare,
  LuRocket,
  LuFolderOpen,
  LuGitBranch,
  LuChevronRight,
  LuMonitor,
  LuWrench,
  LuBot,
} from 'react-icons/lu'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { GoalCelebration } from '../celebration/GoalCelebration'
import { WorldCupBadge } from '../celebration/WorldCupBadge'
import { WelcomeRunner } from '../celebration/WelcomeRunner'
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
  children,
}) => {
  const isMac = navigator.platform.toLowerCase().includes('mac')
  const mod = isMac ? '⌘' : 'Ctrl'

  // The seasonal runner jogs across the title and steps up onto the taller
  // "TM Code" wordmark — it measures both to do that (see WelcomeRunner).
  const titleRef = useRef<HTMLDivElement>(null)
  const wordmarkRef = useRef<HTMLSpanElement>(null)

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
          {/* position:relative + reserved top padding give the runner a "track"
              above the title to run, kick and trap the ball in. The padding is
              only added when the seasonal feature is on so nothing shifts when
              it's off. */}
          <Box ref={titleRef} position="relative" pt={FOOTBALL_MODE_ENABLED ? '32px' : 0}>
            <Heading
              fontSize="28px"
              fontWeight="700"
              color={tokens.colors.text.primary}
              mb={2}
            >
              {t('welcome.title')}{' '}
              <span
                ref={wordmarkRef}
                style={{
                  background: tokens.gradient.accentPrimary,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                TM Code
              </span>
            </Heading>
            <WelcomeRunner containerRef={titleRef} stepRef={wordmarkRef} />
          </Box>
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

        {/* Single Chat workspace entry */}
        <MotionBox
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          mt={children ? 4 : 0}
        >
          <Box
            bg="rgba(255, 255, 255, 0.05)"
            backdropFilter="blur(16px)"
            border="1px solid"
            borderColor="rgba(254, 16, 99, 0.22)"
            borderRadius="8px"
            p={{ base: 5, md: 6 }}
            position="relative"
            overflow="hidden"
            transition="all 0.35s cubic-bezier(0.4, 0, 0.2, 1)"
            _hover={{
              borderColor: `${tokens.colors.accent.primary}60`,
              bg: 'rgba(255, 255, 255, 0.08)',
              boxShadow: `0 20px 40px -12px ${tokens.colors.accent.primary}25`,
            }}
          >
            <Box
              position="absolute"
              top="0"
              left="0"
              right="0"
              height="2px"
              background={`linear-gradient(90deg, transparent, ${tokens.colors.accent.primary}, transparent)`}
              opacity={0.65}
            />

            <Flex
              align={{ base: 'flex-start', md: 'center' }}
              justify="space-between"
              gap={4}
              direction={{ base: 'column', md: 'row' }}
              mb={4}
            >
              <Flex align="center" gap={3}>
                <Flex
                  width="44px"
                  height="44px"
                  borderRadius="8px"
                  align="center"
                  justify="center"
                  bg={`${tokens.colors.accent.primary}15`}
                  flexShrink={0}
                >
                  <Icon
                    as={LuMessageSquare}
                    fontSize="22px"
                    color={tokens.colors.accent.primary}
                  />
                </Flex>
                <Box flex="1">
                  <Heading fontSize="18px" fontWeight="650" color={tokens.colors.text.primary}>
                    {t('welcome.chatMode')}
                  </Heading>
                  <Text fontSize="11px" fontWeight="600" color={tokens.colors.accent.primary} mt="1px">
                    {t('welcome.chatModeAudience')}
                  </Text>
                </Box>
              </Flex>

              <Box
                px={2.5}
                py={1}
                borderRadius="6px"
                bg={`${tokens.colors.accent.primary}18`}
                border="1px solid"
                borderColor={`${tokens.colors.accent.primary}30`}
              >
                <Text fontSize="10px" fontWeight="700" color={tokens.colors.accent.primary}>
                  {t('welcome.singleModeBadge')}
                </Text>
              </Box>
            </Flex>

            <Text fontSize="13px" color={tokens.colors.text.secondary} lineHeight="1.55" mb={4} maxW="680px">
              {t('welcome.chatModeDesc')}
            </Text>

            <HStack gap={2} mb={5} flexWrap="wrap">
              {[
                { icon: LuWrench, label: t('welcome.capAnyStack'), color: tokens.colors.accent.greenBright },
                { icon: LuBot, label: t('welcome.capManagedDefaults'), color: tokens.colors.accent.primary },
                { icon: LuMonitor, label: t('welcome.capPreviewDeploy'), color: tokens.colors.accent.orange },
              ].map((cap) => (
                <Flex
                  key={cap.label}
                  align="center"
                  gap={1.5}
                  px={2.5}
                  py={1}
                  borderRadius="6px"
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

            <Grid templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }} gap={3}>
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
                  as="button"
                  key={action.label}
                  align="center"
                  gap={3}
                  py={3}
                  px={3}
                  borderRadius="8px"
                  cursor="pointer"
                  transition="all 0.2s ease"
                  bg="rgba(255, 255, 255, 0.04)"
                  border="1px solid"
                  borderColor="rgba(255, 255, 255, 0.07)"
                  textAlign="left"
                  minH="74px"
                  _hover={{
                    bg: 'rgba(255, 255, 255, 0.07)',
                    transform: 'translateY(-1px)',
                    borderColor: `${action.color}35`,
                  }}
                  onClick={action.onClick}
                >
                  <Flex
                    width="32px"
                    height="32px"
                    borderRadius="8px"
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
                    <Flex align="center" gap={2} minW={0}>
                      <Text fontSize="13px" fontWeight="600" color={tokens.colors.text.primary} lineClamp={1}>
                        {action.label}
                      </Text>
                      <Box
                        px={1.5}
                        py={0}
                        borderRadius="4px"
                        bg="rgba(255, 255, 255, 0.06)"
                        border="1px solid"
                        borderColor="rgba(255, 255, 255, 0.08)"
                        flexShrink={0}
                      >
                        <Text fontSize="10px" fontFamily="mono" color={tokens.colors.text.muted} lineHeight="16px">
                          {action.shortcut}
                        </Text>
                      </Box>
                    </Flex>
                    <Text fontSize="11px" color={tokens.colors.text.muted} lineHeight="1.35" mt={0.5} lineClamp={2}>
                      {action.desc}
                    </Text>
                  </Box>
                  <Icon as={LuChevronRight} fontSize="14px" color={tokens.colors.text.muted} opacity={0.55} />
                </Flex>
              ))}
            </Grid>
          </Box>
        </MotionBox>
      </MotionBox>
    </Flex>
  )
}

export default WelcomeHero
