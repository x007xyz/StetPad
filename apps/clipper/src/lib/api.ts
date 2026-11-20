import type { Block } from '@stetpad/clip'
import { saveProfile } from './storage'
import type { ClipperProfile, DocItem, FolderItem, ModelItem } from './types'

export const DESKTOP_PORTS = [27182, 27183, 27184, 27185, 27186]

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function pingServer(baseUrl: string): Promise<{ service: string; mode: 'local' } | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/clipper/ping`, {
      signal: AbortSignal.timeout(700),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { service?: string; mode?: string }
    if (data.service === 'stetpad' && data.mode === 'local') {
      return { service: 'stetpad', mode: data.mode }
    }
    return null
  } catch {
    return null
  }
}

export async function discoverDesktopUrl(): Promise<string | null> {
  const checks = await Promise.all(
    DESKTOP_PORTS.map(async (port) => {
      const base = `http://127.0.0.1:${port}`
      const ping = await pingServer(base)
      return ping?.mode === 'local' ? base : null
    }),
  )
  return checks.find((u): u is string => u !== null) ?? null
}

/** Ensures the desktop profile tracks the app's current port if it restarted on another candidate port. */
export async function resolveProfile(profile: ClipperProfile): Promise<ClipperProfile> {
  const ok = await pingServer(profile.baseUrl)
  if (ok?.mode === 'local') return profile
  const fresh = await discoverDesktopUrl()
  if (!fresh) return profile
  const updated: ClipperProfile = { ...profile, baseUrl: fresh }
  await saveProfile(updated)
  return updated
}

async function apiJson<T>(profile: ClipperProfile, path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${profile.token}`,
  }
  if (init.body && typeof init.body === 'string') headers['content-type'] = 'application/json'
  const res = await fetch(`${profile.baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  })
  const ct = res.headers.get('content-type') ?? ''
  const isJson = ct.includes('json')
  const body = isJson ? await res.json() : await res.text()
  if (!res.ok) {
    const msg = (isJson && (body as { error?: string }).error) || `请求失败（${res.status}）`
    throw new ApiError(res.status, msg)
  }
  return body as T
}

export async function requestLocalPair(
  baseUrl: string,
  deviceName: string,
): Promise<{ token: string; mode: 'local'; user: { id: string; email: string } }> {
  const res = await fetch(`${baseUrl}/api/clipper/pair/request-local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceName }),
  })
  const body = (await res.json()) as { token?: string; mode?: 'local'; user?: { id: string; email: string }; error?: string }
  if (!res.ok || !body.token) throw new ApiError(res.status, body.error ?? '桌面端未授权连接')
  return { token: body.token, mode: 'local', user: body.user ?? { id: 'local', email: 'local@device' } }
}

export async function startPair(
  baseUrl: string,
  challenge: string,
  deviceName: string,
): Promise<{ code: string; mode: 'local' }> {
  const res = await fetch(`${baseUrl}/api/clipper/pair/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge, deviceName }),
  })
  const body = (await res.json()) as { code?: string; mode?: 'local'; error?: string }
  if (!res.ok || !body.code || !body.mode) throw new ApiError(res.status, body.error ?? '发起配对失败')
  return { code: body.code, mode: body.mode }
}

export async function exchangePair(
  baseUrl: string,
  code: string,
  verifier: string,
): Promise<
  | { status: 'pending' }
  | { status: 'approved'; token: string; mode: 'local'; user: { id: string; email: string } }
> {
  const res = await fetch(`${baseUrl}/api/clipper/pair/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier }),
  })
  const body = (await res.json()) as {
    status?: string
    token?: string
    mode?: 'local'
    user?: { id: string; email: string }
    error?: string
  }
  if (res.status === 202 || body.status === 'pending') return { status: 'pending' }
  if (!res.ok || body.status !== 'approved' || !body.token || !body.mode) {
    throw new ApiError(res.status, body.error ?? '配对失败')
  }
  return { status: 'approved', token: body.token, mode: body.mode, user: body.user ?? { id: '', email: '' } }
}

export const getMe = (profile: ClipperProfile) =>
  apiJson<{ user: { id: string; email: string }; mode: 'local' }>(profile, '/api/me')

export const listFolders = (profile: ClipperProfile) => apiJson<FolderItem[]>(profile, '/api/folders')

export const listDocs = (profile: ClipperProfile) => apiJson<DocItem[]>(profile, '/api/docs')

export const getModels = (profile: ClipperProfile) =>
  apiJson<{ models: ModelItem[]; default: string | null }>(profile, '/api/models')

export const createClipDoc = (
  profile: ClipperProfile,
  payload: { title: string; blocks: Block[]; folderId?: string },
) =>
  apiJson<{ id: string; title: string; folder_id: string | null }>(profile, '/api/import/create', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const createEmptyDoc = (
  profile: ClipperProfile,
  payload: { title: string; folderId?: string },
) =>
  apiJson<{ id: string; title: string; folder_id?: string | null }>(profile, '/api/docs', {
    method: 'POST',
    body: JSON.stringify({ ...payload, empty: true }),
  })

export const appendClipDoc = (
  profile: ClipperProfile,
  docId: string,
  payload: { blocks: Block[]; asSuggestion: boolean; author: string; reason: string },
) =>
  apiJson<{ ok: true; docId: string; changeId: string | null; blockCount: number }>(
    profile,
    `/api/docs/${encodeURIComponent(docId)}/clip`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )

export async function uploadDocAsset(
  profile: ClipperProfile,
  docId: string,
  bytes: Uint8Array,
  mime: string,
  name: string,
): Promise<{ url: string; id: string }> {
  const res = await fetch(`${profile.baseUrl}/api/docs/${encodeURIComponent(docId)}/assets`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${profile.token}`,
      'content-type': mime,
      'x-file-name': encodeURIComponent(name),
    },
    body: bytes as unknown as BodyInit,
  })
  const body = (await res.json()) as { url?: string; id?: string; error?: string }
  if (!res.ok || !body.url || !body.id) throw new ApiError(res.status, body.error ?? '上传图片失败')
  return { url: body.url, id: body.id }
}

export const startDocAiRun = (
  profile: ClipperProfile,
  docId: string,
  payload: { instruction: string; modelId?: string; context: unknown[] },
) =>
  apiJson<{ runId: string; chatId: string }>(profile, `/api/docs/${encodeURIComponent(docId)}/runs`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const startFolderAiRun = (
  profile: ClipperProfile,
  folderId: string,
  payload: { instruction: string; modelId?: string; context: unknown[] },
) =>
  apiJson<{ runId: string }>(profile, `/api/folders/${encodeURIComponent(folderId)}/runs`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
