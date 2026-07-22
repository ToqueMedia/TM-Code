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
  const prevOutputTokensRef = useRef(0);

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
        <Flex align="center" gap="10px">
          <Box
            flex="1"
            h="5px"
            borderRadius="full"
            bg="rgba(255, 255, 255, 0.07)"
            overflow="hidden"
            position="relative"
          >
            <Box
              position="absolute"
              left={0}
              top={0}
              bottom={0}
              borderRadius="full"
              width={`${compaction.percent}%`}
              bg={`linear-gradient(90deg, ${tokens.colors.accent.purple} 0%, ${tokens.colors.accent.primary} 100%)`}
              boxShadow={`0 0 8px ${tokens.colors.accent.primaryGlow}`}
              transition="width 0.25s ease-out"
            />
          </Box>
          <Text
            fontSize="11px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.mono}
            minW="34px"
            textAlign="right"
            css={{ fontVariantNumeric: "tabular-nums" }}
          >
            {compaction.percent}%
          </Text>
        </Flex>
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
  // chatStore.addTokenUsage:
  //   - input  is REPLACED with max(prev, newInput) — represents the CURRENT
  //              context size on the wire (turn N's input already contains
  //              turns 1..N-1, so summing would double-count massively).
  //   - output is SUMMED across turns — each turn emits NEW tokens.
  //
  // Adding the two together (the previous behaviour) was incoherent: it
  // mixed "size of conversation in flight" with "tokens emitted so far".
  // Show them as two distinct directional counters instead.
  const inputTokens = totalTokensUsed.input;
  const outputTokens = totalTokensUsed.output;

  // Arrows are STATE INDICATORS — they only appear next to the counter
  // that is actively accumulating right now.
  //   'awaiting_response' / 'compressing' → ↑ visible (input is being prepared/sent)
  //   'reasoning' / 'generating' / 'applying' → ↓ visible (output is streaming back)
  //   any other state → neither arrow rendered (counter numbers still show)
  // The previous design rendered both arrows permanently as colored labels;
  // user feedback was that they read as static text rather than live state.
  const isSending = status === "awaiting_response" || status === "compressing";
  const isReceiving =
    status === "reasoning" || status === "generating" || status === "applying";

  // Detect output growth so the down-arrow pulses subtly during active receipt.
  const outputJustGrew = outputTokens > prevOutputTokensRef.current;
  prevOutputTokensRef.current = outputTokens;

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

      {/* Elapsed time + per-direction token counters. Up-arrow shows context
          size on the wire (input, the last turn's prompt — ratchets up across
          turns). Down-arrow shows tokens emitted by the model (output, sums
          across turns). Mixing the two would be a unit error — they answer
          different questions. The "live" direction is highlighted by colour. */}
      <Text
        fontSize="11.5px"
        color={tokens.colors.text.disabled}
        fontFamily={tokens.fontFamily.mono}
        whiteSpace="nowrap"
        css={{ fontVariantNumeric: 'tabular-nums' }}
      >
        ({formatElapsed(elapsed)}
        {inputTokens > 0 && (
          <>
            {" \u00B7 "}
            {isSending && (
              <>
                <Box
                  as="span"
                  fontSize="11px"
                  css={{
                    display: "inline",
                    color: tokens.colors.accent.orange,
                  }}
                >
                  {"\u2191"}
                </Box>{" "}
              </>
            )}
            {formatTokens(inputTokens)}
          </>
        )}
        {outputTokens > 0 && (
          <>
            {" \u00B7 "}
            {isReceiving && (
              <>
                <Box
                  as="span"
                  fontSize="11px"
                  css={{
                    display: "inline",
                    color: tokens.colors.accent.greenBright,
                    animation: outputJustGrew
                      ? "tokenPulse 0.6s ease-out"
                      : undefined,
                    "@keyframes tokenPulse": {
                      "0%": { opacity: 0.4 },
                      "100%": { opacity: 1 },
                    },
                  }}
                >
                  {"\u2193"}
                </Box>{" "}
              </>
            )}
            {formatTokens(outputTokens)}
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
