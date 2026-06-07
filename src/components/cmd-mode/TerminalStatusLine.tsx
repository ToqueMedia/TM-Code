/**
 * TerminalStatusLine — bottom status bar for CMD mode.
 * Shows: agent status dot + label · info segments · elapsed · tokens · stop button
 * Also renders the agent task list above the status bar when tasks are present.
 *
 * Memoized to isolate timer ticks from causing full-view re-renders.
 */
import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { useAgentElapsed } from "../../hooks/useAgentElapsed";
import { Box, Flex, Text } from "@chakra-ui/react";
import { FiArrowDown, FiArrowUp, FiSquare } from "react-icons/fi";
import { useChatStore } from "../../stores/chatStore";
import { useMcpStore } from "../../stores/mcpStore";
import { useAgentStore } from "../../stores/agentStore";
import { usePermissionStore } from "../../stores/permissionStore";
import { useSkillStore } from "../../stores/skillStore";
import { useBillingStore } from "../../stores/billingStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useBackgroundCommandStore } from "../../stores/backgroundCommandStore";
import { stopAgent } from "../../services/agent/cmdModeCommands";
import {
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from "../../services/agent/messageQueue";
import { usePreflightStatus } from "../../hooks/usePreflightStatus";
import { countAvailable } from "../../services/preflightService";
import {
  getProfileForPlan,
  MODEL_PROFILES,
} from "../../services/agent/modelProfiles";
import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} from "../../utils/contextWindow";
import { tokens } from "@/theme/tokens";
import { formatElapsed, formatTokens } from "./terminalHelpers";
import { useTranslation } from "@/i18n/useTranslation";

export const TerminalStatusLine = memo(function TerminalStatusLine() {
  const t = useTranslation();
  const status = useAgentStore((s) => s.status);
  const error = useAgentStore((s) => s.error);
  const workerStatus = useAgentStore((s) => s.workerStatus);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const totalTokensUsed = useChatStore((s) => s.totalTokensUsed);
  // currentPromptTokens is the per-turn input on the wire (input +
  // cache_read + cache_creation). Same value the ContextWindowIndicator
  // reads — keeps the terminal ctx % in lockstep with the chat-mode pill.
  // Also include output tokens for true context occupancy — see the fix
  // in ContextWindowIndicator for why input-only understated pressure.
  const currentPromptTokens = useChatStore((s) => {
    if (s.currentPromptTokens > 0) return s.currentPromptTokens;
    if (!s.activeSessionId) return 0;
    return s.sessions.get(s.activeSessionId)?.lastPromptTokens ?? 0;
  });
  const currentResponseTokens = useChatStore((s) => {
    if (s.currentResponseTokens > 0) return s.currentResponseTokens;
    if (!s.activeSessionId) return 0;
    return s.sessions.get(s.activeSessionId)?.lastResponseTokens ?? 0;
  });
  const headerContextWindow = useAgentStore((s) => s.modelContextWindow);
  const modelName = useAgentStore((s) => s.modelName);
  const skillCount = useSkillStore((s) => s.skills.length);
  const mcpServers = useMcpStore((s) => s.servers);
  const mcpIsInitializing = useMcpStore((s) => s.isInitializing);
  const totalMcpTools = useMcpStore((s) => s.getTotalToolCount());
  const autoApproveDiffs = usePermissionStore((s) => s.autoApproveDiffs);
  const queuedCommands = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  );
  const queueLength = queuedCommands.length;
  const preflight = usePreflightStatus();
  const devServer = useLayoutStore((s) => s.devServer);
  const bgCommands = useBackgroundCommandStore((s) => s.commands);

  // Session-mode elapsed: total wall time per request, freezes during permission waits.
  const { elapsedMs: elapsed } = useAgentElapsed("session");

  const handleStop = useCallback(async () => {
    // Check if there are pending permissions that will be cancelled
    const pendingCount = usePermissionStore.getState().getQueuedCount();
    if (pendingCount > 0) {
      const confirmed = window.confirm(
        `There are ${pendingCount} pending permission${pendingCount > 1 ? "s" : ""} in the queue. ` +
          `Stopping will cancel all of them. Continue?`,
      );
      if (!confirmed) return;
    }

    await stopAgent();
  }, []);

  const cfg = useMemo(() => {
    // Only show workerStatus when it's informative (retrying, errors, slow connections).
    // Normal first-attempt connections ("connecting (1/3)") are expected behavior and
    // create unnecessary visual noise — the user doesn't need to see routine network
    // handshakes. The default "Awaiting" label is sufficient for normal operation.
    const isInformativeStatus = workerStatus && (
      workerStatus.toLowerCase().includes('retry') ||
      workerStatus.toLowerCase().includes('error') ||
      workerStatus.toLowerCase().includes('timeout') ||
      workerStatus.toLowerCase().includes('failed')
    );
    const waitingLabel = isInformativeStatus ? workerStatus : t("terminalMode.status.awaiting");
    switch (status) {
      case "awaiting_response":
        return {
          color: tokens.colors.toolCall.runningText,
          label: waitingLabel,
          pulse: true,
        };
      case "reasoning":
        return {
          color: tokens.colors.accent.purple,
          label: t("terminalMode.status.reasoning"),
          pulse: true,
        };
      case "generating":
        return {
          color: tokens.colors.accent.primary,
          label: t("terminalMode.status.writing"),
          pulse: true,
        };
      case "applying":
        return {
          color: tokens.colors.accent.green,
          label: t("terminalMode.status.applying"),
          pulse: true,
        };
      case "compressing":
        return {
          color: tokens.colors.accent.orange,
          label: t("terminalMode.status.compacting"),
          pulse: true,
        };
      case "error":
        return {
          color: tokens.colors.accent.red,
          label: error || "error",
          pulse: false,
        };
      default:
        return {
          color: tokens.colors.text.disabled,
          label: t("terminalMode.status.ready"),
          pulse: false,
        };
    }
  }, [status, error, t, workerStatus]);

  // Up = context size on the wire (input is replaced with max across turns).
  // Down = output emitted by model (sums across turns). Historically shown as
  // two separate counters with directional arrows. UX request 2026-05-12:
  // present as a single combined number so the user sees "total traffic" at a
  // glance — the directional split is still derivable from the colour cue
  // (orange = sending, green = generating, grey = idle).
  const inputTok = totalTokensUsed.input;
  const outputTok = totalTokensUsed.output;
  const combinedTok = inputTok + outputTok;
  const isSending = status === "awaiting_response" || status === "compressing";
  const isReceiving =
    status === "generating" || status === "reasoning" || status === "applying";

  // Context-window percentage for the active model. Same telemetry as the
  // ContextWindowIndicator in ChatView, rendered terminal-style (text only,
  // no progress bar) to fit CMD mode's monospace aesthetic.
  //
  // Source of truth matches the chat-mode pill:
  //   • pressureTokens = currentPromptTokens + currentResponseTokens
  //     (true context occupancy — input includes all past history, output
  //     is current turn's generation not yet rolled into the next prompt).
  //     NOT totalTokensUsed.input, which is MAX across turns of the current
  //     request and inflates after compaction shrinks the prompt mid-loop.
  //   • headerContextWindow (X-Model-Context-Window) — falls back to the
  //     plan profile only pre-handshake.
  //   • Denominator is EFFECTIVE window (raw − 20K summary headroom),
  //     matching claude-vaz's calculateContextPercentages.
  const billingPlan = useBillingStore((s) => s.plan);
  const activeProfile = useMemo(() => {
    if (modelName && MODEL_PROFILES[modelName]) {
      return MODEL_PROFILES[modelName];
    }
    return getProfileForPlan(billingPlan);
  }, [modelName, billingPlan]);
  const rawContextWindow =
    headerContextWindow ?? activeProfile.contextWindow ?? 0;
  const effectiveWindow = getEffectiveContextWindowSize(rawContextWindow);
  const compactThreshold = getAutoCompactThreshold(rawContextWindow);
  const pressureTokens = currentPromptTokens + currentResponseTokens;
  const ctxPct =
    effectiveWindow > 0 && pressureTokens > 0
      ? Math.min(100, (pressureTokens / effectiveWindow) * 100)
      : 0;
  const compactImminent =
    pressureTokens >= compactThreshold && pressureTokens > 0;
  const ctxColor = compactImminent
    ? tokens.colors.accent.red
    : ctxPct < 70
      ? tokens.colors.text.disabled
      : ctxPct < 90
        ? tokens.colors.accent.orange
        : tokens.colors.accent.red;
  const ctxTooltip =
    ctxPct > 0
      ? `Context usage: ${pressureTokens.toLocaleString()} (${currentPromptTokens.toLocaleString()}+${currentResponseTokens.toLocaleString()}) / ${effectiveWindow.toLocaleString()} ${t("terminalMode.status.contextEffective")} (${ctxPct.toFixed(1)}%)\nModel: ${activeProfile.name}${compactImminent ? `\n⚡ Will optimize context next turn` : ""}`
      : undefined;

  // Toolkit preflight — small "tk 3/3" indicator. Tooltip lists missing pieces.
  const toolkit = useMemo(() => {
    if (!preflight.ranAt) return null;
    const { available, total } = countAvailable(preflight);
    const missing: string[] = [];
    if (!preflight.pandoc.found) missing.push("pandoc");
    if (!preflight.venv.found) missing.push("python venv");
    if (!preflight.npx.found) missing.push("npx");
    const label = `tk ${available}/${total}`;
    const title = missing.length
      ? t("terminalMode.status.missingTools").replace(
          "{missing}",
          missing.join(", "),
        )
      : t("terminalMode.status.allToolsAvailable");
    return { label, title, allGreen: missing.length === 0 };
  }, [preflight]);

  // Info segments — compact, terminal style
  const segments = useMemo(() => {
    const out: string[] = [];
    if (autoApproveDiffs) out.push(t("terminalMode.status.autoApprove"));
    if (queueLength > 0) out.push(`${queueLength} queued`);
    if (skillCount > 0)
      out.push(`${skillCount} ${t("terminalMode.status.skills")}`);
    if (mcpIsInitializing) {
      out.push("MCP connecting…");
    } else {
      const running = mcpServers.filter((s) => s.status === "running").length;
      if (running > 0) out.push(`${running} MCP (${totalMcpTools} tools)`);
    }
    if (devServer && devServer.status !== "stopped") {
      const url = devServer.frontendUrl || devServer.backendUrl;
      const port = url?.match(/:(\d+)/)?.[1];
      out.push(
        port
          ? `server :${port}`
          : devServer.status === "starting"
            ? "server starting…"
            : "server running",
      );
    }
    // Background commands
    const bgCmdRunning = Array.from(bgCommands.values()).filter(
      (c) => c.status === "running",
    ).length;
    const bgCmdCompleted = Array.from(bgCommands.values()).filter(
      (c) => c.status === "completed",
    ).length;
    const bgCmdErrored = Array.from(bgCommands.values()).filter(
      (c) => c.status === "error",
    ).length;
    if (bgCmdRunning > 0 || bgCmdCompleted > 0 || bgCmdErrored > 0) {
      const parts: string[] = [];
      if (bgCmdRunning > 0)
        parts.push(`${bgCmdRunning} ${t("terminalMode.status.running")}`);
      if (bgCmdCompleted > 0)
        parts.push(`${bgCmdCompleted} ${t("terminalMode.status.done")}`);
      if (bgCmdErrored > 0)
        parts.push(`${bgCmdErrored} ${t("terminalMode.status.err")}`);
      out.push(`${parts.join(", ")} background`);
    }
    return out;
  }, [
    autoApproveDiffs,
    queueLength,
    skillCount,
    mcpIsInitializing,
    mcpServers,
    totalMcpTools,
    devServer,
    bgCommands,
    t,
  ]);

  return (
    <>
      {/* Status bar */}
      <Flex
        align="center"
        justify="space-between"
        px={3}
        py="5px"
        borderTop="1px solid rgba(255,255,255,0.04)"
        bg="rgba(0,0,0,0.2)"
        minH="24px"
        flexShrink={0}
      >
        {/* Left: status dot + label + info */}
        <Flex align="center" gap={2} overflow="hidden">
          {/* Status dot */}
          <Box
            w="5px"
            h="5px"
            borderRadius="full"
            bg={cfg.color}
            flexShrink={0}
            css={
              cfg.pulse
                ? {
                    animation: "sPulse 1.5s ease-in-out infinite",
                    "@keyframes sPulse": {
                      "0%, 100%": { opacity: 1 },
                      "50%": { opacity: 0.25 },
                    },
                  }
                : undefined
            }
          />
          <Text
            fontSize="13px"
            color={tokens.colors.text.muted}
            fontFamily={tokens.fontFamily.mono}
            fontWeight="600"
            title={workerStatus || undefined}
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
          >
            {cfg.label}
          </Text>

          {segments.length > 0 && (
            <Text
              fontSize="13px"
              color={tokens.colors.text.disabled}
              fontFamily={tokens.fontFamily.mono}
            >
              {segments.join(" · ")}
            </Text>
          )}

          {toolkit && (
            <Text
              fontSize="13px"
              color={
                toolkit.allGreen
                  ? tokens.colors.accent.green
                  : tokens.colors.accent.orange
              }
              fontFamily={tokens.fontFamily.mono}
              title={toolkit.title}
            >
              {toolkit.label}
            </Text>
          )}
        </Flex>

        {/* Right: elapsed + tokens + stop */}
        <Flex align="center" gap={2} flexShrink={0}>
          {(isStreaming || ctxPct > 0) && (
            <Text
              fontSize="13px"
              color={tokens.colors.text.disabled}
              fontFamily={tokens.fontFamily.mono}
              whiteSpace="nowrap"
              title={ctxTooltip}
            >
              {isStreaming && formatElapsed(elapsed)}
              {ctxPct > 0 && (
                <>
                  {isStreaming && " · "}
                  <Text as="span" color={ctxColor}>
                    {`ctx ${Math.round(ctxPct)}%`}
                  </Text>
                </>
              )}
              {isStreaming && combinedTok > 0 && (
                <>
                  {" · "}
                  {isSending && (
                    <Box
                      as="span"
                      display="inline-flex"
                      alignItems="center"
                      color={tokens.colors.accent.orange}
                      mr="3px"
                      verticalAlign="-2px"
                    >
                      <FiArrowUp size={10} strokeWidth={2.5} />
                    </Box>
                  )}
                  {isReceiving && (
                    <Box
                      as="span"
                      display="inline-flex"
                      alignItems="center"
                      color={tokens.colors.accent.green}
                      mr="3px"
                      verticalAlign="-2px"
                    >
                      <FiArrowDown size={10} strokeWidth={2.5} />
                    </Box>
                  )}
                  {formatTokens(combinedTok)}
                </>
              )}
            </Text>
          )}

          {/* Stop button */}
          {isStreaming && (
            <Box
              as="button"
              display="flex"
              alignItems="center"
              justifyContent="center"
              w="18px"
              h="18px"
              borderRadius="3px"
              bg="transparent"
              color={tokens.colors.accent.red}
              cursor="pointer"
              transition="all 0.1s"
              _hover={{ bg: "rgba(248,81,73,0.1)" }}
              _active={{ transform: "scale(0.9)" }}
              onClick={handleStop}
              aria-label={t("misc.stop")}
              title={`${t("misc.stop")} (Esc)`}
            >
              <FiSquare size={10} />
            </Box>
          )}
        </Flex>
      </Flex>
    </>
  );
});
