import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Box, Flex, Text, VStack } from '@chakra-ui/react'
import { FiCpu, FiCheck } from 'react-icons/fi'
import { tokens } from '@/theme/tokens'
import { usePersonaStore, PERSONAS, type Persona } from '../../stores/personaStore'
import { useBillingStore } from '../../stores/billingStore'
import { useActiveModelStore } from '../../stores/activeModelStore'
import { t } from '@/i18n'

/**
 * Seletor de PERSONA do modelo (Escolha do Modelo, 2026-08-04).
 *
 * White-labeling: o utilizador escolhe entre Standard/Expert/Master — nunca vê
 * qual modelo serve cada persona (isso é atribuição do admin no painel
 * Personas do Settings). A escolha viaja em `X-TM-Persona` (buildExtraHeaders)
 * e o data-plane roteia para a config `persona:*`; persona não publicada
 * degrada silenciosamente para a config ativa.
 *
 * Mesma mecânica do EffortSelector (dropdown portalado para document.body por
 * causa do overflow:hidden do rodapé; abre para cima; fecha em run-start).
 * `disabled` = agente a trabalhar — a persona é lida por pedido, trocá-la a
 * meio de um run afetaria os turnos seguintes do run em voo, o que baralha o
 * que o utilizador está a ver acontecer.
 */

function personaLabel(p: Persona): string {
  if (p === 'standard') return t('prompt.persona.standard')
  if (p === 'expert') return t('prompt.persona.expert')
  return t('prompt.persona.master')
}

function personaDescription(p: Persona): string {
  if (p === 'standard') return t('prompt.persona.standard.desc')
  if (p === 'expert') return t('prompt.persona.expert.desc')
  return t('prompt.persona.master.desc')
}

export function PersonaSelector({ disabled = false }: { disabled?: boolean }) {
  const selected = usePersonaStore((s) => s.selected)
  const setSelected = usePersonaStore((s) => s.setSelected)
  // Gate de plano (decisão 05-08): só a Standard para o plano free (explorer).
  // O worker também degrada server-side — isto é a metade honesta da UI.
  const isFreePlan = useBillingStore((s) => s.plan) === 'explorer'
  // Multiplicador POR persona definido pelo ADMIN (doc aiPersonas) — mostrado
  // ao lado da descrição; NUNCA um número hardcoded.
  const personaModels = useActiveModelStore((s) => s.personaModels)
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (open && buttonRef.current) setRect(buttonRef.current.getBoundingClientRect())
  }, [open])

  // Menu portalado não herda o disabled do botão — fecha ao arrancar um run.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  // Plano free com persona paga guardada (localStorage antigo): o worker já
  // degrada server-side; reverter aqui evita a UI a dizer "EXPERT" enquanto a
  // Standard serve por baixo.
  useEffect(() => {
    if (isFreePlan && selected !== 'standard') setSelected('standard')
  }, [isFreePlan, selected, setSelected])

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
        cursor={disabled ? 'not-allowed' : 'pointer'}
        opacity={disabled ? 0.45 : 1}
        color={open ? tokens.colors.accent.primary : tokens.colors.text.secondary}
        bg={open ? tokens.colors.accent.primarySubtle : 'transparent'}
        border={`1px solid ${open ? tokens.colors.accent.primaryMuted : 'transparent'}`}
        transition={`all ${tokens.transition.fast}`}
        _hover={disabled ? {} : { bg: open ? tokens.colors.accent.primarySubtle : tokens.colors.bg.whiteSubtle, color: tokens.colors.text.primary }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled}
        aria-label={t('prompt.persona.tooltip')}
        title={disabled ? t('prompt.persona.busyTooltip') : t('prompt.persona.tooltip')}
        onClick={disabled ? undefined : (e) => { e.stopPropagation(); setOpen((o) => !o) }}
      >
        <Box display="flex" alignItems="center" flexShrink={0}><FiCpu size={14} /></Box>
        <Text data-prompt-action-label fontSize="11px" fontWeight="600" whiteSpace="nowrap">
          {personaLabel(selected)}
        </Text>
      </Box>

      {open && rect && createPortal(
        <VStack
          ref={menuRef}
          position="fixed"
          left={`${rect.left}px`}
          bottom={`${window.innerHeight - rect.top + 6}px`}
          w="240px"
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
          {PERSONAS.map((p) => {
            const isActive = p === selected
            const locked = isFreePlan && p !== 'standard'
            const adminMultiplier = personaModels[p]?.costMultiplier
            return (
              <Flex
                key={p}
                as="button"
                role="option"
                aria-selected={isActive}
                direction="column"
                align="stretch"
                gap="1px"
                px="8px"
                py="6px"
                borderRadius="7px"
                cursor={locked ? 'not-allowed' : 'pointer'}
                opacity={locked ? 0.45 : 1}
                textAlign="left"
                bg={isActive ? tokens.colors.accent.primarySubtle : 'transparent'}
                transition={`background ${tokens.transition.fast}`}
                _hover={{ bg: locked ? 'transparent' : (isActive ? tokens.colors.accent.primarySubtle : tokens.colors.bg.whiteSubtle) }}
                title={locked ? t('prompt.persona.lockedHint') : undefined}
                onClick={locked ? (e) => e.stopPropagation() : (e) => { e.stopPropagation(); setSelected(p); setOpen(false) }}
              >
                <Flex align="center" justify="space-between" gap={2}>
                  <Text
                    fontSize="12px"
                    fontWeight={isActive ? 700 : 600}
                    color={isActive ? tokens.colors.accent.primary : tokens.colors.text.primary}
                  >
                    {personaLabel(p)}
                  </Text>
                  {isActive && <FiCheck size={13} color={tokens.colors.accent.primary} />}
                </Flex>
                <Text fontSize="10.5px" lineHeight="1.35" color={tokens.colors.text.disabled}>
                  {personaDescription(p)}
                  {typeof adminMultiplier === 'number' && ` \u00B7 \u00D7${adminMultiplier}`}
                  {locked && ` \u00B7 ${t('prompt.persona.lockedBadge')}`}
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
