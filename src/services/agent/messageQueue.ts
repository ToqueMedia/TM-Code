/**
 * Message Queue Manager — standalone module (not React/Zustand).
 *
 * Inspired by Claude Code's messageQueueManager.ts:
 * - Module-level frozen snapshot updated on every mutation
 * - Signal-based reactivity via useSyncExternalStore for React
 * - The agentic loop reads directly without React overhead
 * - FIFO ordering — commands processed in enqueue order
 */

import { useSyncExternalStore } from 'react'
import type { Attachment } from '../../types/chat'

// === Types ===

export interface QueuedCommand {
  /** Unique ID for this queued command */
  id: string
  /** The user's message text */
  value: string
  /** Timestamp when enqueued */
  timestamp: number
  /** Attachments captured at enqueue time (images, files). Resolved at execution time. */
  attachments?: Attachment[]
}

// === Signal (pub-sub for useSyncExternalStore) ===

type Listener = () => void

function createSignal() {
  const listeners = new Set<Listener>()

  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit() {
      for (const listener of listeners) listener()
    },
  }
}

// === Module state ===

let queue: QueuedCommand[] = []
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const signal = createSignal()

function updateSnapshot() {
  snapshot = Object.freeze([...queue])
  signal.emit()
}

// === Public API ===

/**
 * Add a command to the queue (FIFO).
 */
export function enqueue(value: string, attachments?: Attachment[]): QueuedCommand {
  const command: QueuedCommand = {
    id: crypto.randomUUID(),
    value,
    timestamp: Date.now(),
    ...(attachments?.length && { attachments }),
  }
  queue.push(command)
  updateSnapshot()
  return command
}

/**
 * Remove and return the oldest command.
 */
export function dequeue(): QueuedCommand | undefined {
  if (queue.length === 0) return undefined
  const command = queue.shift()!
  updateSnapshot()
  return command
}

/**
 * Remove and return ALL commands in FIFO order.
 */
export function dequeueAll(): QueuedCommand[] {
  if (queue.length === 0) return []
  const all = [...queue]
  queue.length = 0
  updateSnapshot()
  return all
}

/**
 * Peek at the queue without removing anything.
 */
export function peek(): readonly QueuedCommand[] {
  return snapshot
}

/**
 * Check if queue has any commands.
 */
export function hasQueued(): boolean {
  return queue.length > 0
}

/**
 * Clear the entire queue.
 */
export function clearQueue(): void {
  queue.length = 0
  updateSnapshot()
}

/**
 * Remove a specific command by ID.
 */
export function remove(id: string): boolean {
  const index = queue.findIndex(c => c.id === id)
  if (index === -1) return false
  queue.splice(index, 1)
  updateSnapshot()
  return true
}

// === React integration ===

/**
 * Get the current frozen snapshot (for useSyncExternalStore getSnapshot).
 */
function getSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

/**
 * React hook — subscribe to queue changes.
 * Returns a frozen array of queued commands in FIFO order.
 */
export function useCommandQueue(): readonly QueuedCommand[] {
  return useSyncExternalStore(signal.subscribe, getSnapshot, getSnapshot)
}
