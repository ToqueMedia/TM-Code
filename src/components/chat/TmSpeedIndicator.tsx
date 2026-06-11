/**
 * TmSpeedIndicator — pill no header do chat quando o TM Speed (`/speed`) está
 * ligado. Renderiza a partir de `enabled` (intenção do utilizador) para o badge
 * aparecer imediatamente após o toggle; o tooltip avisa do consumo 3x. O estado
 * `applied` (worker confirmou na última resposta) ajusta o tooltip quando o
 * speed está ligado mas não está a ser servido (plano não elegível ou
 * speedModel não publicado) — nesse caso não há cobrança 3x.
 */
import { Flex, Text } from '@chakra-ui/react'
import { useTmSpeedStore, isSpeedModelEligible } from '../../stores/tmSpeedStore'
import { useTranslation } from '@/i18n/useTranslation'
import { tokens } from '@/theme/tokens'

export default function TmSpeedIndicator() {
  const t = useTranslation()
  const enabled = useTmSpeedStore(s => s.enabled)
  const applied = useTmSpeedStore(s => s.applied)
  const activeModelId = useTmSpeedStore(s => s.activeModelId)

  if (!enabled) return null
  // Modelo ativo fora da família MiMo V2.5 Pro → o /speed está oculto e o
  // worker degrada sempre; o badge seria intenção sem efeito possível.
  if (!isSpeedModelEligible(activeModelId)) return null

  return (
    <Flex
      align="center"
      gap="4px"
      px="6px"
      py="3px"
      borderRadius="5px"
      bg="rgba(210, 153, 34, 0.12)"
      border="1px solid rgba(210, 153, 34, 0.3)"
      color={tokens.colors.accent.orange}
      title={applied ? t('speed.indicatorTooltip') : t('speed.indicatorTooltipPending')}
    >
      <Text fontSize="10px" fontWeight="600" letterSpacing="0.02em">
        ⚡ {t('speed.indicator')}
      </Text>
    </Flex>
  )
}
