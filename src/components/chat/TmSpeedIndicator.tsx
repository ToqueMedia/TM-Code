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
      // Degradado (toggle ON mas o worker não serviu speed → SEM 3x): esmaecido
      // e com sufixo "pendente". Só sólido quando `applied` = a cobrar 3x, para
      // o badge não dar a entender uma cobrança que não está a acontecer.
      bg={applied ? 'rgba(210, 153, 34, 0.12)' : 'rgba(210, 153, 34, 0.05)'}
      border={`1px solid ${applied ? 'rgba(210, 153, 34, 0.3)' : 'rgba(210, 153, 34, 0.15)'}`}
      color={tokens.colors.accent.orange}
      opacity={applied ? 1 : 0.6}
      title={applied ? t('speed.indicatorTooltip') : t('speed.indicatorTooltipPending')}
    >
      <Text fontSize="10px" fontWeight="600" letterSpacing="0.02em">
        ⚡ {t('speed.indicator')}{applied ? '' : ` ${t('speed.indicatorPendingSuffix')}`}
      </Text>
    </Flex>
  )
}
