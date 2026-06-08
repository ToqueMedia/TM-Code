import React from 'react'
import { Box, Button, Flex, Heading, Text, VStack, Link } from '@chakra-ui/react'
import { FiAlertTriangle, FiRefreshCw, FiExternalLink } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import type { EnvironmentCheckResult } from '@/services/environmentCheck'
import { GLOBAL_REQUIREMENTS } from '@/services/startupRequirements'

interface RequirementsErrorScreenProps {
  result: EnvironmentCheckResult
  onRetry: () => void
}

export const RequirementsErrorScreen: React.FC<RequirementsErrorScreenProps> = ({ result, onRetry }) => {
  const [isRetrying, setIsRetrying] = React.useState(false)

  const handleRetry = async () => {
    setIsRetrying(true)
    await onRetry()
    setIsRetrying(false)
  }

  const missingMandatory = GLOBAL_REQUIREMENTS.filter(req => {
    if (!req.mandatory) return false
    const status = result?.requirements?.[req.name]
    return !status || !status.meetsMinimum
  })

  const getStatus = (reqName: string) => result?.requirements?.[reqName]

  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      height="100vh"
      bg={tokens.colors.bg.app}
      color={tokens.colors.text.primary}
      p={8}
      textAlign="center"
    >
      <VStack gap={6} maxW="500px">
        <Box
          bg="rgba(254, 16, 99, 0.1)"
          p={6}
          borderRadius="full"
          color={tokens.colors.accent.red}
        >
          <FiAlertTriangle size={48} />
        </Box>

        <VStack gap={2}>
          <Heading size="lg" fontWeight="800">
            Requisitos incompatíveis
          </Heading>
          <Text color={tokens.colors.text.secondary} fontSize="15px">
            O TM Code precisa destas ferramentas com versões compatíveis para funcionar corretamente.
          </Text>
        </VStack>

        <VStack align="stretch" w="100%" gap={3} mt={4}>
          {missingMandatory.map(req => {
            const status = getStatus(req.name)
            const isOutdated = !!status?.found && !status.meetsMinimum
            return (
            <Box
              key={req.name}
              bg={tokens.colors.bg.card}
              border="1px solid"
              borderColor={tokens.colors.border.default}
              borderRadius={tokens.radius.xl}
              p={4}
              textAlign="left"
            >
              <Flex justify="space-between" align="center" mb={2}>
                <Text fontWeight="700" fontSize="14px">
                  {req.name}
                </Text>
                <Link
                  href={req.installUrl}
                  target="_blank"
                  color={tokens.colors.accent.primary}
                  fontSize="12px"
                  display="flex"
                  alignItems="center"
                  gap={1}
                >
                  Download <FiExternalLink size={10} />
                </Link>
              </Flex>
              <Text fontSize="12px" color={tokens.colors.text.muted}>
                {isOutdated
                  ? `Encontrado ${status?.version ?? 'versão desconhecida'} — mínimo necessário ${req.minVersion}. ${req.installHint}`
                  : `Não encontrado. ${req.installHint}`}
              </Text>
            </Box>
            )
          })}
        </VStack>

        <Button
          mt={6}
          size="lg"
          bg={tokens.colors.accent.primary}
          color="white"
          _hover={{ bg: tokens.colors.accent.primaryDark }}
          onClick={handleRetry}
          loading={isRetrying}
          borderRadius={tokens.radius.lg}
          px={8}
        >
          <FiRefreshCw size={18} className={isRetrying ? 'spin' : ''} style={{ marginRight: 8 }} />
          Verificar novamente
        </Button>

        <Text fontSize="11px" color={tokens.colors.text.disabled} mt={4}>
          Após instalar as ferramentas, poderá ser necessário reiniciar a aplicação ou o computador para que as alterações no PATH tenham efeito.
        </Text>
      </VStack>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .spin {
          animation: spin 1s linear infinite;
        }
      `}</style>
    </Flex>
  )
}
