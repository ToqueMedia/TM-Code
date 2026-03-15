import React from 'react'
import {
  Box,
  Flex,
  Grid,
  Heading,
  Text,
  VStack,
  HStack,
} from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import WelcomeFeatureCard from './WelcomeFeatureCard'

interface WelcomeHeroProps {
  onOpenFolder: () => void
}

const featureCards = [
  {
    icon: '🚀',
    title: 'New Project',
    description: 'Create a new project from scratch with templates and boilerplates.',
    shortcut: 'Ctrl+Shift+N',
    gradient: tokens.gradient.accentGreen,
    iconShadow: tokens.shadow.cardIconGreen,
  },
  {
    icon: '📁',
    title: 'Open Folder',
    description: 'Open an existing project folder and start coding immediately.',
    shortcut: 'Ctrl+K Ctrl+O',
    gradient: tokens.gradient.accentPrimary,
    iconShadow: tokens.shadow.cardIconAccent,
  },
  {
    icon: '🔗',
    title: 'Clone Repository',
    description: 'Clone a Git repository from GitHub, GitLab, or any Git server.',
    shortcut: 'Ctrl+Shift+P',
    gradient: tokens.gradient.accentPurple,
    iconShadow: tokens.shadow.cardIconPurple,
  },
  {
    icon: '📦',
    title: 'Import Project',
    description: 'Import existing projects and configure them automatically.',
    shortcut: 'Ctrl+Shift+I',
    gradient: tokens.gradient.accentOrange,
    iconShadow: tokens.shadow.cardIconOrange,
  },
]

const statusItems = [
  { icon: '🔥', label: '12 Projects' },
  { icon: '⚡', label: 'Fast Launch' },
  { icon: '🎯', label: 'Smart Tools' },
]

const WelcomeHero: React.FC<WelcomeHeroProps> = ({ onOpenFolder }) => {
  return (
    <Flex
      flex={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      p={12}
      position="relative"
    >
      <VStack textAlign="center" mb={12}>
        <Heading
          fontSize={{ base: '32px', md: '48px' }}
          fontWeight="800"
          background={tokens.gradient.heroTitle}
          backgroundClip="text"
          color="transparent"
          letterSpacing="-0.5px"
          mb={4}
        >
          Welcome to ToqueMedia Studio
        </Heading>
        <Text
          fontSize="18px"
          color={tokens.colors.text.secondary}
          maxW="500px"
          lineHeight="1.5"
        >
          A powerful, modern IDE built for today's developers.
          Create, code, and deploy with unmatched performance and style.
        </Text>
      </VStack>

      <Grid
        templateColumns={{ base: '1fr', md: 'repeat(auto-fit, minmax(280px, 1fr))' }}
        gap={6}
        maxW="900px"
        w="100%"
      >
        {featureCards.map((card) => (
          <WelcomeFeatureCard
            key={card.title}
            icon={card.icon}
            title={card.title}
            description={card.description}
            shortcut={card.shortcut}
            gradient={card.gradient}
            iconShadow={card.iconShadow}
            onClick={onOpenFolder}
          />
        ))}
      </Grid>

      <HStack position="absolute" bottom={6} right={6} gap={4}>
        {statusItems.map((item) => (
          <HStack key={item.label} gap={2} fontSize="12px" color={tokens.colors.text.muted}>
            <Box
              width="16px"
              height="16px"
              bg={tokens.colors.accent.primaryGlow}
              borderRadius="50%"
              display="flex"
              alignItems="center"
              justifyContent="center"
              fontSize="10px"
            >
              {item.icon}
            </Box>
            <Text>{item.label}</Text>
          </HStack>
        ))}
      </HStack>
    </Flex>
  )
}

export default WelcomeHero
