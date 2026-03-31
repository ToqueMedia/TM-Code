import { memo } from 'react'
import { Box } from '@chakra-ui/react'

interface AgentLogoProps {
  /** Size in pixels */
  size?: number
  /** Show glow shadow */
  glow?: boolean
}

function AgentLogo({ size = 22, glow = false }: AgentLogoProps) {
  return (
    <Box
      w={`${size}px`}
      h={`${size}px`}
      borderRadius={`${Math.round(size * 0.27)}px`}
      flexShrink={0}
      boxShadow={glow ? '0 2px 8px rgba(254, 16, 99, 0.25)' : 'none'}
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg="rgba(254, 16, 99, 0.08)"
    >
      <img
        src="/isologo.svg"
        alt="TM Code"
        style={{
          display: 'block',
          width: '70%',
          height: '70%',
          objectFit: 'contain',
        }}
      />
    </Box>
  )
}

export default memo(AgentLogo)
