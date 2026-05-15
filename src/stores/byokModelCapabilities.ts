import type { ByokModelCapabilities } from './byokStore'

// Heuristic capability inference for local-provider models (Ollama, LM Studio).
//
// Neither Ollama's /api/tags nor LM Studio's /v1/models reports capabilities,
// so without inference we'd default everything to false — which makes Ollama
// feel broken because the agent never sees tools and falls back to plain chat.
//
// The heuristic is conservative on purpose: better to under-report a
// capability (user notices and switches model) than to over-report and have
// the model 400 mid-tool-call. Pattern families covered (last reviewed
// 2026-05-08, sourced from each project's official tool/vision support
// announcements):
//
//   tools      — qwen2.5+, qwen3+, llama3.1+, llama4+, mistral/mixtral,
//                gemma3+, phi3.5+, phi4+, gpt-oss, command-r, nemotron,
//                granite3+, firefunction
//   thinking   — deepseek-r1, qwq, qwen3-thinking variants
//   images     — llava family, *-vl* (qwen2-vl, qwen2.5-vl, qwen3-vl),
//                llama3.2-vision, llama4 vision SKUs, moondream, bakllava
//
// Excluded by design (poor or missing tool support — user can still pick
// these models, they just won't have tools auto-enabled):
//   - llama3 (3.0): tools support was unreliable.
//   - gemma2: no native tools.
//   - phi3 base (3.0): same.
//   - qwen2.0 base: no native tools.
//
// LM Studio model ids are often path-shaped (`bartowski/Llama-3.2-3B-Instruct-GGUF`);
// lowercasing + family-name regexes handle both shapes uniformly.
//
// Lives in its own module (rather than inline in byokStore) so it can be
// unit-tested without dragging the Zustand+Firebase import chain into Jest.
export function inferLocalModelCapabilities(modelId: string): {
  capabilities: ByokModelCapabilities
  supportsThinking: boolean
} {
  const id = modelId.toLowerCase()
  const capabilities: ByokModelCapabilities = { images: false, audio: false, video: false, tools: false }

  // Vision-capable families.
  if (/\bllava|bakllava|-vl[-:.@/]|-vl$|\bvl-|\bvision\b|moondream/i.test(id)) {
    capabilities.images = true
  }

  // Reasoning-capable families. tools is intentionally NOT set here — most
  // reasoning-only releases on Ollama (deepseek-r1, qwq) ship without tool
  // calling and trying tools causes confusing failures.
  let supportsThinking = false
  if (/deepseek-?r1|\bqwq\b|qwq-|qwen-?3-?thinking/i.test(id)) {
    supportsThinking = true
  }

  // Tool-capable families. Each clause matches a single family with its
  // minimum tool-supporting version.
  if (
    // Llama 3.1, 3.2, 3.3, 4+, but NOT 3.0
    /llama-?3\.[1-9]|llama-?[4-9]/.test(id) ||
    // Qwen 2.5, Qwen 3, Qwen 4+
    /qwen-?2\.5|qwen-?[3-9](?![\d.])|qwen-?[3-9]\./.test(id) ||
    // Mistral and Mixtral families (all current versions support tools)
    /\bmistral|mixtral/.test(id) ||
    // Gemma 3+
    /gemma-?[3-9]/.test(id) ||
    // Phi 3.5+ and Phi 4+
    /phi-?3\.5|phi-?[4-9]/.test(id) ||
    // OpenAI open weights
    /gpt-oss/.test(id) ||
    // Cohere Command R
    /command-?r/.test(id) ||
    // NVIDIA Nemotron
    /nemotron/.test(id) ||
    // IBM Granite 3+
    /granite-?[3-9]/.test(id) ||
    // Fireworks function-calling
    /firefunction/.test(id)
  ) {
    capabilities.tools = true
  }

  return { capabilities, supportsThinking }
}
