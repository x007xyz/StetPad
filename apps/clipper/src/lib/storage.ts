import { browser } from 'wxt/browser'
import type { ClipperPrefs, ClipperProfile, PendingPair } from './types'

const PROFILES_KEY = 'stetpad.profiles'
const PREFS_KEY = 'stetpad.prefs'
const PENDING_PAIR_KEY = 'stetpad.pendingPair'

const DEFAULT_PREFS: ClipperPrefs = {
  activeProfile: 'local',
  workflow: 'create',
  folderId: '',
  docId: '',
  localizeImages: true,
  asSuggestion: true,
  aiScope: 'doc',
  modelId: '',
}

/** Only the desktop profile is supported; older hosted-web profiles are ignored. */
export async function getProfiles(): Promise<Partial<Record<'local', ClipperProfile>>> {
  const raw = await browser.storage.local.get(PROFILES_KEY)
  const stored = (raw[PROFILES_KEY] as Partial<Record<'local', ClipperProfile>> | undefined) ?? {}
  return stored.local ? { local: stored.local } : {}
}

export async function saveProfile(profile: ClipperProfile): Promise<void> {
  const cur = await getProfiles()
  cur[profile.id] = profile
  await browser.storage.local.set({ [PROFILES_KEY]: cur })
}

export async function removeProfile(id: 'local'): Promise<void> {
  const cur = await getProfiles()
  delete cur[id]
  await browser.storage.local.set({ [PROFILES_KEY]: cur })
}

export async function getPrefs(): Promise<ClipperPrefs> {
  const raw = await browser.storage.local.get(PREFS_KEY)
  return { ...DEFAULT_PREFS, ...((raw[PREFS_KEY] as Partial<ClipperPrefs> | undefined) ?? {}) }
}

export async function savePrefs(patch: Partial<ClipperPrefs>): Promise<ClipperPrefs> {
  const next = { ...(await getPrefs()), ...patch }
  await browser.storage.local.set({ [PREFS_KEY]: next })
  return next
}

export async function getPendingPair(): Promise<PendingPair | null> {
  const raw = await browser.storage.local.get(PENDING_PAIR_KEY)
  const p = (raw[PENDING_PAIR_KEY] as PendingPair | undefined) ?? null
  if (!p) return null
  if (Date.now() - p.startedAt > 5 * 60_000) {
    await setPendingPair(null)
    return null
  }
  return p
}

export async function setPendingPair(pair: PendingPair | null): Promise<void> {
  if (pair) await browser.storage.local.set({ [PENDING_PAIR_KEY]: pair })
  else await browser.storage.local.remove(PENDING_PAIR_KEY)
}
