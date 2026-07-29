import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Box, Flex, Text, VStack } from '@chakra-ui/react'
import { FiBarChart2, FiCheck } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { useAgentStore } from '../../stores/agentStore'
import { useActiveModelStore } from '../../stores/activeModelStore'
import { useReasoningEffortStore } from '../../stores/reasoningEffortStore'
import {
  getEffortOptionsForModel,
  resolveEffectiveEffort,
  resolveEffortModelId,
  effortDescriptionKey,
  shouldSendEffort,
} from '../../services/agent/reasoningEffortModels'
import { t } from '@/i18n'

/**
 * Seletor de reasoning-effort. As opções vêm de um MAPA FRONTEND por modelo
 * (reasoningEffortModels.ts). O modelo ativo é o do ADMIN, lido em tempo-real
 * do activeModelStore (Firestore onSnapshot) com fallback ao header X-TM-Model.
 * Ao trocar de modelo, a lista muda e o effort volta ao default do novo modelo.
 *
 * O dropdown é PORTALADO para document.body — o rodapé do prompt tem
 * overflow:hidden, que cortava um popover posicionado por dentro (parecia que o
 * botão "só ativava/desativava"). Aberto para CIMA (o rodapé está no fundo).
 * Sempre visível no caminho gerido; só escondido em BYOK (gate em PromptActions).
 */

function labelFor(value: string): string {
  if (value === 'xhigh') return 'xHigh'
  if (value === 'on') return t('prompt.effort.on')
  if (value === 'off') return t('prompt.effort.off')
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function EffortSelector() {
  // Modelo ativo: MESMA resolução que buildExtraHeaders / carimbo da mensagem
  // (Firestore → fallback X-TM-Model). Sem isto o seletor e o header divergem.
  const fsModel = useActiveModelStore((s) => s.activeModelId)
  const headerModel = useAgentStore((s) => s.modelName)
  const modelId = resolveEffortModelId(fsModel, headerModel)
  const options = getEffortOptionsForModel(modelId)
  // HONESTIDADE do controlo (auditoria 2026-07-28): para modelos fora do mapa
  // de efforts, o header nunca é enviado (shouldSendEffort=false) — mas o
  // seletor aparecia na mesma, com escala GLM, e o utilizador escolhia
  // valores que morriam no cliente com um carimbo `sent:false`. Um controlo
  // que não controla nada é pior do que nenhum: esconde-se.
  const effortReachesProvider = shouldSendEffort(modelId)
  const selected = useReasoningEffortStore((s) => s.selected)
  const setSelected = useReasoningEffortStore((s) => s.setSelected)
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Posição do menu (portalado). Recalcula ao abrir.
  useLayoutEffect(() => {
    if (open && buttonRef.current) setRect(buttonRef.current.getBoundingClientRect())
  }, [open])

  // Fecha ao clicar fora (botão OU menu — o menu está no portal, fora do botão)
  // ou com Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Valor ativo (exibido) = efetivo: a preferência do user se válida p/ ESTE
  // modelo, senão o default do modelo — a MESMA função que decide o que se envia
  // (buildExtraHeaders), por isso o que se vê é o que se aplica.
  const activeValue = resolveEffectiveEffort(modelId, selected)

  if (!effortReachesProvider) return null

  return (
    <Box flexShrink={0}>
      <Box
        as="button"
        ref={buttonRef}
        data-prompt-tool-button
        display="flex"
        alignItems="center"
        gap="5px"
        h="28px"
        px="8px"
        borderRadius="8px"
        cursor="pointer"
        color={open ? tokens.colors.accent.primary : tokens.colors.text.secondary}
        bg={open ? tokens.colors.accent.primarySubtle : 'transparent'}
        border={`1px solid ${open ? tokens.colors.accent.primaryMuted : 'transparent'}`}
        transition={`all ${tokens.transition.fast}`}
        _hover={{ bg: open ? tokens.colors.accent.primarySubtle : tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('prompt.effort.tooltip')}
        title={t('prompt.effort.tooltip')}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
      >
        <Box display="flex" alignItems="center" flexShrink={0}><FiBarChart2 size={14} /></Box>
        <Text data-prompt-action-label fontSize="11px" fontWeight="600" whiteSpace="nowrap">
          {t('prompt.effort.label')} · {labelFor(activeValue)}
        </Text>
      </Box>

      {open && rect && createPortal(
        <VStack
          ref={menuRef}
          position="fixed"
          left={`${rect.left}px`}
          bottom={`${window.innerHeight - rect.top + 6}px`}
          w="260px"
          maxH="min(60vh, 380px)"
          overflowY="auto"
          bg={tokens.colors.bg.overlay}
          border="1px solid"
          borderColor={tokens.colors.border.panel}
          borderRadius="10px"
          boxShadow="0 12px 32px rgba(0,0,0,0.5)"
          py="6px"
          px="6px"
          gap="2px"
          zIndex={tokens.zIndex.overlay}
          align="stretch"
          role="listbox"
        >
          {options.options.map((v) => {
            const isActive = v === activeValue
            return (
              <Flex
                key={v}
                as="button"
                role="option"
                aria-selected={isActive}
                direction="column"
                align="stretch"
                gap="1px"
                px="8px"
                py="6px"
                borderRadius="7px"
                cursor="pointer"
                textAlign="left"
                bg={isActive ? tokens.colors.accent.primarySubtle : 'transparent'}
                transition={`background ${tokens.transition.fast}`}
                _hover={{ bg: isActive ? tokens.colors.accent.primarySubtle : tokens.colors.bg.whiteSubtle }}
                onClick={(e) => { e.stopPropagation(); setSelected(v); setOpen(false) }}
              >
                <Flex align="center" justify="space-between" gap={2}>
                  <Text
                    fontSize="12px"
                    fontWeight={isActive ? 700 : 600}
                    color={isActive ? tokens.colors.accent.primary : tokens.colors.text.primary}
                  >
                    {labelFor(v)}
                  </Text>
                  {isActive && <FiCheck size={13} color={tokens.colors.accent.primary} />}
                </Flex>
                <Text fontSize="10.5px" lineHeight="1.35" color={tokens.colors.text.disabled}>
                  {t(effortDescriptionKey(v, modelId) as Parameters<typeof t>[0])}
                </Text>
              </Flex>
            )
          })}
        </VStack>,
        document.body,
      )}
    </Box>
  )
}
