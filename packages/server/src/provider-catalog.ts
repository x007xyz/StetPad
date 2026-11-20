/**
 * Ready-made provider presets for the "add provider" picker: pick a service,
 * paste a key, choose models. Endpoints and key pages follow the opencodex
 * provider registry (github.com/lidge-jun/opencodex, src/providers/registry).
 *
 * An entry with `builtin` maps onto a built-in provider of models.ts (its key
 * and models are configured on that provider). Every other entry becomes a
 * custom OpenAI-compatible provider whose `preset` remembers where it came from.
 * Suggested models are only a starting point: the picker reads the live list
 * from the provider's /models endpoint once a key is entered.
 */
export type CatalogRegion = 'cn' | 'global' | 'aggregator' | 'local'

export interface CatalogEntry {
  id: string
  name: string
  region: CatalogRegion
  /** Built-in provider id (models.ts) this entry configures, instead of adding a custom one. */
  builtin?: string
  baseURL: string
  /** Where the user creates or copies an API key. */
  keyUrl?: string
  /** The service accepts requests without a key (local runtimes). */
  keyOptional?: boolean
  /** Has a free tier (a key may still be required). */
  freeTier?: boolean
  /** Symbol for prices: "$" or "¥". */
  currency: string
  /** One line shown under the name. */
  note: string
  /** Suggested models; the first is the suggested default. */
  models: { id: string; label?: string }[]
}

const m = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }))

export const CATALOG: CatalogEntry[] = [
  // --- 国内
  { id: 'deepseek', name: 'DeepSeek', region: 'cn', builtin: 'deepseek', baseURL: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys', currency: '¥', note: 'DeepSeek 官方 API，可查询余额', models: m('deepseek-flash', 'deepseek-v4-pro') },
  { id: 'moonshot', name: 'Moonshot · Kimi', region: 'cn', baseURL: 'https://api.moonshot.cn/v1', keyUrl: 'https://platform.moonshot.cn/console/api-keys', currency: '¥', note: 'Kimi 开放平台（国内站），可查询余额', models: m('kimi-k3.1-pro', 'kimi-k3.1') },
  { id: 'zhipu', name: '智谱 BigModel', region: 'cn', baseURL: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://bigmodel.cn/console/usercenter/apikeys', currency: '¥', note: 'GLM 系列，按量计费', models: m('glm-5.3', 'glm-5.3-flash', 'glm-4.6') },
  { id: 'zhipu-coding', name: '智谱 Coding Plan', region: 'cn', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', keyUrl: 'https://bigmodel.cn/console/usercenter/apikeys', currency: '¥', note: 'GLM 包月套餐专用端点', models: m('glm-5.3', 'glm-5.3-flash') },
  { id: 'qwen', name: '阿里云百炼 · 通义千问', region: 'cn', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key', currency: '¥', note: 'Qwen 系列，OpenAI 兼容模式', models: m('qwen3.7-max', 'qwen3.7-plus', 'qwen3.7-flash') },
  { id: 'volcengine', name: '火山方舟 · 豆包', region: 'cn', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey', currency: '¥', note: '豆包及方舟托管的第三方模型', models: m('doubao-seed-2-1-pro-260628') },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', region: 'cn', baseURL: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak', freeTier: true, currency: '¥', note: '开源模型托管，部分模型免费，可查询余额', models: m('deepseek-ai/DeepSeek-V4', 'Qwen/Qwen3-Coder-480B-A35B-Instruct') },
  { id: 'minimax', name: 'MiniMax', region: 'cn', baseURL: 'https://api.minimaxi.com/v1', keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', currency: '¥', note: 'MiniMax 开放平台（国内站）', models: m('MiniMax-M3') },
  { id: 'stepfun', name: '阶跃星辰 StepFun', region: 'cn', baseURL: 'https://api.stepfun.com/v1', keyUrl: 'https://platform.stepfun.com/interface-key', currency: '¥', note: 'Step 系列模型', models: m('step-5-preview') },
  { id: 'xiaomi-mimo', name: '小米 MiMo', region: 'cn', baseURL: 'https://api.xiaomimimo.com/v1', keyUrl: 'https://platform.xiaomimimo.com', currency: '¥', note: 'MiMo 开放平台', models: m('mimo-v2.6-flash', 'mimo-v2.6-pro') },
  { id: 'tencent-hunyuan', name: '腾讯混元', region: 'cn', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key', currency: '¥', note: '混元大模型，OpenAI 兼容接口', models: m('hunyuan-turbos-latest') },
  { id: 'kimi-coding', name: 'Kimi Coding 套餐', region: 'cn', baseURL: 'https://api.kimi.com/coding/v1', keyUrl: 'https://www.kimi.com/coding', currency: '¥', note: 'Kimi 会员编程套餐专用端点', models: m('kimi-for-coding') },
  { id: 'qianfan', name: '百度千帆 · 文心', region: 'cn', baseURL: 'https://qianfan.baidubce.com/v2', keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list', currency: '¥', note: '文心 ERNIE 及千帆托管的第三方模型', models: m('ernie-5.0', 'ernie-4.5-turbo-128k') },
  { id: 'spark', name: '讯飞星火', region: 'cn', baseURL: 'https://spark-api-open.xf-yun.com/v1', keyUrl: 'https://console.xfyun.cn/services/bm4', currency: '¥', note: '星火大模型 HTTP 接口，密钥填 APIPassword', models: m('4.0Ultra', 'generalv3.5') },
  { id: 'tencent-lkeap', name: '腾讯云 · DeepSeek', region: 'cn', baseURL: 'https://api.lkeap.cloud.tencent.com/v1', keyUrl: 'https://console.cloud.tencent.com/lkeap/api', currency: '¥', note: '腾讯云知识引擎托管的 DeepSeek 系列', models: m('deepseek-v3.1', 'deepseek-r1') },
  { id: 'baichuan', name: '百川智能', region: 'cn', baseURL: 'https://api.baichuan-ai.com/v1', keyUrl: 'https://platform.baichuan-ai.com/console/apikey', currency: '¥', note: 'Baichuan 系列模型', models: m('Baichuan4-Turbo') },
  { id: 'lingyi', name: '零一万物', region: 'cn', baseURL: 'https://api.lingyiwanwu.com/v1', keyUrl: 'https://platform.lingyiwanwu.com/apikeys', currency: '¥', note: 'Yi 系列模型', models: m('yi-lightning') },
  { id: 'sensenova', name: '商汤日日新', region: 'cn', baseURL: 'https://api.sensenova.cn/compatible-mode/v1', keyUrl: 'https://console.sensecore.cn/aistudio/management/api-key', currency: '¥', note: 'SenseNova 系列，OpenAI 兼容模式', models: m('SenseNova-V6-5-Pro') },
  { id: 'longcat', name: '美团 LongCat', region: 'cn', baseURL: 'https://api.longcat.chat/openai/v1', keyUrl: 'https://longcat.chat/platform/api_keys', freeTier: true, currency: '¥', note: 'LongCat 系列，每日有免费额度', models: m('LongCat-Flash-Chat', 'LongCat-Flash-Thinking') },
  { id: 'modelscope', name: '魔搭 ModelScope', region: 'cn', baseURL: 'https://api-inference.modelscope.cn/v1', keyUrl: 'https://modelscope.cn/my/myaccesstoken', freeTier: true, currency: '¥', note: '开源模型推理，每日有免费调用额度', models: m('Qwen/Qwen3-Coder-480B-A35B-Instruct', 'deepseek-ai/DeepSeek-V3.1') },
  { id: 'infini', name: '无问芯穹', region: 'cn', baseURL: 'https://cloud.infini-ai.com/maas/v1', keyUrl: 'https://cloud.infini-ai.com/iam/secret/key', currency: '¥', note: '开源模型托管', models: m('deepseek-v3.1') },
  { id: 'ppio', name: 'PPIO 派欧云', region: 'cn', baseURL: 'https://api.ppinfra.com/v3/openai', keyUrl: 'https://ppio.com/settings/key-management', currency: '¥', note: '开源模型托管，价格低', models: m('deepseek/deepseek-v3.1') },
  { id: 'qiniu', name: '七牛云 AI', region: 'cn', baseURL: 'https://api.qnaigc.com/v1', keyUrl: 'https://portal.qiniu.com/ai-inference/api-key', currency: '¥', note: '七牛云大模型推理', models: m('deepseek-v3.1') },

  // --- 海外
  { id: 'anthropic', name: 'Anthropic', region: 'global', builtin: 'anthropic', baseURL: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys', currency: '$', note: 'Claude 官方 API', models: m('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5') },
  { id: 'openai', name: 'OpenAI', region: 'global', builtin: 'openai', baseURL: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', currency: '$', note: 'GPT 官方 API', models: m('gpt-5.6-luna') },
  { id: 'google', name: 'Google Gemini', region: 'global', builtin: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta', keyUrl: 'https://aistudio.google.com/apikey', freeTier: true, currency: '$', note: 'Gemini 官方 API，有免费额度', models: m('gemini-3-pro') },
  { id: 'moonshot-intl', name: 'Moonshot · Kimi（国际站）', region: 'global', baseURL: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys', currency: '$', note: 'Kimi 开放平台国际站', models: m('kimi-k3.1-pro', 'kimi-k3.1') },
  { id: 'zai', name: 'Z.ai（智谱国际站）', region: 'global', baseURL: 'https://api.z.ai/api/paas/v4', keyUrl: 'https://z.ai/manage-apikey/apikey-list', currency: '$', note: 'GLM 系列国际站', models: m('glm-5.3', 'glm-5.3-flash') },
  { id: 'minimax-intl', name: 'MiniMax（国际站）', region: 'global', baseURL: 'https://api.minimax.io/v1', keyUrl: 'https://platform.minimax.io', currency: '$', note: 'MiniMax 国际站', models: m('MiniMax-M3') },
  { id: 'xai', name: 'xAI Grok', region: 'global', baseURL: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai', currency: '$', note: 'Grok 官方 API', models: m('grok-4.5') },
  { id: 'mistral', name: 'Mistral', region: 'global', baseURL: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', freeTier: true, currency: '$', note: 'Mistral 官方 API，有免费额度', models: m('mistral-large-latest', 'mistral-medium-latest') },
  { id: 'groq', name: 'Groq', region: 'global', baseURL: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', freeTier: true, currency: '$', note: '高速推理，有免费额度', models: m('openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct') },
  { id: 'cerebras', name: 'Cerebras', region: 'global', baseURL: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai', freeTier: true, currency: '$', note: '高速推理，有免费额度', models: m('gpt-oss-120b') },
  { id: 'nvidia', name: 'NVIDIA NIM', region: 'global', baseURL: 'https://integrate.api.nvidia.com/v1', keyUrl: 'https://build.nvidia.com/settings/api-keys', freeTier: true, currency: '$', note: '免费使用，需要在 build.nvidia.com 申请密钥', models: m('deepseek-ai/deepseek-v4', 'moonshotai/kimi-k2-instruct') },
  { id: 'together', name: 'Together AI', region: 'global', baseURL: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys', currency: '$', note: '开源模型托管', models: m('deepseek-ai/DeepSeek-V4') },
  { id: 'fireworks', name: 'Fireworks AI', region: 'global', baseURL: 'https://api.fireworks.ai/inference/v1', keyUrl: 'https://fireworks.ai/account/api-keys', currency: '$', note: '开源模型托管', models: m('accounts/fireworks/models/deepseek-v4') },
  { id: 'deepinfra', name: 'DeepInfra', region: 'global', baseURL: 'https://api.deepinfra.com/v1/openai', keyUrl: 'https://deepinfra.com/dash/api_keys', currency: '$', note: '开源模型托管，价格低', models: m('deepseek-ai/DeepSeek-V4') },
  { id: 'perplexity', name: 'Perplexity', region: 'global', baseURL: 'https://api.perplexity.ai', keyUrl: 'https://www.perplexity.ai/account/api/keys', currency: '$', note: 'Sonar 系列，自带联网搜索', models: m('sonar-pro', 'sonar') },
  { id: 'cohere', name: 'Cohere', region: 'global', baseURL: 'https://api.cohere.ai/compatibility/v1', keyUrl: 'https://dashboard.cohere.com/api-keys', freeTier: true, currency: '$', note: 'Command 系列，OpenAI 兼容接口', models: m('command-a-03-2025') },
  { id: 'github-models', name: 'GitHub Models', region: 'global', baseURL: 'https://models.github.ai/inference', keyUrl: 'https://github.com/settings/personal-access-tokens', freeTier: true, currency: '$', note: '用 GitHub 令牌免费试用，令牌需 models 读取权限', models: m('openai/gpt-4.1', 'deepseek/DeepSeek-V3-0324') },
  { id: 'huggingface', name: 'Hugging Face', region: 'global', baseURL: 'https://router.huggingface.co/v1', keyUrl: 'https://huggingface.co/settings/tokens', freeTier: true, currency: '$', note: 'Inference Providers 统一路由，有免费额度', models: m('deepseek-ai/DeepSeek-V3.1') },
  { id: 'sambanova', name: 'SambaNova', region: 'global', baseURL: 'https://api.sambanova.ai/v1', keyUrl: 'https://cloud.sambanova.ai/apis', freeTier: true, currency: '$', note: '高速推理，有免费额度', models: m('DeepSeek-V3.1') },
  { id: 'novita', name: 'Novita AI', region: 'global', baseURL: 'https://api.novita.ai/openai/v1', keyUrl: 'https://novita.ai/settings/key-management', currency: '$', note: '开源模型托管，价格低', models: m('deepseek/deepseek-v3.1') },
  { id: 'nebius', name: 'Nebius Token Factory', region: 'global', baseURL: 'https://api.tokenfactory.nebius.com/v1', keyUrl: 'https://tokenfactory.nebius.com', currency: '$', note: '开源模型托管', models: m('deepseek-ai/DeepSeek-V3.1') },
  { id: 'hyperbolic', name: 'Hyperbolic', region: 'global', baseURL: 'https://api.hyperbolic.xyz/v1', keyUrl: 'https://app.hyperbolic.ai', currency: '$', note: '开源模型托管', models: m('deepseek-ai/DeepSeek-V3') },
  { id: 'chutes', name: 'Chutes', region: 'global', baseURL: 'https://llm.chutes.ai/v1', keyUrl: 'https://chutes.ai/auth/start', currency: '$', note: '去中心化推理，价格低', models: m('deepseek-ai/DeepSeek-V3.1') },
  { id: 'featherless', name: 'Featherless AI', region: 'global', baseURL: 'https://api.featherless.ai/v1', keyUrl: 'https://featherless.ai/account/api-keys', currency: '$', note: '包月使用大量开源模型', models: m('deepseek-ai/DeepSeek-V3-0324') },
  { id: 'baseten', name: 'Baseten', region: 'global', baseURL: 'https://inference.baseten.co/v1', keyUrl: 'https://app.baseten.co/settings/api_keys', currency: '$', note: 'Model APIs 托管', models: m('deepseek-ai/DeepSeek-V3.1') },
  { id: 'venice', name: 'Venice', region: 'global', baseURL: 'https://api.venice.ai/api/v1', keyUrl: 'https://venice.ai/settings/api', currency: '$', note: '注重隐私的推理服务', models: m('venice-uncensored') },
  { id: 'scaleway', name: 'Scaleway', region: 'global', baseURL: 'https://api.scaleway.ai/v1', keyUrl: 'https://console.scaleway.com/generative-api', freeTier: true, currency: '$', note: '欧洲托管，有免费额度', models: m('gpt-oss-120b') },
  { id: 'digitalocean', name: 'DigitalOcean', region: 'global', baseURL: 'https://inference.do-ai.run/v1', keyUrl: 'https://cloud.digitalocean.com/model-studio/manage-keys', currency: '$', note: 'Serverless Inference', models: m('openai-gpt-oss-120b') },

  // --- 聚合平台
  { id: 'openrouter', name: 'OpenRouter', region: 'aggregator', builtin: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', freeTier: true, currency: '$', note: '一个密钥使用几百个模型，可查询余额', models: m('anthropic/claude-sonnet-5') },
  { id: 'opencode-go', name: 'OpenCode Go', region: 'aggregator', baseURL: 'https://opencode.ai/zen/go/v1', keyUrl: 'https://opencode.ai/auth', currency: '$', note: '包月订阅，GLM / DeepSeek / Kimi / Qwen 等', models: m('deepseek-v4.1-flash', 'kimi-k2.7-code', 'glm-5.3') },
  { id: 'opencode-zen', name: 'OpenCode Zen', region: 'aggregator', baseURL: 'https://opencode.ai/zen/v1', keyUrl: 'https://opencode.ai/auth', freeTier: true, currency: '$', note: '按量计费，部分模型免费', models: m('kimi-k2.7-code') },
  { id: 'ollama-cloud', name: 'Ollama Cloud', region: 'aggregator', baseURL: 'https://ollama.com/v1', keyUrl: 'https://ollama.com/settings/keys', freeTier: true, currency: '$', note: 'Ollama 托管的开源大模型，有免费额度', models: m('glm-5.3', 'kimi-k2.6', 'gpt-oss:120b') },
  { id: 'vercel', name: 'Vercel AI Gateway', region: 'aggregator', baseURL: 'https://ai-gateway.vercel.sh/v1', keyUrl: 'https://vercel.com/dashboard/ai-gateway/api-keys', currency: '$', note: '统一网关，按量计费', models: m('anthropic/claude-sonnet-5') },
  { id: 'zenmux', name: 'ZenMux', region: 'aggregator', baseURL: 'https://zenmux.ai/api/v1', keyUrl: 'https://zenmux.ai', currency: '$', note: '统一网关，覆盖主流商业模型', models: m('anthropic/claude-sonnet-5') },
  { id: 'requesty', name: 'Requesty', region: 'aggregator', baseURL: 'https://router.requesty.ai/v1', keyUrl: 'https://app.requesty.ai/api-keys', currency: '$', note: '统一路由，按量计费', models: m('anthropic/claude-sonnet-5') },
  { id: 'aihubmix', name: 'AiHubMix', region: 'aggregator', baseURL: 'https://aihubmix.com/v1', keyUrl: 'https://aihubmix.com/token', currency: '$', note: '国内可直连的多模型网关', models: m('claude-sonnet-5', 'gpt-5.6-luna') },
  { id: '302ai', name: '302.AI', region: 'aggregator', baseURL: 'https://api.302.ai/v1', keyUrl: 'https://dash.302.ai/apis/list', currency: '$', note: '按量付费的多模型平台', models: m('claude-sonnet-5') },
  { id: 'nanogpt', name: 'NanoGPT', region: 'aggregator', baseURL: 'https://nano-gpt.com/api/v1', keyUrl: 'https://nano-gpt.com/api', currency: '$', note: '按次付费，也有订阅', models: m('deepseek-ai/DeepSeek-V3.1') },

  // --- 本机
  { id: 'ollama', name: 'Ollama（本机）', region: 'local', baseURL: 'http://localhost:11434/v1', keyOptional: true, currency: '', note: '本机运行的 Ollama，不需要密钥', models: [] },
  { id: 'lmstudio', name: 'LM Studio（本机）', region: 'local', baseURL: 'http://localhost:1234/v1', keyOptional: true, currency: '', note: '本机运行的 LM Studio 服务', models: [] },
  { id: 'vllm', name: 'vLLM（本机）', region: 'local', baseURL: 'http://localhost:8000/v1', keyOptional: true, currency: '', note: '本机或内网的 vLLM 服务', models: [] },
  { id: 'litellm', name: 'LiteLLM 代理', region: 'local', baseURL: 'http://localhost:4000/v1', keyOptional: true, currency: '$', note: '自建的 LiteLLM 代理', models: [] },
  { id: 'jan', name: 'Jan（本机）', region: 'local', baseURL: 'http://localhost:1337/v1', keyOptional: true, currency: '', note: '本机运行的 Jan 服务', models: [] },
  { id: 'llamacpp', name: 'llama.cpp（本机）', region: 'local', baseURL: 'http://localhost:8080/v1', keyOptional: true, currency: '', note: 'llama-server 提供的 OpenAI 兼容接口', models: [] },
]

/** The full provider catalog, including the entries for services on this machine. */
export function catalogFor(): CatalogEntry[] {
  return CATALOG
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id)
}
