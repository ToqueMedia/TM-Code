import { Box } from '@chakra-ui/react'
import { VscArrowSwap, VscRadioTower, VscServer } from 'react-icons/vsc'
import type { PeerPath } from '@/services/collab/collabMesh'
import { useTranslation } from '@/i18n'
import { tokens } from '@/theme/tokens'

/**
 * Tiny connection-path badge for a teammate: how MY traffic to them flows.
 * Evidência visual pedida pelo utilizador para validar o fix do P2P direto em
 * Windows — setas trocadas = direto, servidor = TURN, antena = relay DO
 * (dados apenas, sem media).
 * Renderiza nada enquanto o caminho é desconhecido (ICE ainda a decidir) —
 * um estado "connecting" só piscaria durante ~1s e confundiria mais do que
 * informa.
 */
export function PeerPathBadge({ path, size = 11 }: { path: PeerPath | undefined; size?: number }) {
  const t = useTranslation()
  if (!path) return null
  const visual = {
    direct: { icon: <VscArrowSwap size={size} />, color: tokens.colors.accent.greenBright, label: t('team.pathDirect') },
    turn: { icon: <VscServer size={size} />, color: tokens.colors.accent.orangeBright, label: t('team.pathTurn') },
    relay: { icon: <VscRadioTower size={size} />, color: tokens.colors.accent.red, label: t('team.pathRelay') },
  }[path]
  return (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      flexShrink={0}
      color={visual.color}
      title={visual.label}
      aria-label={visual.label}
    >
      {visual.icon}
    </Box>
  )
}
