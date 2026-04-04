/**
 * Query Guard — module-level tracker for agent execution state.
 *
 * Inspired by Claude Code's QueryGuard.js:
 * - Simple active/inactive tracking
 * - Controls whether user input enqueues or executes immediately
 * - Signal-based reactivity for React (useSyncExternalStore)
 */

import { useSyncExternalStore } from 'react'

type Listener = () => void

const listeners = new Set<Listener>()
let active = false

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Mark the agent as actively running.
 * Called at the start of runAgentLoop.
 */
export function reserve(): void {
  if (!active) {
    active = true
    emit()
  }
}

/**
 * Mark the agent as idle.
 * Called when runAgentLoop finishes (success, error, or cancel).
 */
export function end(): void {
  if (active) {
    active = false
    emit()
  }
}

/**
 * Check if the agent is currently running (non-reactive, for service code).
 */
export function isActive(): boolean {
  return active
}

// === React integration ===

function getSnapshot(): boolean {
  return active
}

/**
 * React hook — subscribe to agent active state.
 * Returns true if agent is running.
 */
export function useQueryGuard(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
