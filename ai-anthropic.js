// Anthropic（Claude）后端：用官方 SDK 调 Messages API。和 OpenAI 兼容后端返回同样的 { content, tokens, truncated }。
// 默认模型 claude-opus-5-5：思考一直开着，用 output_config.effort 控制深度；模型拒绝时默认开服务端回退（AI_FALLBACKS=off 关）。
const DEFAULT_MODEL = 'claude-opus-5-5'
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

function createAnthropicTransport({ apiKey, model, baseUrl, fallbacks = true, client }) {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk').default
    // 重试和超时由 ai.js 统一管：这里不让 SDK 自己再重试，免得一次请求偷偷变成三次、计数对不上
    client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}), maxRetries: 0, timeout: 90_000 })
  }
  const useFallbacks = fallbacks && !baseUrl // 只有官方 API 支持服务端回退参数
  return async function request({ system, messages, effort, signal }) {
    const params = {
      model: model || DEFAULT_MODEL,
      max_tokens: 16000,
      system,
      messages,
      // 玩家指令要快：思考深度按调用方给的档位；'off' 用最低档（这个模型的思考关不掉）
      output_config: { effort: EFFORTS.has(effort) ? effort : 'low' },
    }
    const response = useFallbacks
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : await client.messages.create(params, { signal })
    if (response.stop_reason === 'refusal') {
      const err = new Error('模型拒绝了这个请求')
      err.code = 'AI_REFUSED'
      throw err
    }
    const content = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    const usage = response.usage || {}
    return {
      content: stripFence(content),
      tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      truncated: response.stop_reason === 'max_tokens',
    }
  }
}

// 模型偶尔把 JSON 包在 ```json 代码块里：只剥外层围栏，内容仍交给严格的 JSON 校验
function stripFence(text) {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text)
  return m ? m[1] : text.trim()
}

module.exports = { createAnthropicTransport, stripFence, DEFAULT_MODEL }
