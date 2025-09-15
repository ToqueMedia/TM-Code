// src/components/ui/provider.tsx
import { ChakraProvider } from '@chakra-ui/react'
import { theme } from '../../theme'

export function Provider(props: React.PropsWithChildren) {
  return <ChakraProvider value={theme}>{props.children}</ChakraProvider>
}