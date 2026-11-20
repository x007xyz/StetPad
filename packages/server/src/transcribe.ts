import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { experimental_transcribe as transcribe, generateText } from 'ai'

/** One spoken line of a video, in seconds from its start. */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export interface Transcript {
  text: string
  segments: TranscriptSegment[]
  usage?: { inputTokens: number; outputTokens: number }
}

/** Which way a transcription model is reached: OpenAI Whisper, Gemini, or a custom OpenAI-compatible endpoint. */
export type TranscribeProvider = 'openai' | 'google' | 'custom'

/** Largest video each provider takes, in bytes. */
export const TRANSCRIBE_LIMIT: Record<TranscribeProvider, number> = {
  openai: 25 * 1024 * 1024,
  google: 20 * 1024 * 1024,
  custom: 25 * 1024 * 1024,
}

/** The transcription path of a full model id ("openai:whisper-1", "google:…", "custom-x:…"), or null. */
export function transcribeProviderOf(modelId: string): TranscribeProvider | null {
  if (modelId.startsWith('openai:')) return 'openai'
  if (modelId.startsWith('google:')) return 'google'
  if (modelId.startsWith('custom-')) return 'custom'
  return null
}

/**
 * Turns a video's bytes into a transcript. The server uses `transcribeVideo`; tests may inject another.
 * `modelId` is the full id of the chosen model; `apiKey` and `baseURL` (custom endpoints only) come with it.
 */
export type Transcriber = (req: {
  provider: TranscribeProvider
  modelId: string
  apiKey: string
  baseURL?: string
  bytes: Uint8Array
  mime: string
  signal: AbortSignal
}) => Promise<Transcript>

const GEMINI_INSTRUCTION =
  'Transcribe the speech in this video, in the language it is spoken. Reply with only a JSON object of the form ' +
  '{"segments":[{"start":<seconds from the start>,"end":<seconds>,"text":"<the words>"}]}. ' +
  'Keep each segment to one short phrase or sentence. Do not add any other text.'

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** `HH:MM:SS.mmm`, the WebVTT timestamp form. */
export function formatTimestamp(seconds: number): string {
  const ms = Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : 0) * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms % 1000, 3)}`
}

/** WebVTT for the segments. Empty lines are dropped; a cue that ends before it starts gets one second. */
export function buildVtt(segments: TranscriptSegment[]): string {
  const cues: string[] = []
  for (const seg of segments) {
    const text = seg.text.replace(/\s+/g, ' ').replace(/-->/g, '->').trim()
    if (!text) continue
    const start = Number.isFinite(seg.start) && seg.start > 0 ? seg.start : 0
    const end = Number.isFinite(seg.end) && seg.end > start ? seg.end : start + 1
    cues.push(`${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${text}\n`)
  }
  return 'WEBVTT\n\n' + cues.map((c) => c + '\n').join('')
}

/** The JSON object Gemini was asked for. Anything around it is ignored; a reply with no usable segments throws. */
export function parseSegmentsJson(reply: string): TranscriptSegment[] {
  const open = reply.indexOf('{')
  const close = reply.lastIndexOf('}')
  if (open < 0 || close <= open) throw new Error('AI 返回的字幕格式不正确')
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(open, close + 1))
  } catch {
    throw new Error('AI 返回的字幕格式不正确')
  }
  const list = parsed && typeof parsed === 'object' ? (parsed as { segments?: unknown }).segments : undefined
  if (!Array.isArray(list)) throw new Error('AI 返回的字幕格式不正确')
  const out: TranscriptSegment[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const s = item as { start?: unknown; end?: unknown; text?: unknown }
    const start = Number(s.start)
    const end = Number(s.end)
    const text = typeof s.text === 'string' ? s.text.trim() : ''
    if (Number.isFinite(start) && Number.isFinite(end) && text) out.push({ start, end, text })
  }
  if (!out.length) throw new Error('AI 没有返回字幕')
  return out
}

/** The model part of a full id: "google:gemini-3-pro" gives "gemini-3-pro". */
function rawModelId(modelId: string): string {
  const i = modelId.indexOf(':')
  return i < 0 ? modelId : modelId.slice(i + 1)
}

/** One transcription by a custom OpenAI-compatible endpoint: POST {baseURL}/audio/transcriptions, verbose JSON. */
async function transcribeCustom(baseURL: string, apiKey: string, model: string, bytes: Uint8Array, mime: string, signal: AbortSignal): Promise<Transcript> {
  const form = new FormData()
  form.append('file', new Blob([bytes as BlobPart], { type: mime }), 'video')
  form.append('model', model)
  form.append('response_format', 'verbose_json')
  const res = await fetch(`${baseURL}/audio/transcriptions`, {
    method: 'POST',
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    body: form,
    signal,
  })
  if (!res.ok) throw new Error(`转写模型返回 ${res.status}`)
  const json = (await res.json()) as { text?: unknown; duration?: unknown; segments?: unknown }
  const text = typeof json.text === 'string' ? json.text.trim() : ''
  const list = Array.isArray(json.segments) ? (json.segments as { start?: unknown; end?: unknown; text?: unknown }[]) : []
  const segments: TranscriptSegment[] = []
  for (const s of list) {
    const start = Number(s.start)
    const end = Number(s.end)
    const t = typeof s.text === 'string' ? s.text.trim() : ''
    if (Number.isFinite(start) && Number.isFinite(end) && t) segments.push({ start, end, text: t })
  }
  if (segments.length) return { text: text || segments.map((x) => x.text).join(' '), segments }
  if (!text) throw new Error('AI 没有返回字幕')
  return { text, segments: [{ start: 0, end: Number(json.duration) || 0, text }] }
}

/** The default transcriber: the chosen model's own path (Whisper, Gemini, or a custom endpoint). */
export const transcribeVideo: Transcriber = async ({ provider, modelId, apiKey, baseURL, bytes, mime, signal }) => {
  if (provider === 'custom') return transcribeCustom(baseURL ?? '', apiKey, rawModelId(modelId), bytes, mime, signal)
  if (provider === 'openai') {
    const r = await transcribe({
      model: createOpenAI({ apiKey }).transcription(rawModelId(modelId)),
      audio: bytes,
      timestampGranularities: ['segment'],
      abortSignal: signal,
      maxRetries: 1,
    })
    const segments = r.segments
      .map((s) => ({ start: s.startSecond, end: s.endSecond, text: s.text.trim() }))
      .filter((s) => s.text)
    if (segments.length) return { text: r.text.trim(), segments }
    // No timing from the provider: one cue for the whole text.
    const text = r.text.trim()
    if (!text) throw new Error('AI 没有返回字幕')
    return { text, segments: [{ start: 0, end: r.durationInSeconds ?? 0, text }] }
  }
  const r = await generateText({
    model: createGoogleGenerativeAI({ apiKey })(rawModelId(modelId)),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: GEMINI_INSTRUCTION },
          { type: 'file', data: bytes, mediaType: mime },
        ],
      },
    ],
    maxOutputTokens: 16000,
    abortSignal: signal,
  })
  const segments = parseSegmentsJson(r.text)
  return {
    text: segments.map((s) => s.text).join(' '),
    segments,
    usage: { inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 },
  }
}
