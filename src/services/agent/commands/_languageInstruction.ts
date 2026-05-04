import { useSettingsStore, type AgentLanguage } from '../../../stores/settingsStore'

/**
 * Build a language directive that slash commands inject into their custom
 * prompts. The standard system prompt already carries one (via
 * contextBuilder.getLangInstruction), but slash commands send a
 * `<request>`-style block as the first user message — the model often
 * mirrors that block's language for the rest of the turn, defeating the
 * system-level directive. Surfacing the directive again INSIDE the
 * custom prompt re-anchors the language for the report.
 */

const AGENT_LANG_NAMES: Record<AgentLanguage, string> = {
  en: 'English',
  pt: 'Portuguese',
  zh: '中文',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ja: '日本語',
}

export function getAgentLanguageName(): string {
  const lang = useSettingsStore.getState().agentLanguage || 'en'
  return AGENT_LANG_NAMES[lang] || AGENT_LANG_NAMES.en
}

/**
 * One-line directive for slash command prompts. Wrap in your own XML/
 * markdown delimiters as the prompt format demands.
 */
export function languageDirective(): string {
  const name = getAgentLanguageName()
  if (name === 'English') {
    return 'Respond in English. All narration, summaries, bug descriptions, and the final report must be in English.'
  }
  return `Respond in ${name}. All narration, summaries, bug descriptions, and the final report must be in ${name}. Code identifiers, file paths, tool names and tool arguments stay in their native form.`
}
