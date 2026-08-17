import { memo, useMemo, useState } from 'react'
import { Box, Flex, Text, Image } from '@chakra-ui/react'
import { diffLines } from 'diff'
import { getFileIconUrl } from '@/utils/fileIcons'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { detectLanguage, highlightLines, type HighlightedLine } from '@/utils/syntaxHighlight'

const CONTEXT_LINES = 3
const MAX_LINES = 40

interface InlineDiffProps {
  filePath: string
  oldContent: string
  newContent: string
  isNewFile: boolean
  status: 'pending' | 'approved' | 'denied'
  /** Saltar o header (icon + filename + stats + status) quando o diff é
   *  embutido num cartão que JÁ mostra essa informação no seu próprio header
   *  compacto. Evita dois headers empilhados para o mesmo ficheiro. */
  hideHeader?: boolean
}

interface DiffLine {
  type: 'added' | 'removed' | 'normal'
  oldNum: number | null
  newNum: number | null
  /** Index into the highlighted old/new lines array */
  sourceLineIdx: number
}

/**
 * Estilos CONSTANTES da linha de diff, içados para fora do render (2026-08-10).
 *
 * PORQUÊ (perfil do Web Inspector, 12,7s / 1.952 amostras)
 * ───────────────────────────────────────────────────────
 * 96,2% das amostras dentro de `react-dom`, **61,5% dentro do motor de estilos
 * do Chakra** — `get` 12,7% de self-time, mais `simpleHash` 2,4%, `compact$1`
 * 2,2%, `serializeStyles` 1,8%, `createStringFromObject` 1,8%. O nosso próprio
 * código nem chega aos 2%: o travamento a escrever no composer durante um run
 * é o Chakra a re-serializar estilos, não markdown nem realce de sintaxe.
 *
 * Cada linha de diff monta 8 componentes Chakra. Com os props inline, TODOS os
 * objectos de estilo são literais novos a cada render, portanto o Chakra falha
 * a cache e recalcula a chave para cada um. Os dois objectos RESPONSIVOS
 * (`pr` e `fontSize` do conteúdo) são os piores: são percorridos e hasheados
 * por linha, por render.
 *
 * Içar não muda um pixel — os valores são idênticos e o CSS gerado é o mesmo.
 * Só o que é CONSTANTE sobe; tudo o que depende de `line.type` (fundos, cores,
 * bordas, boxShadow) fica inline, senão congelava no primeiro valor.
 */
const DIFF_ROW_STYLE = {
  minH: '21px',
  display: 'grid',
  gridTemplateColumns: '44px 44px 22px minmax(0, 1fr)',
  minW: 0,
} as const

const DIFF_GUTTER_STYLE = {
  minH: '21px',
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'flex-start',
  pt: '2px',
  pr: '10px',
  userSelect: 'none',
} as const

const DIFF_GUTTER_TEXT_STYLE = {
  fontSize: '10px',
  lineHeight: '21px',
  whiteSpace: 'nowrap',
} as const

const DIFF_PREFIX_CELL_STYLE = {
  minH: '21px',
  justify: 'center',
  align: 'flex-start',
  pt: '2px',
  userSelect: 'none',
} as const

const DIFF_PREFIX_TEXT_STYLE = {
  fontSize: '11px',
  lineHeight: '21px',
  fontWeight: '700',
} as const

/** Os dois objectos responsivos vivem AQUI — eram recriados por linha/render. */
const DIFF_CONTENT_STYLE = {
  minW: 0,
  pr: { base: 3, md: 4 },
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontSize: { base: '11.5px', md: '12px' },
  lineHeight: '21px',
} as const

function InlineDiff({
  filePath,
  oldContent,
  newContent,
  isNewFile,
  status,
  hideHeader = false,
}: InlineDiffProps) {
  const [showFull, setShowFull] = useState(false)
  const fileName = filePath.split('/').pop() || filePath
  const language = useMemo(() => detectLanguage(filePath), [filePath])

  const changes = useMemo(() =>
    isNewFile
      ? [{ value: newContent, added: true, removed: false }]
      : diffLines(oldContent, newContent),
    [oldContent, newContent, isNewFile]
  )

  // Highlighted lines for old and new content
  const oldHighlighted = useMemo(() => highlightLines(oldContent, language), [oldContent, language])
  const newHighlighted = useMemo(() => highlightLines(newContent, language), [newContent, language])

  const allLines = useMemo(() => {
    const lines: DiffLine[] = []
    let oldNum = 1
    let newNum = 1
    for (const change of changes) {
      const changeLines = change.value.replace(/\n$/, '').split('\n')
      const type = change.added ? 'added' as const : change.removed ? 'removed' as const : 'normal' as const
      for (let _ci = 0; _ci < changeLines.length; _ci++) {
        if (type === 'added') {
          lines.push({ type, oldNum: null, newNum: newNum, sourceLineIdx: newNum - 1 })
          newNum++
        } else if (type === 'removed') {
          lines.push({ type, oldNum: oldNum, newNum: null, sourceLineIdx: oldNum - 1 })
          oldNum++
        } else {
          lines.push({ type, oldNum: oldNum, newNum: newNum, sourceLineIdx: newNum - 1 })
          oldNum++
          newNum++
        }
      }
    }
    return lines
  }, [changes])

  const isResolved = status === 'approved' || status === 'denied'

  const addedCount = allLines.filter(l => l.type === 'added').length
  const removedCount = allLines.filter(l => l.type === 'removed').length
  const diffBorderColor = status === 'approved'
    ? tokens.colors.toolCall.successBorder
    : status === 'denied'
      ? tokens.colors.toolCall.failedBorder
      : tokens.colors.border.panel

  // Unified-diff style hunks with CONTEXT_LINES of surrounding context
  // around each changed block. Overlapping or adjacent ranges are merged
  // so non-contiguous changes are separated by a compact "···" row.
  const hunks = useMemo(() => {
    if (allLines.length === 0) return []

    const changedIdxs: number[] = []
    allLines.forEach((line, idx) => {
      if (line.type !== 'normal') changedIdxs.push(idx)
    })
    if (changedIdxs.length === 0) return []

    const ranges: Array<{ start: number; end: number }> = []
    for (const idx of changedIdxs) {
      const start = Math.max(0, idx - CONTEXT_LINES)
      const end = Math.min(allLines.length - 1, idx + CONTEXT_LINES)
      const last = ranges[ranges.length - 1]
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, end)
      } else {
        ranges.push({ start, end })
      }
    }

    return ranges.map(({ start, end }) => allLines.slice(start, end + 1))
  }, [allLines])

  /**
   * Onde no ficheiro é que esta alteração acontece — "L177" ou "L177-240".
   *
   * O cabeçalho mostrava só o nome do ficheiro. Quando o agente edita DOIS
   * sítios do mesmo ficheiro (por exemplo a mesma chamada a remover em duas
   * funções), saíam dois cartões com cabeçalho idêntico e linhas removidas
   * byte-a-byte iguais — lia-se como se ele tivesse proposto a mesma coisa
   * duas vezes, e o único distintivo eram os números pequenos na goteira
   * (sessão momenu-fact 2026-07-28: `useAuthRepository.ts` nas linhas 178 e
   * 240). Ninguém deve ter de comparar goteiras para saber se está a aprovar
   * duas alterações ou a mesma repetida.
   */
  const changedRange = useMemo(() => {
    const nums = allLines
      .filter(l => l.type !== 'normal')
      .map(l => l.newNum ?? l.oldNum)
      .filter((n): n is number => n !== null)
    if (nums.length === 0) return null
    const first = Math.min(...nums)
    const last = Math.max(...nums)
    return first === last ? `L${first}` : `L${first}-${last}`
  }, [allLines])

  const totalDisplayLines = useMemo(
    () => hunks.reduce((n, h) => n + h.length, 0),
    [hunks],
  )
  const shouldTruncate = totalDisplayLines > MAX_LINES && !showFull
  const displayHunks = useMemo(() => {
    if (!shouldTruncate) return hunks
    const out: DiffLine[][] = []
    let remaining = MAX_LINES
    for (const h of hunks) {
      if (remaining <= 0) break
      if (h.length <= remaining) {
        out.push(h)
        remaining -= h.length
      } else {
        out.push(h.slice(0, remaining))
        remaining = 0
      }
    }
    return out
  }, [hunks, shouldTruncate])

  // Get highlighted tokens for a diff line
  const getLineTokens = (line: DiffLine): HighlightedLine => {
    const source = line.type === 'removed' ? oldHighlighted : newHighlighted
    return source[line.sourceLineIdx] || [{ text: '', color: '#f8f9fb' }]
  }

  return (
    <Box
      border={hideHeader ? 'none' : `1px solid ${diffBorderColor}`}
      borderTop={hideHeader ? `1px solid ${tokens.colors.border.subtle}` : undefined}
      borderRadius={hideHeader ? '0' : tokens.radius.xl}
      overflow="hidden"
      my={hideHeader ? 0 : 1.5}
      bg={tokens.colors.bg.codeBlock}
    >
      {!hideHeader && (
      <Flex
        align="center"
        justify="space-between"
        gap={2}
        px={3}
        minH="32px"
        py="6px"
        bg={tokens.colors.bg.codeBlockHeader}
        borderBottom={`1px solid ${tokens.colors.border.subtle}`}
      >
        <Flex align="center" gap={2} minW={0}>
          <Image src={getFileIconUrl(filePath)} alt="" w="14px" h="14px" flexShrink={0} />
          <Text
            fontSize={tokens.fontSize.sm}
            color={tokens.colors.text.primary}
            fontFamily={tokens.fontFamily.mono}
            fontWeight="500"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
          >
            {fileName}
          </Text>
          {changedRange && !isNewFile && (
            <Text
              fontSize={tokens.fontSize.xs}
              color={tokens.colors.text.disabled}
              fontFamily={tokens.fontFamily.mono}
              flexShrink={0}
              whiteSpace="nowrap"
            >
              {changedRange}
            </Text>
          )}
          {isNewFile && (
            <Text
              fontSize={tokens.fontSize.xs}
              color={tokens.colors.accent.green}
              fontWeight="600"
              fontFamily={tokens.fontFamily.mono}
              lineHeight="1"
            >
              {t('chat.diff.newFile')}
            </Text>
          )}
          {!isNewFile && (
            <Flex align="center" gap={1.5}>
              {addedCount > 0 && (
                <Text
                  fontSize={tokens.fontSize.xs}
                  color={tokens.colors.diff.addedText}
                  fontFamily={tokens.fontFamily.mono}
                  fontWeight="600"
                  lineHeight="1"
                >
                  +{addedCount}
                </Text>
              )}
              {removedCount > 0 && (
                <Text
                  fontSize={tokens.fontSize.xs}
                  color={tokens.colors.diff.removedText}
                  fontFamily={tokens.fontFamily.mono}
                  fontWeight="600"
                  lineHeight="1"
                >
                  −{removedCount}
                </Text>
              )}
            </Flex>
          )}
          {isResolved && (
            <Text
              fontSize={tokens.fontSize.xs}
              fontWeight="600"
              color={status === 'approved' ? tokens.colors.accent.green : tokens.colors.accent.red}
              lineHeight="1"
            >
              {status === 'approved' ? t('chat.diff.accepted') : t('chat.diff.rejected')}
            </Text>
          )}
        </Flex>
      </Flex>
      )}

      {/* Diff content — editor-like grid. Long lines wrap inside the code
          column, while fixed gutter columns keep line numbers aligned. */}
      <Box
        overflowX="hidden"
        fontSize={{ base: '11.5px', md: '12px' }}
        fontFamily={tokens.fontFamily.mono}
        lineHeight="21px"
        bg={tokens.colors.bg.terminal}
        css={{
          '&::-webkit-scrollbar': { width: '4px', height: '4px' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.14)', borderRadius: '2px' },
          // Container query on the diff body itself: the transcript column
          // shrinks with the preview split and the side drawers (team chat,
          // terminal) while the viewport stays put, so a viewport @media
          // never fired on desktop — diffs kept the wide 44px gutters even
          // inside a 380px sidebar chat. Measuring the diff's own box makes
          // the narrow gutters kick in wherever the diff actually renders.
          containerType: 'inline-size',
          '@container (max-width: 560px)': {
            '& [data-diff-row], & [data-diff-gap]': {
              gridTemplateColumns: '34px 34px 18px minmax(0, 1fr)',
            },
          },
        }}
      >
        {displayHunks.length === 0 ? (
          <Flex px={3} py="10px" align="center">
            <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
              {t('chat.diff.noChanges')}
            </Text>
          </Flex>
        ) : (
          displayHunks.map((hunk, hi) => (
            <Box key={`hunk-${hi}`}>
              {hi > 0 && (
                <Box
                  data-diff-gap
                  h="16px"
                  bg="rgba(255,255,255,0.025)"
                  borderTop="1px dashed rgba(255,255,255,0.075)"
                  borderBottom="1px dashed rgba(255,255,255,0.075)"
                  userSelect="none"
                  display="grid"
                  alignItems="center"
                  gridTemplateColumns="44px 44px 22px minmax(0, 1fr)"
                  minW={0}
                >
                  <Text gridColumn="4" fontSize="10px" color="rgba(255,255,255,0.25)" fontFamily={tokens.fontFamily.mono}>
                    ···
                  </Text>
                </Box>
              )}
              {hunk.map((line) => {
                let bg = 'transparent'
                let prefixChar = '\u00A0'
                if (line.type === 'added') {
                  bg = 'rgba(46, 160, 67, 0.085)'
                  prefixChar = '+'
                } else if (line.type === 'removed') {
                  bg = 'rgba(248, 81, 73, 0.085)'
                  prefixChar = '-'
                }
                const gutterBg = line.type === 'removed'
                  ? 'rgba(248, 81, 73, 0.06)'
                  : line.type === 'added'
                    ? 'rgba(46, 160, 67, 0.04)'
                    : 'transparent'
                const gutterBorder = line.type === 'added'
                  ? 'rgba(46, 160, 67, 0.15)'
                  : line.type === 'removed'
                    ? 'rgba(248, 81, 73, 0.15)'
                    : 'rgba(255,255,255,0.06)'
                const gutterTextColor = line.type === 'normal'
                  ? 'rgba(255,255,255,0.15)'
                  : 'rgba(255,255,255,0.25)'
                const lineTokens = getLineTokens(line)
                return (
                  <Box
                    key={`${line.type}-${line.oldNum ?? 'n'}-${line.newNum ?? 'n'}`}
                    data-diff-row
                    {...DIFF_ROW_STYLE}
                    bg={bg}
                    boxShadow={line.type === 'added'
                      ? 'inset 2px 0 0 rgba(46, 160, 67, 0.58)'
                      : line.type === 'removed'
                        ? 'inset 2px 0 0 rgba(248, 81, 73, 0.58)'
                        : 'none'}
                  >
                    <Box {...DIFF_GUTTER_STYLE} bg={gutterBg}>
                      <Text {...DIFF_GUTTER_TEXT_STYLE} color={gutterTextColor}>
                        {line.oldNum ?? ''}
                      </Text>
                    </Box>
                    <Box
                      {...DIFF_GUTTER_STYLE}
                      bg={gutterBg}
                      borderRight={`1px solid ${gutterBorder}`}
                    >
                      <Text {...DIFF_GUTTER_TEXT_STYLE} color={gutterTextColor}>
                        {line.newNum ?? ''}
                      </Text>
                    </Box>
                    <Flex {...DIFF_PREFIX_CELL_STYLE}>
                      <Text
                        {...DIFF_PREFIX_TEXT_STYLE}
                        color={line.type === 'added'
                          ? tokens.colors.diff.addedText
                          : line.type === 'removed'
                            ? tokens.colors.diff.removedText
                            : 'transparent'}
                      >
                        {prefixChar}
                      </Text>
                    </Flex>
                    <Box {...DIFF_CONTENT_STYLE}>
                      {lineTokens.map((token, ti) => (
                        <span key={ti} style={{ color: token.color }}>
                          {token.text}
                        </span>
                      ))}
                    </Box>
                  </Box>
                )
              })}
            </Box>
          ))
        )}
      </Box>

      {shouldTruncate && (
        <Box
          px={3}
          py="6px"
          borderTop={`1px solid ${tokens.colors.border.subtle}`}
          bg={tokens.colors.bg.codeBlockHeader}
        >
          <Text
            as="button"
            fontSize={tokens.fontSize.xs}
            color={tokens.colors.text.secondary}
            cursor="pointer"
            fontWeight="500"
            fontFamily={tokens.fontFamily.ui}
            _hover={{ color: tokens.colors.text.primary }}
            onClick={() => setShowFull(true)}
          >
            {t('chat.diff.showMore').replace('{count}', String(totalDisplayLines - MAX_LINES))}
          </Text>
        </Box>
      )}

      {!hideHeader && (
        <Box
          px={3}
          py="5px"
          bg={tokens.colors.bg.codeBlockHeader}
          borderTop={`1px solid ${tokens.colors.border.subtle}`}
        >
          <Text fontSize={tokens.fontSize.xs} color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} truncate>
            {filePath}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export default memo(InlineDiff)
