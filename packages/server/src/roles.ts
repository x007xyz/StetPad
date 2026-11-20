import { recommendedImageModel, listImageEditModels, listImageModels } from './images'
import { builtinKey, listModels, modelPrice, type Capability, type ModelInfo, type ModelScope, type Role } from './models'

/**
 * Model roles: the job a model is chosen for in the settings. Each role has its own list of options, taken from the
 * models the user has enabled and their capabilities, and an automatic choice used while the user has not picked one.
 */

export const ROLES: { key: Role; label: string }[] = [
  { key: 'text', label: '默认模型' },
  { key: 'vision', label: '识图模型' },
  { key: 'image', label: '图片生成模型' },
  { key: 'imageEdit', label: '改图模型' },
  { key: 'transcribe', label: '语音转写模型' },
  { key: 'diagram', label: '图表生成模型' },
]

/** The roles the settings page may set. The text role has its own field, `model`. */
export const SETTABLE_ROLES: Role[] = ['vision', 'image', 'imageEdit', 'transcribe', 'diagram']

export const roleLabel = (role: Role): string => ROLES.find((r) => r.key === role)?.label ?? role

/** The stored setting of a role. Text keeps the existing `model`, image the existing `imageModel`. */
export const roleSetting = (role: Role): string => (role === 'text' ? 'model' : role === 'image' ? 'imageModel' : `role:${role}`)

export interface RoleOption {
  id: string
  label: string
  price?: string
}

export interface RoleState {
  options: RoleOption[]
  /** What the role resolves to now: the saved choice when it is still an option, else the automatic one. */
  effective: string | null
}

/** Saved choices by role. '' or absent means automatic. */
export type SavedRoles = Partial<Record<Role, string>>

const uniq = (list: RoleOption[]): RoleOption[] => {
  const seen = new Set<string>()
  return list.filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)))
}

const pick = (options: RoleOption[], value: string | undefined): string | null => (value && options.some((o) => o.id === value) ? value : null)

/** Options of one role for a user's scope. Image options come from the image model lists and from models flagged for the role. */
export async function roleOptions(role: Role, scope: ModelScope, fetchFn: typeof fetch = fetch): Promise<RoleOption[]> {
  const models = listModels(scope)
  const opt = (m: { id: string; label: string }): RoleOption => {
    const p = modelPrice(m.id, scope)
    return { id: m.id, label: m.label, ...(p ? { price: `${p.currency}${p.input} / ${p.output} 每百万 tokens` } : {}) }
  }
  const withCap = (c: Capability): RoleOption[] => models.filter((m: ModelInfo) => m.caps.includes(c)).map(opt)
  switch (role) {
    case 'text':
    case 'diagram':
      return withCap('text')
    case 'vision':
      return withCap('vision')
    case 'image':
      return uniq([...(await listImageModels(scope, fetchFn)), ...withCap('image')])
    case 'imageEdit':
      return uniq([...(await listImageEditModels(scope, fetchFn)), ...withCap('imageEdit')])
    case 'transcribe': {
      const out: RoleOption[] = []
      if (builtinKey('openai', scope) && !scope.disabledProviders?.has('openai') && !scope.disabledModels?.has('openai:whisper-1')) {
        out.push({ id: 'openai:whisper-1', label: 'OpenAI Whisper' })
      }
      // Gemini takes the video itself, so every enabled Google model can transcribe.
      out.push(...models.filter((m) => m.provider === 'google').map(opt))
      out.push(...withCap('audio'))
      return uniq(out)
    }
  }
}

/** The text role's effective model: the saved one when it is still offered, else the first offered. */
async function textEffective(scope: ModelScope, saved: SavedRoles, fetchFn: typeof fetch): Promise<string | null> {
  const options = await roleOptions('text', scope, fetchFn)
  return pick(options, saved.text) ?? options[0]?.id ?? null
}

/** What a role resolves to with no saved choice (or a stale one). */
async function automatic(role: Role, options: RoleOption[], scope: ModelScope, saved: SavedRoles, fetchFn: typeof fetch): Promise<string | null> {
  switch (role) {
    case 'text':
      return options[0]?.id ?? null
    case 'diagram':
      return textEffective(scope, saved, fetchFn)
    case 'vision': {
      // The user's capability switches decide: the default model when it has 识图, else the first model that has it.
      const text = await textEffective(scope, saved, fetchFn)
      if (text && options.some((o) => o.id === text)) return text
      return options[0]?.id ?? null
    }
    case 'image':
      return recommendedImageModel(options)
    case 'imageEdit':
      return options[0]?.id ?? null
    case 'transcribe':
      return options.find((o) => o.id === 'openai:whisper-1')?.id ?? options[0]?.id ?? null
  }
}

/** Options and the effective choice of one role. */
export async function roleState(role: Role, scope: ModelScope, saved: SavedRoles, fetchFn: typeof fetch = fetch): Promise<RoleState> {
  const options = await roleOptions(role, scope, fetchFn)
  const chosen = pick(options, saved[role])
  return { options, effective: chosen ?? (await automatic(role, options, scope, saved, fetchFn)) }
}
