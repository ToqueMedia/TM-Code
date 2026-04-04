/**
 * Queue Processor Hook — processes queued messages when the agent becomes idle.
 *
 * Inspired by Claude Code's useQueueProcessor.ts:
 * - Subscribes to both queryGuard (agent state) and messageQueue (pending commands)
 * - When agent finishes AND queue has items, fires the callback
 * - Each queued command becomes a new user message + agent loop
 */

import { useEffect, useRef } from 'react'
import { useCommandQueue, dequeueAll, type QueuedCommand } from '../services/agent/messageQueue'
import { useQueryGuard } from '../services/agent/queryGuard'

interface UseQueueProcessorParams {
  /** Callback to execute queued commands. Receives all dequeued commands at once. */
  executeQueuedInput: (commands: QueuedCommand[]) => Promise<void>
}

export function useQueueProcessor({ executeQueuedInput }: UseQueueProcessorParams): void {
  const isAgentActive = useQueryGuard()
  const queuedCommands = useCommandQueue()
  const processingRef = useRef(false)

  // Check conditions and dequeue synchronously to prevent double-firing.
  // The async execution happens after the guard is set.
  useEffect(() => {
    if (processingRef.current) return
    if (isAgentActive) return
    if (queuedCommands.length === 0) return

    // Synchronous guard — prevents concurrent triggers from rapid re-renders
    processingRef.current = true

    // Drain the queue synchronously (before any await)
    const commands = dequeueAll()
    if (commands.length === 0) {
      processingRef.current = false
      return
    }

    // Execute asynchronously, release guard when done
    executeQueuedInput(commands).finally(() => {
      processingRef.current = false
    })
  }, [isAgentActive, queuedCommands.length, executeQueuedInput])
}
