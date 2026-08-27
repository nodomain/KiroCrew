import { AGENT } from './constants'
import type { Scope, SlotData } from './types'

// This app's own backend (mounted by the built-in at gateway startup). It does
// the clone / discover / render work server-side so the agent never runs a tool.
const DC = '/api/apps/design-critique'

// These hit the dashboard's own chat endpoints (NOT an app-scoped reverse proxy),
// so they are plain same-origin fetches — the same convention file-explorer's
// api.ts uses. An empty body (e.g. 204 on DELETE) is treated as success.
async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(body || `HTTP ${r.status}`)
  }
  if (r.status === 204 || r.status === 205) return undefined as T
  const text = await r.text()
  if (text.trim() === '') return undefined as T
  return JSON.parse(text) as T
}

const postJson = <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> =>
  jsonFetch<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
    signal,
  })

export const designCritiqueApi = {
  // Open a throwaway worker slot. memory_mode 'temporary' keeps it out of memory
  // snapshots; mode 'design-critique' keeps it OUT of the chat sidebar (the chat
  // list only renders '' and 'orchestrator').
  openSlot: () =>
    postJson<{ key: string }>('/api/chat/slots', {
      name: 'dc-' + Date.now(), agent: AGENT, memory_mode: 'temporary', mode: 'design-critique',
    }),

  getSlot: (slotKey: string) =>
    jsonFetch<SlotData>('/api/chat/slots/' + encodeURIComponent(slotKey)),

  // Fire a message at a slot. The response body is not JSON we care about, so a
  // parse error is swallowed — only a real HTTP/network error propagates.
  send: (slotKey: string, message: string): Promise<void> =>
    jsonFetch<void>('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // memory_mode AND mode must be repeated here, not only at slot creation.
      // POST /api/chat auto-creates a missing slot, and with neither in the body
      // it falls back to the persistent default with surface '' — so if the
      // gateway restarts mid-run (the slot is in memory, not on disk) the next
      // send would silently recreate this critique slot with memory reads and
      // writes ENABLED and visible in the chat sidebar (whose allowlist admits
      // surface ''). Passing them is also safe when the slot exists:
      // get_or_create_slot only raises on a memory_mode mismatch and ignores
      // mode for existing slots, and both match what openSlot() asked for.
      body: JSON.stringify({
        message, slot: slotKey, agent: AGENT, memory_mode: 'temporary', mode: 'design-critique',
      }),
    }).catch((e: unknown) => {
      if (e instanceof SyntaxError) return
      throw e
    }),

  deleteSlot: (slotKey: string): Promise<void> =>
    jsonFetch<void>('/api/chat/slots/' + encodeURIComponent(slotKey), { method: 'DELETE' }).catch(() => {}),

  uploadFiles: async (files: File[]): Promise<{ paths: string[] }> => {
    const fd = new FormData()
    files.forEach(f => fd.append('file', f))
    const up = await fetch('/api/upload/file', { method: 'POST', body: fd, credentials: 'same-origin' })
    if (!up.ok) throw new Error('upload failed (' + up.status + ')')
    return up.json()
  },

  // STEP 1 — the backend clones (if needed), lists candidate screens, and probes
  // which ones actually render. Returns a Scope plus a `handle` that render()
  // reuses so the clone is not fetched twice.
  discover: (kind: string, value: string, signal?: AbortSignal): Promise<Scope & { handle?: string }> =>
    postJson<Scope & { handle?: string }>(DC + '/discover', { kind, value }, signal),

  // STEP 2 — the backend renders the picked screens to PNGs and returns their
  // absolute paths (plus any it could not render), ready for the tool-free prompt.
  render: (body: {
    kind: string
    value: string
    handle: string
    picks: Array<{ id: string; label: string; ref?: string }>
  }, signal?: AbortSignal): Promise<{ screens: Array<{ step: number; label: string; path: string }>; couldNotSee: string[] }> =>
    postJson(DC + '/render', body, signal),

  // The critique method text, inlined into the prompt so the agent does not have
  // to read it with a tool.
  method: (): Promise<{ checklist: string }> => jsonFetch(DC + '/method'),
}

export const fileUrl = (p: string): string => '/api/file-raw?path=' + encodeURIComponent(p)
