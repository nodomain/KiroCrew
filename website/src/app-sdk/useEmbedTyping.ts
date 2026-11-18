import { useCallback, useEffect, useRef } from 'react'

/** How long after the person's last edit the embed reports they stopped typing. */
export const EMBED_TYPING_IDLE_MS = 3000

/**
 * Whether the person is typing in a `ChatEmbed` composer, for a host that shows
 * presence (`ChatEmbed`'s `onTyping`). It carries no text: the host learns only
 * that a draft is being written, never what it says.
 *
 * Debounced to transitions: `onTyping(true)` once when an edit starts a typing
 * spell, `onTyping(false)` once when it ends. A spell ends
 * {@link EMBED_TYPING_IDLE_MS} after the last edit, when the draft becomes empty
 * (a send or a clear), when the slot changes, and on unmount. Only the person's
 * own edits start one: a draft the embed restores (a failed send handed back,
 * a slot's saved draft) does not, because nobody is typing.
 *
 * `noteEdit` is called with the new draft on each edit the person makes.
 */
export function useEmbedTyping(
  onTyping: ((typing: boolean) => void) | undefined,
  draft: string,
  slotKey: string,
): (value: string) => void {
  const onTypingRef = useRef(onTyping)
  onTypingRef.current = onTyping
  const typingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!typingRef.current) return
    typingRef.current = false
    onTypingRef.current?.(false)
  }, [])

  const noteEdit = useCallback((value: string) => {
    if (!onTypingRef.current) return
    if (!value.trim()) {
      stop()
      return
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(stop, EMBED_TYPING_IDLE_MS)
    if (typingRef.current) return
    typingRef.current = true
    onTypingRef.current(true)
  }, [stop])

  // A send or clear empties the draft without an edit by the person.
  useEffect(() => {
    if (!draft.trim()) stop()
  }, [draft, stop])
  // A spell belongs to the slot it was typed in.
  useEffect(() => stop, [slotKey, stop])

  return noteEdit
}
