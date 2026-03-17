import React from 'react'
import { Box, Flex, Heading, Text, Icon } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { IconType } from 'react-icons'

interface WelcomeFeatureCardProps {
  icon: IconType
  title: string
  description: string
  shortcut: string
  color: string
  onClick?: () => void
}

const WelcomeFeatureCard: React.FC<WelcomeFeatureCardProps> = ({
  icon,
  title,
  description,
  shortcut,
  color,
  onClick,
}) => {
  return (
    <Box
      bg="rgba(255, 255, 255, 0.05)"
      backdropFilter="blur(16px)"
      border="1px solid"
      borderColor="rgba(254, 16, 99, 0.15)"
      borderRadius="20px"
      p={7}
      cursor="pointer"
      position="relative"
      overflow="hidden"
      _hover={{
        transform: 'translateY(-6px)',
        borderColor: `${color}80`,
        bg: 'rgba(255, 255, 255, 0.08)',
        boxShadow: `0 20px 40px -12px ${color}30`,
      }}
      transition="all 0.35s cubic-bezier(0.4, 0, 0.2, 1)"
      onClick={onClick}
    >
      {/* Top gradient line */}
      <Box
        position="absolute"
        top="0"
        left="0"
        right="0"
        height="2px"
        background={`linear-gradient(90deg, transparent, ${color}, transparent)`}
        opacity={0.6}
      />

      {/* Floating radial glow */}
      <Box
        position="absolute"
        top="-30px"
        right="-30px"
        width="100px"
        height="100px"
        bg={`radial-gradient(circle, ${color}15 0%, transparent 70%)`}
        borderRadius="full"
        pointerEvents="none"
      />

      <Flex
        width="48px"
        height="48px"
        borderRadius="14px"
        alignItems="center"
        justifyContent="center"
        mb={5}
        bg="rgba(255, 255, 255, 0.05)"
        border="1px solid"
        borderColor={`${color}30`}
        transition="all 0.3s ease"
        _groupHover={{
          transform: 'scale(1.1) rotate(5deg)',
        }}
      >
        <Icon color={color} fontSize="22px">
          {React.createElement(icon)}
        </Icon>
      </Flex>

      <Heading
        fontSize="16px"
        fontWeight="700"
        mb={2}
        color="white"
      >
        {title}
      </Heading>

      <Text
        fontSize="13px"
        color={tokens.colors.text.secondary}
        lineHeight="1.6"
        mb={4}
      >
        {description}
      </Text>

      <Text
        fontSize="11px"
        color={tokens.colors.text.muted}
        bg="rgba(255, 255, 255, 0.05)"
        border="1px solid rgba(255, 255, 255, 0.06)"
        px={2}
        py={0.5}
        borderRadius="6px"
        display="inline-block"
        fontFamily={tokens.fontFamily.mono}
        letterSpacing="0.5px"
      >
        {shortcut}
      </Text>
    </Box>
  )
}

export default WelcomeFeatureCard
