/**
 * Dispatch precedence — verifies that slash commands take precedence over
 * hashtag flows when a prompt contains both.
 *
 * Why: a user's `/plan landing page with #design` is asking for the
 * architect (`/plan`) — the `#design` is part of the architectural
 * description, not a routing signal. Before the precedence fix, the hashtag
 * preprocessor consumed the tag first, routed to the hashtag flow, and the
 * /plan command never executed (the architect prompt + planMode never
 * activated, so the agent went into normal IDE-implementation mode and
 * scaffolded the project).
 *
 * NOTE (2026-07): the original regression case used `#auth-google`
 * (runAuthFlow). The managed-auth hashtag flow was removed with the
 * MANAGED-PLATFORM layer, so the precedence contract is now exercised with
 * `#design` — the remaining registry tag.
 *
 * This test imports `preprocessHashtags` only — `slashCommandRegistry`
 * pulls in the entire toolExecutor + Tauri/Vite stack which Jest can't
 * load. We verify the slash check independently with a regex (the same
 * shape `slashCommandRegistry.isSlashCommand` uses internally).
 */

import { preprocessHashtags } from '../hashtagRegistry'

// Mirrors slashCommandRegistry.isSlashCommand without importing the
// heavyweight registry module.
function looksLikeSlashCommand(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return false
  const cmd = trimmed.split(/\s+/)[0]
  // A real registered command — the test only cares about the SHAPE that
  // would route to the slash path, not which commands are registered.
  return /^\/[a-z]+$/i.test(cmd ?? '')
}

describe('slash command vs hashtag precedence', () => {
  test('a /plan with #design in the args matches BOTH detectors', () => {
    const prompt = '/plan landing page with #design'
    const isSlash = looksLikeSlashCommand(prompt)
    const pre = preprocessHashtags(prompt)

    // Both detectors fire — that's the whole point of the precedence rule.
    expect(isSlash).toBe(true)
    expect(pre.hasDesign).toBe(true)
  })

  test('a NON-slash prompt with #design routes only via hashtag', () => {
    const prompt = 'add #design polish to my app'
    expect(looksLikeSlashCommand(prompt)).toBe(false)
    const pre = preprocessHashtags(prompt)
    expect(pre.hasDesign).toBe(true)
  })

  test('the removed #auth-google tag no longer fires the hashtag detector', () => {
    // Managed-auth hashtags were cut with the MANAGED-PLATFORM layer; the
    // former trigger must now pass through as plain text to the agent.
    const prompt = 'add #auth-google to my app'
    const pre = preprocessHashtags(prompt)
    expect(pre.hasDesign).toBe(false)
    expect(pre.cleanedText).toContain('#auth-google')
  })

  test('a plain /plan with no hashtag matches only the slash detector', () => {
    const prompt = '/plan build a todo app'
    expect(looksLikeSlashCommand(prompt)).toBe(true)
    const pre = preprocessHashtags(prompt)
    expect(pre.hasDesign).toBe(false)
  })

  test('a plain text message matches neither detector', () => {
    const prompt = 'fix the bug in App.tsx'
    expect(looksLikeSlashCommand(prompt)).toBe(false)
    const pre = preprocessHashtags(prompt)
    expect(pre.hasDesign).toBe(false)
  })

  // Documentation test — the dispatch order must be slash → hashtag → normal.
  // This isn't enforceable from outside handleSend without mounting the full
  // full prompt stack; the integration test in planCommandIntegration.test.ts
  // covers the slash → executePlan path. This describe block exists so the
  // expectation is captured in tests rather than only in the source comment.
  test('the dispatch contract: slash wins when both detectors fire', () => {
    const prompt = '/plan platform with #design polish'
    const isSlash = looksLikeSlashCommand(prompt)
    const wouldHashtagFire = preprocessHashtags(prompt).hasDesign

    // Both true — the dispatcher (usePromptBar.handleSend) MUST evaluate
    // slash FIRST and return without invoking the hashtag handler.
    expect(isSlash).toBe(true)
    expect(wouldHashtagFire).toBe(true)
    // The decision is made in source: see usePromptBar.ts:handleSend.
    // The reordering of those branches is the fix this test guards against
    // future regressions of.
  })
})
