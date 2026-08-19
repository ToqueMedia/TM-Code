import React, { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { Box } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { t } from '@/i18n'
import { useChatStore } from '@/stores/chatStore'
import { useByokStore } from '@/stores/byokStore'
import { useBillingStore } from '@/stores/billingStore'
import { renderHighlightedPrompt } from './promptHighlight'
import { resolveInlineArgHint } from './slashArgHint'

interface PromptTextareaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  // `value` is intentionally NOT a prop — we used to pass `useChatStore.draftInput`
  // down here, which forced every consumer of `usePromptBar` (PromptBar itself,
  // AgentTasksPanel, QueuedMessagesPreview, AttachmentChips, PromptActions, the
  // hint row, …) to re-render on every keystroke. The textarea now subscribes
  // to the store directly so only this component re-renders per character.
  // `onChange` still fires up so the parent can keep doing slash/hashtag/mention
  // detection — but the parent reads the live value via store.getState() instead
  // of holding it as reactive state.
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onBlur?: () => void
  onPaste?: (e: React.ClipboardEvent) => void
  disabled: boolean
  /** When true, shows a queue-oriented placeholder */
  isAgentBusy?: boolean
}

// Shared text styles used by BOTH the textarea and the overlay so glyph
// metrics line up exactly (any drift between the two ruins the highlight).
const TEXT_STYLE: React.CSSProperties = {
  fontSize: '15px',
  fontFamily: tokens.fontFamily.ui,
  lineHeight: '23px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: 0,
  letterSpacing: 'normal',
  tabSize: 2,
}

function PromptTextarea({ textareaRef, onChange, onKeyDown, onBlur, onPaste, disabled, isAgentBusy }: PromptTextareaProps) {
  // Live value source. Subscribing here (instead of at usePromptBar level)
  // localises the per-keystroke re-render to this component. The textarea
  // + highlight overlay genuinely need the value on every change; the rest
  // of PromptBar's tree does not.
  const value = useChatStore(s => s.draftInput)
  const byokEnabled = useByokStore(s => s.enabled)
  const billingPlan = useBillingStore(s => s.plan)

  const planSuffix = byokEnabled ? ` (${billingPlan === 'explorer' ? 'Explorer' : billingPlan === 'vibe' ? 'Vibe' : billingPlan === 'pro' ? 'Pro' : billingPlan === 'max' ? 'Max' : billingPlan === 'welcome' ? 'Welcome' : billingPlan === 'toque-media' ? 'TM' : billingPlan})` : ''
  // Mirror the textarea's scrollTop onto the overlay so multi-line content
  // (>6 visible rows, when the textarea starts scrolling internally) keeps
  // the coloured highlight aligned with the real glyphs underneath.
  //
  // Using a ref + imperative DOM write (instead of useState) means the
  // overlay does NOT re-render on every scroll tick — at 60fps that's 60
  // re-renders per second of an overlay containing the entire prompt + its
  // highlight spans. The transform is the only thing that needs to change
  // per scroll, and it's a CSS property React doesn't need to mediate.
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const handleScroll = useCallback(() => {
    const ta = textareaRef.current
    const ov = overlayRef.current
    if (ta && ov) {
      ov.style.transform = `translateY(-${ta.scrollTop}px)`
    }
  }, [textareaRef])

  // After every value change, re-sync the transform AND re-measure the
  // textarea height. Auto-resize used to live in usePromptBar with `input`
  // as its dep; moving it here keeps the resize work co-located with the
  // value subscription, and stops the parent hook from needing the
  // reactive input read in the first place.
  // Comprimento do valor da passagem ANTERIOR. Só serve para saber se o texto
  // pode ter ENCOLHIDO — ver a nota do reset no efeito abaixo.
  const prevLenRef = useRef(0)

  useLayoutEffect(() => {
    const ta = textareaRef.current
    const ov = overlayRef.current
    if (!ta) return
    const maxHeight = 7 * 23
    const encolheu = value.length < prevLenRef.current
    prevLenRef.current = value.length

    // O RESET PARA `auto` SÓ É PRECISO PARA ENCOLHER — e é ele que custa.
    //
    // A sequência antiga corria em TODAS as teclas: escrever `height:auto`
    // (invalida o layout) → ler `scrollHeight` (força um layout SÍNCRONO) →
    // escrever a altura (invalida outra vez). Dois flushes por caracter, com
    // o custo a crescer com o tamanho do prompt. Era o `PromptTextarea` a
    // 10,4% de self-time no perfil de 2026-08-11.
    //
    // A assimetria que o evita: `scrollHeight` é a altura do CONTEÚDO e pode
    // exceder a altura fixada, portanto a caixa cresce sem precisar de reset.
    // Só o caminho inverso precisa — com a altura fixada em H, um conteúdo que
    // passe a caber em menos do que H continua a reportar `scrollHeight === H`
    // (nunca é menor que o clientHeight) e a caixa ficaria presa em H.
    //
    // A digitação normal é ADITIVA, logo a esmagadora maioria das teclas deixa
    // de pagar o reset. Apagar volta a pagá-lo, que é quando é preciso.
    //
    // Usa-se o comprimento e não o conteúdo porque é a única pergunta que
    // interessa ("pode ter ficado mais curto?") e é O(1). Um caso em que o
    // texto encurta e MESMO ASSIM precisa de mais altura — apagar um espaço e
    // fazer uma palavra longa mudar de linha — cai no ramo do reset na mesma,
    // porque encolher em chars é a condição, não encolher em altura.
    if (encolheu) ta.style.height = 'auto'

    const alvo = Math.min(ta.scrollHeight, maxHeight)
    // Escrita CONDICIONAL: reescrever a mesma altura invalida o layout à toa.
    // No estado estacionário (prompt no tecto dos 7 rows, ou de uma só linha)
    // isto passa a não escrever nada.
    if (ta.style.height !== `${alvo}px`) ta.style.height = `${alvo}px`

    if (ov) {
      ov.style.transform = `translateY(-${ta.scrollTop}px)`
    }
  }, [value, textareaRef])

  return (
    <Box px={{ base: 3.5, md: 4 }} pt={3.5} pb={1}>
      <Box
        position="relative"
        // CRITICAL: clipping must live on the parent (not the overlay) so the
        // transformed overlay can't leak above/below the textarea's visible
        // bounds when the user scrolls inside the textarea. Earlier the
        // overlay had its own overflow:hidden, which clipped the overlay's
        // CONTENT to its first H pixels — so a scrolled textarea would show
        // the right glyphs but the highlight overlay was stuck on the first
        // page (and the transformed-up portion leaked above the box). Moving
        // the clip here makes the parent the viewport, the overlay can render
        // the full highlighted content, and translateY scrolls correctly.
        overflow="hidden"
        // The textarea has WebkitTextFillColor: transparent so the highlight
        // overlay below can show through the glyphs. That property cascades
        // into ::placeholder, hiding the empty-state hint — restore visible
        // placeholder color here.
        css={{
          '& > textarea::placeholder': {
            color: tokens.colors.text.muted,
            WebkitTextFillColor: tokens.colors.text.muted,
            opacity: 1,
          },
          // With the textarea's text rendered transparent the SELECTED glyphs
          // also disappear under the selection background. Restore visibility
          // so users can see exactly what they are copying / cutting.
          '& > textarea::selection': {
            color: tokens.colors.text.primary,
            WebkitTextFillColor: tokens.colors.text.primary,
            background: 'rgba(254, 16, 99, 0.35)',
          },
          // Hide the textarea's native scrollbar so its content width stays
          // equal to the overlay's. Without this, once content exceeds 6 rows
          // a ~15px gutter appears on the textarea (overflow-y: auto) and
          // shrinks its layout width — but the overlay (position:absolute;
          // inset:0) keeps full width. Same text then wraps at different
          // columns in textarea vs overlay → caret and visible glyphs drift
          // apart → the user sees a "ghost gap" before the cursor and feels
          // like backspace deletes "from a distance" (the caret was at the
          // textarea's column N, but the overlay rendered the run ending at
          // column M). Scrolling still works via wheel / touchpad / arrows.
          '& > textarea::-webkit-scrollbar': {
            width: 0,
            height: 0,
          },
        }}
      >
        {/* Overlay — renders the FULL highlighted value (no own clipping; the
            parent box clips). Sits BEHIND the textarea visually (z-index 0)
            but above the page background. The textarea on top renders its
            text transparent so only the colored spans below show through.
            caret-color keeps the cursor visible; selection still works
            because the textarea owns input. */}
        <Box
          ref={overlayRef}
          aria-hidden
          position="absolute"
          inset={0}
          pointerEvents="none"
          color={tokens.colors.text.primary}
          opacity={disabled ? 0.5 : 1}
          style={TEXT_STYLE}
        >
          {renderHighlightedPrompt(value)}
          <InlineArgHint value={value} />
          {/* Trailing space so a value ending in newline reserves a final
              line — keeps the overlay height matching the textarea's. */}
          {value.endsWith('\n') ? '\u200b' : null}
        </Box>

        <textarea
          ref={textareaRef}
          value={value}
          data-prompt-composer="true"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onPaste={onPaste}
          onScroll={handleScroll}
          placeholder={isAgentBusy ? t('prompt.placeholderBusy') : `${t('prompt.placeholder')}${planSuffix}`}
          aria-label={t('prompt.ariaLabel')}
          disabled={disabled}
          rows={1}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          style={{
            ...TEXT_STYLE,
            width: '100%',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'transparent',
            caretColor: tokens.colors.text.primary,
            resize: 'none',
            maxHeight: `${7 * 23}px`,
            overflowY: 'auto',
            opacity: disabled ? 0.5 : 1,
            position: 'relative',
            // Webkit text-fill keeps text transparent even when browser tries
            // to colorize via autofill. Belt-and-braces with `color` above.
            WebkitTextFillColor: 'transparent',
          }}
        />
      </Box>
    </Box>
  )
}

/**
 * Ghost-text hint rendered after a slash command name when the command
 * declares an `argHint` and the user has no args typed yet. Memoised so
 * keystrokes inside args (or in unrelated text) don't re-render the
 * span. Pure visual — the textarea value is untouched.
 *
 * Mirrors the `/loop [interval] [prompt]` CLI placeholder pattern from
 * the screenshot in the user feedback.
 */
const InlineArgHint = memo(function InlineArgHint({ value }: { value: string }) {
  // useMemo so resolving the hint runs once per `value` change, not on
  // every keystroke + every other state push that re-renders the parent.
  const hint = useMemo(() => resolveInlineArgHint(value), [value])
  if (!hint) return null
  return (
    <Box
      as="span"
      color={tokens.colors.text.disabled}
      opacity={0.7}
      userSelect="none"
    >
      {value.endsWith(' ') ? hint : ` ${hint}`}
    </Box>
  )
})

export default memo(PromptTextarea)
