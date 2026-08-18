/**
 * Host-side AI writing backend: turns a selected text plus a free-form
 * writing instruction (e.g. 润色 / 扩写 / 续写, or any custom request) into a
 * streaming LLM call through DSH's `llm` service (resolved inject-free via
 * `ctx.get`), then returns the plain generated text. The route forwards the
 * client's abort signal so a stopped generation actually cancels the
 * underlying model call.
 *
 * The call mirrors the harness's own auxiliary-request pattern
 * (dsh-session-title-llm): one `createUserMessage` over the text, the writing
 * rules in the `system` slot, and a `BlockAssembler` to fold the raw chunk
 * stream into the final text blocks.
 */
import type { Context } from './context-types.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime, Message } from '@deepseek-ai/dsh-llm'
import { SidebarError } from './wire.ts'

/** Maximum input length the route accepts (defense against runaway payloads). */
const MAX_INPUT_CHARS = 4000

/** Output token cap: keeps a single generation bounded (roughly 2000 tokens). */
const MAX_OUTPUT_TOKENS = 2000

/** The writing rules; the model must answer with processed text only. */
const SYSTEM_PROMPT = `你是一个写作助手。用户会给你一段文字和一个写作指令。
请根据指令处理文字，并只返回处理后的文字，不要任何解释、评价或前缀。

要求：
- 严格遵循用户的指令
- 保持自然的表达，避免 AI 味和套话
- 「润色」：优化表达但不改变原意，只返回润色后的完整文字
- 「扩写」：在原内容基础上扩展补充，使内容更丰富充实，只返回扩写后的完整文字
- 「续写」：基于原文接着写，保持风格一致，只返回续写出的新内容（不要重复原文）
- 其他指令：按指令的要求处理，只返回处理结果
- 不要添加用户没有要求的内容`

/**
 * Process the selected text with AI according to one free-form instruction.
 * @param ctx - the host plugin context (resolves `llm` inject-free).
 * @param text - the selected text to process.
 * @param instruction - the writing instruction (润色 / 扩写 / 续写 / custom).
 * @param signal - the client's abort signal; cancels the model call.
 * @returns the generated text (replacement, or the continuation when the
 *   instruction asks to continue the text).
 */
export async function processWithAI(
  ctx: Context,
  text: string,
  instruction: string,
  signal?: AbortSignal,
): Promise<string> {
  if (text.trim() === '') throw new SidebarError('bad-request', 'text is required')
  if (instruction.trim() === '') throw new SidebarError('bad-request', 'instruction is required')
  if (text.length > MAX_INPUT_CHARS) {
    throw new SidebarError('bad-request', `text exceeds ${MAX_INPUT_CHARS} characters`)
  }
  const llm = ctx.get('llm') as LlmRuntime | undefined
  if (llm === undefined) throw new SidebarError('ai-error', 'LLM service unavailable', 503)

  // Resolve the provider/model the deployment actually uses: the configured
  // default model selection (`agent-default-model`, e.g. a Mify route), falling
  // back to the first registered provider/model when there is no default, the
  // default names an unregistered provider, or its model is unavailable.
  interface DefaultModelSelection { provider: string; model: string }
  const agentDefault = ctx.get('agentDefaultModel') as
    | { currentSelection(): DefaultModelSelection }
    | undefined
  const providers = llm.listProviders()
  if (providers.length === 0) throw new SidebarError('ai-error', 'no LLM provider configured', 503)

  let provider = providers[0]!.id
  let model: string | undefined
  const selection = agentDefault?.currentSelection()
  if (selection !== undefined && providers.some(p => p.id === selection.provider)) {
    provider = selection.provider
    model = selection.model
  }

  const models = await llm.listModels(provider)
  if (models.length === 0) throw new SidebarError('ai-error', `no model available for provider "${provider}"`, 503)
  if (model === undefined || !models.some(m => m.id === model)) {
    model = models[0]!.id
  }

  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: `指令：${instruction}\n\n文字：\n---\n${text}\n---` }],
    source: { kind: 'plugin', plugin: 'dsh-better-sidebar' },
  })]
  const options: GenerateOptions = {
    provider,
    model,
    messages,
    system: SYSTEM_PROMPT,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal,
  }

  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) {
    signal?.throwIfAborted()
    assembler.push(chunk)
  }
  signal?.throwIfAborted()

  const finish = assembler.finish
  if (finish.kind === 'error') {
    throw new SidebarError('ai-error', finish.failure.message, 502)
  }
  if (finish.kind === 'aborted') {
    throw new SidebarError('ai-error', 'generation cancelled', 499)
  }
  if (finish.kind === 'tool-calls') {
    throw new SidebarError('ai-error', 'model produced unexpected tool calls', 502)
  }

  const blocks = assembler.blocks()
  const result = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (result === '') throw new SidebarError('ai-error', 'model produced no text', 502)
  return result
}
