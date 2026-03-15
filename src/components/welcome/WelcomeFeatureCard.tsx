import React from 'react'
import { Box, Flex, Heading, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'

interface WelcomeFeatureCardProps {
  icon: string
  title: string
  description: string
  shortcut: string
  gradient: string
  iconShadow: string
  onClick?: () => void
}

const WelcomeFeatureCard: React.FC<WelcomeFeatureCardProps> = ({
  icon,
  title,
  description,
  shortcut,
  gradient,
  iconShadow,
  onClick,
}) => {
  return (
    <Box
      bg={tokens.colors.bg.card}
      backdropFilter="blur(20px)"
      border={`1px solid ${tokens.colors.bg.cardBorder}`}
      borderRadius="16px"
      p={6}
      cursor="pointer"
      position="relative"
      overflow="hidden"
      _hover={{
        transform: 'translateY(-8px)',
        borderColor: tokens.colors.accent.primaryBorder,
        boxShadow: tokens.shadow.cardHover,
      }}
      transition="all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
      onClick={onClick}
    >
      <Box
        position="absolute"
        top="0"
        left="0"
        right="0"
        height="2px"
        background={tokens.gradient.cardLine}
        transform="translateX(-100%)"
        transition="transform 0.6s ease"
        _groupHover={{
          transform: 'translateX(100%)',
        }}
      />
      <Flex
        width="64px"
        height="64px"
        borderRadius="12px"
        alignItems="center"
        justifyContent="center"
        fontSize="28px"
        mb={5}
        background={gradient}
        boxShadow={iconShadow}
      >
        {icon}
      </Flex>
      <Heading fontSize="20px" fontWeight="600" mb={2} color={tokens.colors.text.primary}>
        {title}
      </Heading>
      <Text fontSize="14px" color={tokens.colors.text.secondary} lineHeight="1.5" mb={4}>
        {description}
      </Text>
      <Text
        fontSize="12px"
        color={tokens.colors.text.muted}
        bg={tokens.colors.badge.bg}
        p={1}
        borderRadius="4px"
        display="inline-block"
      >
        {shortcut}
      </Text>
    </Box>
  )
}

export default WelcomeFeatureCard
