import { memo, useEffect, useRef } from "react";
import { Flex, Text, Box } from "@chakra-ui/react";
import { useAgentStore } from "../../stores/agentStore";
import { useChatStore } from "../../stores/chatStore";
import { useAgentElapsed } from "../../hooks/useAgentElapsed";
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
  const totalTokensUsed = useChatStore((s) => s.totalTokensUsed);
  // Session-mode elapsed: total wall time per request, freezes during permission waits.
  const { elapsedMs: elapsed } = useAgentElapsed("session");
  const sessionStartRef = useRef(0);
  const prevStreamingRef = useRef(false);
  const prevOutputTokensRef = useRef(0);

  // Track session start so the "Trabalhou por Xm Ys" closing message reports
  // the real wall-clock duration (not the paused-subtracted display value).
  useEffect(() => {
    if (isStreaming && sessionStartRef.current === 0) {
      sessionStartRef.current = Date.now();
    }
  }, [isStreaming]);

  // When streaming ends, add "Worked for Xm Ys" system message
  useEffect(() => {
    if (
      prevStreamingRef.current &&
      !isStreaming &&
      sessionStartRef.current > 0
    ) {
      const finalElapsed = Date.now() - sessionStartRef.current;
      if (finalElapsed > 2000) {
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
      px={3}
      position="sticky"
      bottom={0}
      bg={tokens.colors.bg.app}
      zIndex={1}
      borderTop="1px solid rgba(255, 255, 255, 0.04)"
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

export default memo(AgentActivityIndicator);
