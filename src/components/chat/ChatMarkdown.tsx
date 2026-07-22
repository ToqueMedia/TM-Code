/**
 * ChatMarkdown — o renderizador de markdown do chat, extraído do MessageBubble
 * (freeze fix, 2026-07-18). Vive à parte porque é uma FOLHA sem dependências de
 * stores/serviços/Tauri: assim os componentes memoizados (HighlightedCode,
 * MemoMarkdown) são testáveis em isolamento, e o MessageBubble (pesado em
 * stores) não precisa de ser montado para os exercitar.
 *
 * O PORQUÊ da memoização vive nos comentários de cada componente abaixo.
 */
import React, { memo, useCallback, useMemo, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { FiCopy, FiCheck } from 'react-icons/fi'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { normalizeAssistantText } from '../../utils/normalizeAssistantText'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [code])

  return (
    <Box
      as="button"
      display="flex"
      alignItems="center"
      gap="5px"
      px="9px"
      py="6px"
      borderRadius="8px"
      bg="transparent"
      border="1px solid rgba(255,255,255,0.075)"
      color={copied ? tokens.colors.accent.green : tokens.colors.text.disabled}
      fontSize="11px"
      fontFamily={tokens.fontFamily.ui}
      fontWeight="650"
      cursor="pointer"
      transition="all 0.15s ease"
      _hover={{ bg: 'rgba(255,255,255,0.06)', color: tokens.colors.text.secondary, borderColor: 'rgba(255,255,255,0.14)', transform: 'translateY(-1px)' }}
      _active={{ transform: 'translateY(0) scale(0.98)' }}
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleCopy() }}
      aria-label={copied ? t('chat.copied') : t('chat.copy')}
    >
      {copied ? <FiCheck size={11} /> : <FiCopy size={11} />}
      {copied ? t('chat.copied') : t('chat.copy')}
    </Box>
  )
}

// Memoized fenced-code renderer. react-syntax-highlighter (Prism) re-tokenizes
// the WHOLE block on every render, and MessageBubble re-renders ~20×/s during
// streaming (each reasoning/text delta bumps streamingVersion — chatStore
// appendReasoningDelta/appendTextDelta). Without memo, every code block already
// on screen was re-highlighted on every frame, saturating the main thread and
// freezing the UI mid-reasoning / mid-stream. memo() keyed on (language, code)
// means only the block whose text is still GROWING re-tokenizes; every
// finalized block bails out. (freeze fix, 2026-07-18)
/** Moldura partilhada dos blocos de código (header language + copy) — usada
 *  pelo render Prism (blocos estáveis) e pelo render plano (fence em
 *  CRESCIMENTO na cauda do streaming), para a transição plain→colorido não
 *  saltar um pixel. */
function CodeFrame({ language, code, children }: { language: string; code: string; children: React.ReactNode }) {
  return (
    <Box
      borderRadius="12px"
      overflow="hidden"
      my={3}
      border="1px solid rgba(255, 255, 255, 0.09)"
      bg="rgba(10, 10, 10, 0.94)"
      boxShadow="0 16px 38px rgba(0,0,0,0.26)"
    >
      <Flex
        align="center"
        justify="space-between"
        gap={3}
        px={{ base: 3, md: 4 }}
        py="8px"
        bg="linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.022))"
        borderBottom="1px solid rgba(255, 255, 255, 0.075)"
      >
        <Text
          fontSize="10px"
          color={tokens.colors.text.disabled}
          fontFamily={tokens.fontFamily.mono}
          textTransform="uppercase"
          fontWeight="700"
          bg="rgba(255,255,255,0.045)"
          border="1px solid rgba(255,255,255,0.07)"
          borderRadius="999px"
          px="7px"
          py="2px"
          lineHeight="1"
        >
          {language}
        </Text>
        <CopyButton code={code} />
      </Flex>
      {children}
    </Box>
  )
}

export const HighlightedCode = memo(function HighlightedCode({ language, code }: { language: string; code: string }) {
  return (
    <CodeFrame language={language} code={code}>
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={language}
        customStyle={{
          margin: 0,
          padding: '16px 18px',
          fontSize: '12.5px',
          lineHeight: '1.68',
          background: 'transparent',
          borderRadius: 0,
          maxWidth: '100%',
          overflowX: 'auto',
        }}
      >
        {code}
      </SyntaxHighlighter>
    </CodeFrame>
  )
})

/** Fence em CRESCIMENTO (cauda do streaming): mesma moldura, SEM Prism — o
 *  código aparece monocromático enquanto está a ser escrito e ganha cores
 *  quando o fence fecha (vira segmento estável → HighlightedCode, 1 única
 *  tokenização). Tokenizar um fence de 10-50KB a cada flush de 50ms era o
 *  que saturava a main thread a "escrever código". */
function PlainFencedCode({ language, code }: { language: string; code: string }) {
  return (
    <CodeFrame language={language} code={code}>
      <Box
        as="pre"
        m={0}
        p="16px 18px"
        fontSize="12.5px"
        lineHeight="1.68"
        fontFamily={tokens.fontFamily.mono}
        color="#d4d4d4"
        whiteSpace="pre"
        overflowX="auto"
        maxW="100%"
      >
        {code}
      </Box>
    </CodeFrame>
  )
}

export const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    const codeString = String(children).replace(/\n$/, '')

    if (match) {
      return <HighlightedCode language={match[1]} code={codeString} />
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
}

// Memoized per-block markdown. During streaming only the LAST content block
// grows; every earlier text block is stable. Wrapping the per-block
// ReactMarkdown in memo() keyed on the block text means finalized blocks skip
// the markdown re-parse (and their code blocks skip re-highlight) entirely on
// each streaming frame — so a reasoning phase no longer re-renders the prose +
// code the model already streamed above it. (freeze fix, 2026-07-18)
export const MemoMarkdown = memo(function MemoMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {normalizeAssistantText(text)}
    </ReactMarkdown>
  )
})

// ═══════════ Streaming incremental (freeze fix, ronda 2 — 2026-07-18) ═══════════
// A ronda 1 memoizou BLOCOS finalizados, mas o bloco ATIVO continuava a
// re-parsear o markdown inteiro + re-tokenizar os fences DENTRO dele a cada
// flush de 50ms — custo que cresce com o tamanho do bloco: O(n²) ao longo do
// stream. Era o "torna-se lento à medida que escreve".
//
// Modelo novo: o texto do bloco ativo é dividido em SEGMENTOS ESTÁVEIS
// (fronteira = linha vazia FORA de code fence — determinística e monotónica:
// com mais texto, os primeiros k segmentos são idênticos) + uma CAUDA (o
// parágrafo/fence ainda em curso). Cada segmento estável renderiza num
// MemoMarkdown próprio → parseia UMA vez quando nasce e nunca mais; só a
// cauda (pequena) re-parseia por flush. Fences na cauda renderizam SEM Prism
// (PlainFencedCode) até fecharem. DOM final idêntico ao render único: o
// react-markdown não embrulha (sem wrapper), por isso os <p>/<ul>/<pre> dos
// segmentos caem como irmãos diretos no mesmo Box — mesmas margens, mesmo CSS.

export function splitMarkdownForStreaming(text: string): { stable: string[]; tail: string } {
  const lines = text.split('\n')
  const stable: string[] = []
  let current: string[] = []
  let fenceMarker: '```' | '~~~' | null = null
  // Fronteira PENDENTE: uma linha vazia só fecha o segmento quando aparece
  // conteúdo DEPOIS dela — o "\n" terminal de um parágrafo ainda a ser
  // streamado não pode fechá-lo (o modelo pode continuar a mesma linha
  // lógica), senão os segmentos mudavam retroativamente e o memo churnava.
  let pendingBlank = false
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (fenceMarker) {
      // Dentro de fence: linhas vazias NÃO são fronteira; só o marcador
      // que abriu é que fecha (um \`\`\` dentro de ~~~ é conteúdo).
      current.push(line)
      if (trimmed.startsWith(fenceMarker)) fenceMarker = null
      continue
    }
    if (trimmed === '') {
      if (current.length > 0) pendingBlank = true
      continue
    }
    if (pendingBlank) {
      stable.push(current.join('\n'))
      current = []
      pendingBlank = false
    }
    if (trimmed.startsWith('```')) fenceMarker = '```'
    else if (trimmed.startsWith('~~~')) fenceMarker = '~~~'
    current.push(line)
  }
  return { stable, tail: current.join('\n') }
}

/** Componentes da CAUDA: fences renderizam planos (sem tokenização). */
const streamingTailComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    const codeString = String(children).replace(/\n$/, '')
    if (match) {
      return <PlainFencedCode language={match[1]} code={codeString} />
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
}

function TailMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={streamingTailComponents}>
      {normalizeAssistantText(text)}
    </ReactMarkdown>
  )
}

/** Render do bloco de texto ATIVO durante o streaming. Blocos finalizados
 *  continuam a usar MemoMarkdown inteiro (1 parse no fim, cobre os raros
 *  casos de markdown que atravessa parágrafos, ex.: link reference defs). */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const { stable, tail } = useMemo(() => splitMarkdownForStreaming(text), [text])
  return (
    <>
      {stable.map((seg, i) => (
        <MemoMarkdown key={i} text={seg} />
      ))}
      {tail ? <TailMarkdown text={tail} /> : null}
    </>
  )
})
