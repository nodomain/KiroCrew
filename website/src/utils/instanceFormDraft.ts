/**
 * Session-scoped stash for the Add-remote-crew form's typed values.
 *
 * ## Why this exists
 *
 * `ErrorNotice`'s `askAgent` hand-off is opt-IN, and the direction of that
 * default is a safety property: the hand-off navigates to the chat, unmounting
 * whatever rendered the banner, so any value living in that subtree's state is
 * destroyed — and a save-failure banner is showing precisely because the value
 * was NOT persisted. The Add form is the worst case, holding up to nine fields
 * (name, transport, ssh_host / ssm_target, AWS profile and region, run-as, port,
 * TTL, remote bin) that a first-time user has just typed by hand.
 *
 * Rather than accept that loss or forgo the button on the one screen where a
 * failure is least self-explanatory, the form writes its values here in the
 * hand-off's pre-navigation window and reads them back on its next mount. That
 * turns the objection into a solved problem for this call site instead of
 * routing around it.
 *
 * ## Shape of the guarantee
 *
 * `sessionStorage`, so the draft survives the navigation AND a full reload (the
 * `hard` hand-off path) but never outlives the tab — a stale remote-crew draft
 * resurrected days later would be worse than none.
 *
 * Reading is deliberately **non-destructive**. A consume-on-read would be tidier
 * but is unsafe here: React's StrictMode mounts a component, unmounts it, and
 * mounts it again in development, so the first mount would eat the draft and the
 * second — the one the user actually sees — would find nothing. Bounding the
 * entry instead falls to {@link DRAFT_TTL_MS} and to
 * {@link clearInstanceFormDraft} on a successful save.
 */

import { safeSetSessionItem } from './safeStorage'

const KEY = 'kirocrew_instance_form_draft'

/**
 * Draft TTL. Long enough to diagnose an error with the agent and come back,
 * short enough that a forgotten tab does not re-seed a form hours later. Matches
 * the intent of the error hand-off's own TTL rather than its exact value: this
 * one spans a human conversation, not a page transition.
 */
export const DRAFT_TTL_MS = 30 * 60_000

/**
 * The stashed payload.
 *
 * `values` is deliberately typed as an opaque record rather than importing
 * `InstanceFormValues`: this module is imported by the form AND by the utils
 * layer, and depending on a page's types would invert that direction. The form
 * owns the shape; this owns the durability.
 */
interface StoredDraft {
  values: Record<string, unknown>
  ts: number
}

/** Persist the form's current values. Returns false when storage refused. */
export function stashInstanceFormDraft(values: Record<string, unknown>): boolean {
  return safeSetSessionItem(KEY, JSON.stringify({ values, ts: Date.now() } satisfies StoredDraft))
}

/**
 * Read the stashed draft without removing it.
 *
 * Returns null when absent, unreadable, or past {@link DRAFT_TTL_MS}. An expired
 * or malformed entry is deleted on the way out, since nothing will ever restore
 * it and leaving it costs a parse on every mount.
 */
export function peekInstanceFormDraft(): Record<string, unknown> | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  const values = decodeDraft(raw)
  if (!values) clearInstanceFormDraft()
  return values
}

function decodeDraft(raw: string): Record<string, unknown> | null {
  try {
    const decoded: unknown = JSON.parse(raw)
    if (!decoded || typeof decoded !== 'object') return null
    const { values, ts } = decoded as Partial<StoredDraft>
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null
    if (typeof ts !== 'number' || Date.now() - ts > DRAFT_TTL_MS) return null
    return values as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Drop the stash without reading it — for a form that succeeded.
 *
 * Without this a successful add would leave the pre-hand-off draft in place and
 * the NEXT add would open pre-filled with the crew the user already created.
 */
export function clearInstanceFormDraft(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* nothing to clean up if storage is unavailable */
  }
}
