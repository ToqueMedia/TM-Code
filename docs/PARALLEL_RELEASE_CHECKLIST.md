# Parallel / multi-window — release checklist

Authoritative runtime policy: `ARCHITECTURE.md` → **Current parallel model** and
`src/services/agent/parallelTasks/policy.ts`.

Run before tagging a release that touches agent concurrency, project windows, or park/stop.

## Automated

```bash
yarn test src/services/agent/parallelTasks/__tests__/oneAgentPerProject.test.ts
yarn test src/services/agent/parallelTasks/__tests__/policy.test.ts
yarn test src/services/agent/parallelTasks/__tests__/steerContent.test.ts
yarn test src/services/agent/parallelTasks/__tests__/parallelTasks.test.ts
yarn test src/services/agent/parallelTasks/__tests__/projectRun.test.ts
yarn test src/services/__tests__/projectWorkspacePark.test.ts
yarn test src/services/__tests__/projectAgentStatusService.test.ts 2>/dev/null || true
```

## Manual multi-window matrix

| # | Case | Expected |
|---|------|----------|
| 1 | Window A agent running on `/proj-a`; open `/proj-b` in window B and run agent | Both run; badges independent |
| 2 | Window A agent on `/proj-a`; try second concurrent task / asTask on A | Refused or steer-only; i18n one-agent message |
| 3 | Two windows open same `/proj-a` | Double-open **warning** by default; with Settings “Block second window” → refuse (no Open anyway) |
| 3b | Stop project from other window sidebar | Owner chat shows `stoppedRemoteWindow`; run aborts within a few seconds when owner focused |
| 4 | Stop from composer on live session | Run stops; queue parked if residual tasks |
| 5 | Cross-window stop request (if UI exposes X on foreign task row) | Owner aborts within turn boundary or ≤30s heartbeat (≤~3s if owner focused) |
| 6 | Budget exhaust mid-run | Stop-all, system message, queue parked; other window sees error/badge after focus `/v1/me` |
| 7 | Switch project in-window while running | Confirm → run cancelled |
| 8 | `send_agent_message` if model calls it | Tool error: one agent per project |
| 8b | Steer live session agent with image attachment | Image reaches model (or sidecar description); no "attachments ignored" system warn |
| 8d | Session-agent **first** message with image | Multimodal on turn 1 (not text-only after history pop) |
| 8e | Badge lag other window while owner focused | Status refresh within ~2–4s (writer 3s + reader 1.5s) |
| 8c | `/plan` while task session is **running** | Live agent → architect (plan tools on **child** executor + system prompt + `X-Request-Type: plan`); auto-approve restored on settle; card on **task** session; other slash cmds still blocked |
| 8f | Click project row with agent **running/done in another window** | First click: focus request (owner ≤2s idle poll / ≤3s focused heartbeat); toast “click again to open here”. Second click: open locally |
| 8g | `update_tasks` claims | Auto-claim on `in_progress`; foreign claim blocks **status** flips only; same-status description patches OK; board mirror consulted |
| 9 | Attention Inbox with permission on live run | Origin correct; click navigates to session |
| 10 | Kill -9 agent window | Other windows: `running` badge clears after stale (90s) |

## Policy regression

- [ ] `ONE_AGENT_PER_PROJECT === true` in `policy.ts`
- [ ] `addParallelTask` returns null
- [ ] ARCHITECTURE “Current parallel model” matches code (no “Fase 5 not built” vs FEITA conflict)
