/**
 * READER side of the cross-window agent-run badge (see
 * services/projectAgentStatusService.ts for the writer + liveness contract).
 *
 * Polls `get_project_agent_statuses` for the given project paths and returns
 * only the statuses worth showing: `idle` entries and stale `running` entries
 * (dead writer — no heartbeat inside the staleness window) are filtered out
 * here so the UI never renders a lying badge.
 *
 * Poll cadence: see projectAgentStatusPoll.ts (~1.5s focused / 3s background)
 * + immediate re-poll on focus/visibilitychange.
 */

import { useEffect, useState } from 'react'
import { invoke } from '@/utils/invokeMetrics'
import {
  PROJECT_AGENT_STATUS_STALE_MS,
  type ProjectAgentStatus,
} from '@/services/projectAgentStatusService'
import {
  projectAgentStatusPollIntervalMs,
  PROJECT_AGENT_STATUS_POLL_FOCUSED_MS,
  PROJECT_AGENT_STATUS_POLL_MS,
} from '@/services/projectAgentStatusPoll'

export type { ProjectAgentStatus } from '@/services/projectAgentStatusService'
export {
  PROJECT_AGENT_STATUS_POLL_FOCUSED_MS,
  PROJECT_AGENT_STATUS_POLL_MS,
  projectAgentStatusPollIntervalMs,
}

export function useProjectAgentStatuses(
  paths: string[],
  enabled = true,
): Record<string, ProjectAgentStatus> {
  const [statuses, setStatuses] = useState<Record<string, ProjectAgentStatus>>({})
  // Effect key: the PATH SET, not the array identity — callers map() a fresh
  // array every render and we must not restart the interval each time.
  const pathsKey = paths.join('\n')

  useEffect(() => {
    if (!enabled || pathsKey.length === 0) {
      setStatuses({})
      return
    }
    const pollPaths = pathsKey.split('\n')
    let active = true
    let timer: ReturnType<typeof setInterval> | null = null

    const poll = async () => {
      try {
        const raw = await invoke<Record<string, ProjectAgentStatus>>(
          'get_project_agent_statuses',
          { projectPaths: pollPaths },
        )
        if (!active) return
        const now = Date.now()
        const next: Record<string, ProjectAgentStatus> = {}
        for (const [path, status] of Object.entries(raw ?? {})) {
          if (!status || status.state === 'idle') continue
          if (
            status.state === 'running' &&
            now - status.updatedAt > PROJECT_AGENT_STATUS_STALE_MS
          ) {
            continue // dead writer — crashed/killed mid-run
          }
          next[path] = status
        }
        setStatuses(next)
      } catch {
        /* Tauri absent (tests) or transient IPC failure — keep last state */
      }
    }

    const arm = () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (!active) return
      timer = setInterval(() => void poll(), projectAgentStatusPollIntervalMs())
    }

    void poll()
    arm()

    const onVis = () => {
      void poll() // immediate refresh on focus
      arm()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis)
      window.addEventListener('focus', onVis)
    }

    return () => {
      active = false
      if (timer) clearInterval(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis)
        window.removeEventListener('focus', onVis)
      }
    }
  }, [pathsKey, enabled])

  return statuses
}
