import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Box, Flex, Text, Image, Kbd } from '@chakra-ui/react'
import { FiCheck, FiX } from 'react-icons/fi'
import { diffLines } from 'diff'
import { tokens } from '@/theme/tokens'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore, formatBinding, matchesBinding } from '@/stores/settingsStore'
import { getFileIconUrl } from '@/utils/fileIcons'
import { useTranslation } from '@/i18n'
import InlineDiff from './InlineDiff'

/**
 * Painel de revisão de diffs em lote.
 *
 * Lista de ficheiros à esquerda, o diff DENTRO do painel à direita, decisão
 * por ficheiro, e as ações de lote no rodapé. O composer continua montado por
 * baixo — rever N diffs é uma sessão de revisão, e quem revê quer poder
 * escrever ao agente no mesmo momento (a mensagem fica na fila e é drenada no
 * turn boundary, logo a seguir à decisão do lote).
 *
 * A primeira versão era uma faixa de 4 filas empilhadas por cima do composer,
 * com o diff NOUTRO sítio (um cartão no transcript): três afordâncias
 * redundantes de navegação (setas, contador, chips), o nome do ficheiro
 * repetido, e o olho a saltar entre a decisão e o conteúdo. Aqui a navegação
 * é a própria lista, e decide-se a olhar para o código.
 *
 * O renderizador de diff é o `InlineDiff` — desde que os botões saíram dele,
 * é um preview read-only reutilizável, com hunks, contadores e realce de
 * sintaxe já resolvidos. Duplicá-lo seria manter dois motores de diff.
 */
export default function DiffApprovalPanel() {
  const t = useTranslation()
  const pendingDiffs = useChatStore(s => s.pendingDiffs)
  const approveDiffByResultId = useChatStore(s => s.approveDiffByResultId)
  const rejectDiffByResultId = useChatStore(s => s.rejectDiffByResultId)
  const approveAllPendingDiffs = useChatStore(s => s.approveAllPendingDiffs)
  const rejectAllAndStop = useChatStore(s => s.rejectAllAndStop)
  const sc = useSettingsStore(s => s.shortcuts)

  const [selectedIdx, setSelectedIdx] = useState(0)
  const count = pendingDiffs.length

  // Clamp: itens decididos saem da lista; encadeados do mesmo ficheiro entram
  // no fim (o painel mantém-se montado entre mudanças).
  useEffect(() => {
    if (selectedIdx > count - 1) setSelectedIdx(Math.max(0, count - 1))
  }, [count, selectedIdx])

  const selected = pendingDiffs[Math.min(selectedIdx, count - 1)]

  // Stats por ficheiro para a lista da esquerda. Memoizado sobre a lista
  // inteira: recalcular por render fazia diffLines correr N vezes por frame.
  const stats = useMemo(() => pendingDiffs.map(d => {
    if (d.isNewFile) return { added: d.newContent.split('\n').length, removed: 0 }
    let added = 0
    let removed = 0
    for (const change of diffLines(d.originalContent, d.newContent)) {
      const n = change.value.replace(/\n$/, '').split('\n').length
      if (change.added) added += n
      else if (change.removed) removed += n
    }
    return { added, removed }
  }), [pendingDiffs])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const field = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement
        ? e.target
        : null
      const typing = field !== null
      const composed = e.metaKey || e.ctrlKey
      // O composer está montado por baixo e o `diffAccept` por omissão é
      // Cmd+Enter — que no textarea SEMPRE quis dizer "enviar" (handleKeyDown
      // só olha para shiftKey, não para meta). Com texto por enviar, os
      // atalhos baseados em Enter pertencem ao composer.
      const midMessage = field !== null && field.value.trim().length > 0

      const fire = (run: () => void) => {
        e.preventDefault()
        e.stopPropagation()
        run()
      }
      // Lê do store no momento da tecla: `selectedIdx` pode estar desfasado
      // de uma decisão acabada de tomar noutro caminho.
      const current = () => useChatStore.getState().pendingDiffs[Math.min(selectedIdx, count - 1)]

      if (!typing && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) {
        return fire(() => setSelectedIdx(i => Math.max(0, i - 1)))
      }
      if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) {
        return fire(() => setSelectedIdx(i => Math.min(count - 1, i + 1)))
      }

      // Bindings compostos primeiro — matchesBinding não é exclusivo, o mais
      // específico tem de ganhar. Os de rejeição não cedem ao composer:
      // "rejeitar tudo e parar" é a saída de emergência.
      if (matchesBinding(e, sc.diffAcceptAll) && !midMessage) return fire(() => approveAllPendingDiffs())
      if (matchesBinding(e, sc.diffRejectAll)) return fire(() => rejectAllAndStop())
      if (matchesBinding(e, sc.diffAccept) && (composed || !typing) && !midMessage) {
        return fire(() => { const c = current(); if (c) approveDiffByResultId(c.id) })
      }
      if (matchesBinding(e, sc.diffReject) && (composed || !typing)) {
        return fire(() => { const c = current(); if (c) rejectDiffByResultId(c.id) })
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [count, selectedIdx, sc, approveDiffByResultId, rejectDiffByResultId, approveAllPendingDiffs, rejectAllAndStop])

  if (!selected) return null

  const multi = count > 1

  return (
    <Box
      flexShrink={0}
      bg={tokens.colors.bg.panel}
      borderTop="1px solid"
      borderColor={tokens.colors.border.panel}
      maxH="46vh"
      display="flex"
      flexDirection="column"
    >
      <Flex flex="1" minH={0} overflow="hidden">
        {/* Lista de ficheiros — É a navegação. Sem setas, sem contador, sem
            chips: uma só afordância em vez de três a fazer o mesmo. */}
        {multi && (
          <Box
            w="212px"
            flexShrink={0}
            overflowY="auto"
            borderRight="1px solid"
            borderColor={tokens.colors.border.panel}
            py={1.5}
          >
            {pendingDiffs.map((d, i) => {
              const isSel = i === Math.min(selectedIdx, count - 1)
              const st = stats[i] ?? { added: 0, removed: 0 }
              return (
                <Flex
                  key={d.id}
                  as="button"
                  w="100%"
                  align="center"
                  gap={2}
                  px={3}
                  py="7px"
                  textAlign="left"
                  cursor="pointer"
                  bg={isSel ? tokens.colors.accent.primarySubtle : 'transparent'}
                  borderLeft="2px solid"
                  borderColor={isSel ? tokens.colors.accent.primary : 'transparent'}
                  transition={`background ${tokens.transition.fast}`}
                  _hover={{ bg: isSel ? tokens.colors.accent.primarySubtle : tokens.colors.bg.whiteSubtle }}
                  onClick={() => setSelectedIdx(i)}
                  title={d.filePath}
                >
                  <Image src={getFileIconUrl(d.filePath)} alt="" w="14px" h="14px" flexShrink={0} />
                  <Box flex={1} minW={0}>
                    <Text
                      fontSize="11.5px"
                      fontFamily={tokens.fontFamily.mono}
                      color={isSel ? tokens.colors.text.primary : tokens.colors.text.secondary}
                      truncate
                    >
                      {d.filePath.split('/').pop() || d.filePath}
                    </Text>
                    <Flex gap={1.5} mt="1px">
                      {st.added > 0 && (
                        <Text fontSize="9.5px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.diff.addedText}>
                          +{st.added}
                        </Text>
                      )}
                      {st.removed > 0 && (
                        <Text fontSize="9.5px" fontFamily={tokens.fontFamily.mono} color={tokens.colors.diff.removedText}>
                          −{st.removed}
                        </Text>
                      )}
                      {d.isNewFile && (
                        <Text fontSize="9.5px" color={tokens.colors.accent.green} textTransform="uppercase" fontWeight="700">
                          {t('diffBar.newFile')}
                        </Text>
                      )}
                    </Flex>
                  </Box>
                </Flex>
              )
            })}
          </Box>
        )}

        {/* Diff DENTRO do painel — decide-se a olhar para o código. */}
        <Box flex="1" minW={0} overflowY="auto" px={3} py={2}>
          <InlineDiff
            key={selected.id}
            filePath={selected.filePath}
            oldContent={selected.originalContent}
            newContent={selected.newContent}
            isNewFile={selected.isNewFile}
            status="pending"
          />
        </Box>
      </Flex>

      {/* Rodapé: decisão do ficheiro selecionado à esquerda, lote à direita. */}
      <Flex
        align="center"
        gap={2}
        px={3}
        py={2}
        flexShrink={0}
        borderTop="1px solid"
        borderColor={tokens.colors.border.panel}
        flexWrap="wrap"
      >
        <Action
          tone="accept"
          filled
          onClick={() => approveDiffByResultId(selected.id)}
          label={t('diffBar.accept')}
          aria={t('diffBar.acceptAria')}
          icon={<FiCheck size={12} />}
          kbd={formatBinding(sc.diffAccept)}
        />
        <Action
          tone="reject"
          onClick={() => rejectDiffByResultId(selected.id)}
          label={t('diffBar.reject')}
          aria={t('diffBar.rejectAria')}
          icon={<FiX size={12} />}
          kbd={formatBinding(sc.diffReject)}
        />
        <Box flex={1} minW="8px" />
        <Action
          tone="accept"
          subtle
          onClick={() => approveAllPendingDiffs()}
          label={t('diffBar.acceptAll')}
          aria={t('diffBar.acceptAllAria')}
          kbd={formatBinding(sc.diffAcceptAll)}
        />
        <Action
          tone="reject"
          subtle
          onClick={() => rejectAllAndStop()}
          label={t('diffBar.rejectAll')}
          aria={t('diffBar.rejectAllAria')}
          kbd={formatBinding(sc.diffRejectAll)}
        />
      </Flex>
    </Box>
  )
}

function Action({ tone, filled, subtle, onClick, label, aria, icon, kbd }: {
  tone: 'accept' | 'reject'
  filled?: boolean
  subtle?: boolean
  onClick: () => void
  label: string
  aria: string
  icon?: ReactNode
  kbd: string
}) {
  const accept = tone === 'accept'
  const color = accept ? tokens.colors.accent.green : tokens.colors.accent.red
  const solid = accept ? tokens.colors.accent.greenSubtle : tokens.colors.accent.redSubtle
  return (
    <Box
      as="button"
      display="flex"
      alignItems="center"
      gap="5px"
      px={subtle ? '9px' : '11px'}
      py="6px"
      borderRadius="7px"
      cursor="pointer"
      bg={filled ? solid : 'transparent'}
      border="1px solid"
      borderColor={filled ? color : 'transparent'}
      color={subtle ? tokens.colors.text.secondary : color}
      fontSize="11px"
      fontWeight="650"
      transition={`background ${tokens.transition.fast}, color ${tokens.transition.fast}, border-color ${tokens.transition.fast}`}
      _hover={{ bg: filled ? solid : tokens.colors.bg.whiteSubtle, color }}
      _active={{ transform: 'scale(0.985)' }}
      onClick={onClick}
      aria-label={aria}
      title={aria}
    >
      {icon}
      {label}
      <Kbd fontSize="9px" color="inherit" opacity={0.45} ml="2px" bg="transparent" borderColor="transparent" p={0}>
        {kbd}
      </Kbd>
    </Box>
  )
}
