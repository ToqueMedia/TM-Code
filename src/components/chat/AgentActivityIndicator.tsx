import { memo, useEffect, useRef } from "react";
import { Flex, Text, Box } from "@chakra-ui/react";
import { useAgentStore } from "../../stores/agentStore";
import { useParallelTaskStore, type ParallelTaskRun } from "../../stores/parallelTaskStore";
import { useChatStore } from "../../stores/chatStore";
import { useAgentElapsed } from "../../hooks/useAgentElapsed";
import { useCompactionProgress, formatCompactElapsed } from "../../hooks/useCompactionProgress";
import { tokens } from "@/theme/tokens";
import { t } from "@/i18n/useTranslation";

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function formatTokens(count: number): string {
  if (count === 0) return "0";
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const k = count / 1000;
    return k >= 100
      ? `${Math.round(k)}k`
      : k >= 10
        ? `${Math.round(k)}k`
        : `${k.toFixed(1)}k`;
  }
  const m = count / 1_000_000;
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

const STATUS_LABELS: Record<string, string> = {
  awaiting_response: "Awaiting response",
  reasoning: "Reasoning",
  generating: "Writing",
  applying: "Applying changes",
  compressing: "Compacting conversation",
  error: "Error",
  idle: "Idle",
};

const COMPACT_PHASE_LABELS: Record<string, string> = {
  hooks_pre: t("chat.compact.preHooks"),
  hooks_post: t("chat.compact.postHooks"),
  compressing: t("chat.compact.compacting"),
};

function AgentActivityIndicator() {
  const status = useAgentStore((s) => s.status);
  const compactPhase = useAgentStore((s) => s.compactPhase);
  const workerStatus = useAgentStore((s) => s.workerStatus);
  const isStreaming = useChatStore((s) => s.isStreaming);
  // ── Fase 2 (modelo foreground): o indicador é POSICIONAL — mostra o run
  // da SESSÃO VISÍVEL. Sessão de tarefa → strip da tarefa; sessão do main →
  // indicador clássico; a ver outra sessão qualquer → nada (o run principal
  // continua, mas não é o desta vista).
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const streamingSessionId = useChatStore((s) => s.streamingSessionId);
  // Selector devolve o PRÓPRIO run (referência muda a cada update dele) —
  // re-renderiza só quando a tarefa vista mexe, não a cada tool-event global.
  const viewedTaskRun = useParallelTaskStore((s) => {
    if (!activeSessionId) return null;
    for (const run of s.runs.values()) {
      if (run.sessionId === activeSessionId) return run;
    }
    return null;
  });
  const abortTask = useParallelTaskStore((s) => s.abort);
  const mainRunIsViewed = !streamingSessionId || streamingSessionId === activeSessionId;
  const totalTokensUsed = useChatStore((s) => s.totalTokensUsed);
  // (O badge ×N do multiplicador de persona foi REMOVIDO com o metering 30/70
  // — já não há multiplicador entre o custo e o contador.)
  // Session-mode elapsed: total wall time per request, freezes during permission waits.
  const { elapsedMs: elapsed } = useAgentElapsed("session");
  // Compaction progress — synthetic time-eased estimate; active only while the
  // agent is compressing context. Drives the polished progress bar below.
  const compaction = useCompactionProgress();
  const sessionStartRef = useRef(0);
  const prevStreamingRef = useRef(false);
  // Sessão do run em curso — capturada enquanto streama para o fecho do
  // timer saber ONDE o run viveu (streamingSessionId já está null no fim).
  const lastStreamingSessionRef = useRef<string | null>(null);
  const prevTotalTokensRef = useRef(0);

  // Track session start so the "Trabalhou por Xm Ys" closing message reports
  // the real wall-clock duration (not the paused-subtracted display value).
  useEffect(() => {
    if (isStreaming && sessionStartRef.current === 0) {
      sessionStartRef.current = Date.now();
    }
    if (isStreaming && streamingSessionId) {
      lastStreamingSessionRef.current = streamingSessionId;
    }
  }, [isStreaming, streamingSessionId]);

  // When streaming ends, add "Worked for Xm Ys" system message
  useEffect(() => {
    if (
      prevStreamingRef.current &&
      !isStreaming &&
      sessionStartRef.current > 0
    ) {
      const finalElapsed = Date.now() - sessionStartRef.current;
      // Só quando a sessão do run ainda é a visível — addSystemMessage
      // escreve na ATIVA, e o timer do main a cair no chat de uma tarefa
      // era poluição de sessão (bug latente da Fase 2).
      const endedSession = lastStreamingSessionRef.current;
      const stillViewingEndedSession =
        !endedSession || endedSession === useChatStore.getState().activeSessionId;
      if (finalElapsed > 2000 && stillViewingEndedSession) {
        // Ephemeral footer — momentary "worked for X" timer. Not interesting
        // enough to persist; auto-removes from the transcript after ~8s.
        useChatStore
          .getState()
          .addSystemMessage(
            `Trabalhou por ${formatElapsed(finalElapsed)}`,
            undefined,
            { ephemeral: true },
          );
      }
      sessionStartRef.current = 0;
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Compaction takes over the indicator with a polished gradient progress bar.
  // Placed before the !isStreaming guard so it also surfaces during a manual
  // /compact (where the streaming flag may not be set).
  if (compaction.active && mainRunIsViewed) {
    const compactLabel = t("chat.compact.compacting").replace(/[.…]+\s*$/, "");
    return (
      <Flex
        direction="column"
        gap="7px"
        py="10px"
        px={4}
        bg="rgba(10, 10, 10, 0.96)"
        zIndex={1}
        borderTop="1px solid rgba(255, 255, 255, 0.05)"
      >
        <Flex align="center" gap="8px">
          <Box
            w="6px"
            h="6px"
            borderRadius="full"
            bg={tokens.colors.accent.purple}
            flexShrink={0}
            css={{
              animation: "compactDot 1.5s ease-in-out infinite",
              "@keyframes compactDot": {
                "0%, 100%": { opacity: 1 },
                "50%": { opacity: 0.3 },
              },
            }}
          />
          <Text
            fontSize="12.5px"
            color={tokens.colors.text.secondary}
            fontWeight={500}
            flex="1"
            minW={0}
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
          >
            {compactLabel}…
          </Text>
          <Text
            fontSize="11.5px"
            color={tokens.colors.text.disabled}
            fontFamily={tokens.fontFamily.mono}
            whiteSpace="nowrap"
          >
            {formatCompactElapsed(compaction.elapsedMs)}
          </Text>
        </Flex>
        {/* Barra INDETERMINADA (2026-08-06). Havia aqui uma percentagem, e era
            inventada: uma ease exponencial sobre o relógio, com TAU de 45s. Numa
            compactação real de ~15s ia a ~28% e desaparecia — o developer leu
            isso como "correu ou fingiu", quando na verdade tinha libertado 63%
            da janela.

            Substituir a curva por marcos ('sumarizou' = 90%) seria trocar uma
            invenção por outra: os marcos existem, mas a fracção de TEMPO que
            cada um ocupa não se sabe. A referência resolve isto não tendo
            percentagem — o cli-vaz mostra `setSpinnerMessage('Compacting
            conversation')` e limpa-a no fim (screens/REPL.tsx).

            O que fica é honesto: uma barra em movimento (há trabalho a
            decorrer) e o tempo DECORRIDO, que é medido e não previsto. */}
        <Box
          h="5px"
          borderRadius="full"
          bg="rgba(255, 255, 255, 0.07)"
          overflow="hidden"
          position="relative"
        >
          <Box
            position="absolute"
            top={0}
            bottom={0}
            width="35%"
            borderRadius="full"
            bg={`linear-gradient(90deg, transparent 0%, ${tokens.colors.accent.purple} 50%, ${tokens.colors.accent.primary} 100%)`}
            boxShadow={`0 0 8px ${tokens.colors.accent.primaryGlow}`}
            css={{
              animation: 'tmCompactSweep 1.2s ease-in-out infinite',
              '@keyframes tmCompactSweep': {
                '0%': { left: '-35%' },
                '100%': { left: '100%' },
              },
            }}
          />
        </Box>
      </Flex>
    );
  }

  // Sessão de tarefa em curso → strip própria (com Stop). Tem prioridade
  // sobre o indicador do main: nesta vista, o run "daqui" é a tarefa.
  if (viewedTaskRun && (viewedTaskRun.status === "running" || viewedTaskRun.status === "queued")) {
    return <TaskRunStrip run={viewedTaskRun} onStop={() => abortTask(viewedTaskRun.id)} />;
  }

  // A ver uma sessão que não é a do run principal → o indicador do main não
  // pertence a esta vista.
  if (!mainRunIsViewed) return null;

  if (!isStreaming) return null;

  // Only show workerStatus when it's informative (retrying, errors, slow connections).
  // Normal first-attempt connections are expected behavior and create visual noise.
  const isInformativeStatus = workerStatus && (
    workerStatus.toLowerCase().includes('retry') ||
    workerStatus.toLowerCase().includes('error') ||
    workerStatus.toLowerCase().includes('timeout') ||
    workerStatus.toLowerCase().includes('failed')
  );
  const effectiveWorkerStatus = isInformativeStatus ? workerStatus : null;

  const label =
    effectiveWorkerStatus ||
    (status === "compressing"
      ? COMPACT_PHASE_LABELS[compactPhase] || STATUS_LABELS[status] || "Working"
      : STATUS_LABELS[status] || "Working");
  // One number: tokens that went up the wire plus tokens that came back.
  // The arrow is only a DIRECTION cue for live traffic — not a second counter.
  //   sending (awaiting_response / compressing / applying) → ↑
  //   receiving generated text (generating) → ↓
  //   reasoning → no arrow (thinking is not on the wire)
  const totalTokens = totalTokensUsed.input + totalTokensUsed.output;
  const isSending = status === "awaiting_response" || status === "compressing";
  const isReceiving = status === "generating";
  const showArrow = isSending || isReceiving;
  const totalJustGrew = totalTokens > prevTotalTokensRef.current;
  prevTotalTokensRef.current = totalTokens;

  return (
    <Flex
      align="center"
      gap="6px"
      py="8px"
      px={4}
      bg="rgba(10, 10, 10, 0.96)"
      zIndex={1}
      borderTop="1px solid rgba(255, 255, 255, 0.05)"
    >
      {/* Pulsing dot */}
      <Box
        w="6px"
        h="6px"
        borderRadius="full"
        bg={tokens.colors.accent.primary}
        flexShrink={0}
        css={{
          animation: "activityPulse 1.5s ease-in-out infinite",
          "@keyframes activityPulse": {
            "0%, 100%": { opacity: 1 },
            "50%": { opacity: 0.25 },
          },
        }}
      />

      {/* Status label */}
      <Text
        fontSize="12.5px"
        color={tokens.colors.text.muted}
        letterSpacing="-0.005em"
        title={workerStatus || undefined}
        flex="1"
        minW={0}
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
      >
        {label}
        {!workerStatus && (
          <Box
            as="span"
            css={{
              "&::after": {
                content: '"..."',
                animation: "dots 1.4s steps(4, end) infinite",
              },
              "@keyframes dots": {
                "0%": { content: '""' },
                "25%": { content: '"."' },
                "50%": { content: '".."' },
                "75%": { content: '"..."' },
              },
            }}
          />
        )}
      </Text>

      {/* Elapsed time + one traffic total. Arrow only while bytes move. */}
      <Text
        fontSize="11.5px"
        color={tokens.colors.text.disabled}
        fontFamily={tokens.fontFamily.mono}
        whiteSpace="nowrap"
        css={{ fontVariantNumeric: 'tabular-nums' }}
      >
        ({formatElapsed(elapsed)}
        {totalTokens > 0 && (
          <>
            {" \u00B7 "}
            {showArrow && (
              <Box
                as="span"
                fontSize="11px"
                css={{
                  display: "inline",
                  color: isSending
                    ? tokens.colors.accent.orange
                    : tokens.colors.accent.greenBright,
                  animation: totalJustGrew
                    ? "tokenPulse 0.6s ease-out"
                    : undefined,
                  "@keyframes tokenPulse": {
                    "0%": { opacity: 0.4 },
                    "100%": { opacity: 1 },
                  },
                }}
              >
                {isSending ? "\u2191" : "\u2193"}
              </Box>
            )}
            {showArrow ? " " : null}
            {formatTokens(totalTokens)}
          </>
        )}
        {")"}
      </Text>
    </Flex>
  );
}

/** Strip de atividade de uma TAREFA PARALELA cuja sessão está visível —
 *  par posicional do indicador do main: pulso + último tool + Stop. */
function TaskRunStrip({ run, onStop }: { run: ParallelTaskRun; onStop: () => void }) {
  const lastCall = run.toolCalls[run.toolCalls.length - 1];
  const detail =
    run.status === "queued"
      ? t("parallel.queued")
      : lastCall
        ? `${lastCall.toolName}${lastCall.argPreview ? ` ${lastCall.argPreview}` : ""}`
        : t("welcome.agentWorking");
  return (
    <Flex
      align="center"
      gap="8px"
      py="10px"
      px={4}
      bg="rgba(10, 10, 10, 0.96)"
      zIndex={1}
      borderTop="1px solid rgba(255, 255, 255, 0.05)"
    >
      <Box
        w="6px"
        h="6px"
        borderRadius="full"
        bg={run.status === "running" ? tokens.colors.accent.primary : tokens.colors.text.muted}
        flexShrink={0}
        css={{
          animation: run.status === "running" ? "taskStripDot 1.2s ease-in-out infinite" : undefined,
          "@keyframes taskStripDot": {
            "0%, 100%": { opacity: 1 },
            "50%": { opacity: 0.3 },
          },
        }}
      />
      <Text fontSize="12.5px" color={tokens.colors.text.secondary} fontWeight={500} flexShrink={0}>
        {t("parallel.stripLabel")}
      </Text>
      <Text
        fontSize="12px"
        color={tokens.colors.text.muted}
        fontFamily={tokens.fontFamily.mono}
        flex="1"
        minW={0}
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
      >
        {detail}
      </Text>
      {run.tokenUsage.output > 0 && (
        <Text fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono} flexShrink={0}>
          {run.tokenUsage.output.toLocaleString()}t
        </Text>
      )}
      <Box
        as="button"
        onClick={onStop}
        title={t("parallel.stopTask")}
        aria-label={t("parallel.stopTask")}
        fontSize="11px"
        fontWeight={600}
        color={tokens.colors.accent.red}
        px="8px"
        h="22px"
        borderRadius="6px"
        border={`1px solid ${tokens.colors.accent.redMuted}`}
        flexShrink={0}
        _hover={{ bg: tokens.colors.accent.redSubtle }}
      >
        Stop
      </Box>
    </Flex>
  );
}

export default memo(AgentActivityIndicator);
