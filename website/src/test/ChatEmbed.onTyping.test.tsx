/**
 * ChatEmbed's `onTyping`: a host learns when the person starts and stops typing,
 * debounced to transitions and never with the draft's text.
 *
 * Pinned here:
 * - one `true` for a spell of edits, one `false` after the idle window;
 * - no argument but the boolean, so no text reaches the host;
 * - a send that empties the draft ends the spell at once;
 * - a slot switch and an unmount end it;
 * - a draft the embed sets on its own (no edit by the person) starts nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { resetEmbedRecoveryForTests } from '../app-sdk/embedSendRecovery'
import { EMBED_TYPING_IDLE_MS } from '../app-sdk/useEmbedTyping'

const mockGet = vi.fn()
const mockPost = vi.fn()

vi.mock('../app-sdk/index', () => ({
  useAppApi: () => ({ get: mockGet, post: mockPost }),
  useAppInfo: () => ({ name: 'test-app', version: '0', permissions: { api: ['/api/chat'], events: [] } }),
}))

const { mockSendTurn } = vi.hoisted(() => ({ mockSendTurn: vi.fn() }))
vi.mock('../chat-core/transport/sendTurn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat-core/transport/sendTurn')>()
  return { ...actual, sendTurn: mockSendTurn }
})

vi.mock('../app-sdk/ChatMessageList', () => ({
  default: React.forwardRef(function MockList(_props: unknown, ref: React.Ref<unknown>) {
    React.useImperativeHandle(ref, () => ({ scrollToBottom: vi.fn() }), [])
    return <ol data-testid="rows" />
  }),
}))

import ChatEmbed from '../app-sdk/ChatEmbed'

let queryClient: QueryClient

function embed(slotKey: string, onTyping: (typing: boolean) => void) {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatEmbed slotKey={slotKey} onTyping={onTyping} />
    </QueryClientProvider>
  )
}

const composer = () => screen.getByLabelText('Chat message') as HTMLTextAreaElement

async function type(text: string) {
  await act(async () => { fireEvent.change(composer(), { target: { value: text } }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSendTurn.mockReset()
  resetEmbedRecoveryForTests()
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  Element.prototype.scrollIntoView = vi.fn()
  mockGet.mockResolvedValue({ messages: [], running: false, title: '' })
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ChatEmbed onTyping', () => {
  it('reports one start per spell and one stop after the idle window, with no text', async () => {
    const onTyping = vi.fn()
    await act(async () => { render(embed('slot-1', onTyping)) })
    await type('h')
    await type('he')
    await type('hello')
    expect(onTyping.mock.calls).toEqual([[true]])
    await act(async () => { await vi.advanceTimersByTimeAsync(EMBED_TYPING_IDLE_MS - 1) })
    expect(onTyping.mock.calls).toEqual([[true]])
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(onTyping.mock.calls).toEqual([[true], [false]])
    // Every call carried exactly the boolean.
    expect(onTyping.mock.calls.every(c => c.length === 1 && typeof c[0] === 'boolean')).toBe(true)
  })

  it('a send that empties the draft ends the spell at once', async () => {
    mockSendTurn.mockResolvedValue({ status: 'dispatched', body: {} })
    const onTyping = vi.fn()
    await act(async () => { render(embed('slot-1', onTyping)) })
    await type('ship it')
    await act(async () => { fireEvent.keyDown(composer(), { key: 'Enter' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(mockSendTurn).toHaveBeenCalledTimes(1)
    expect(onTyping.mock.calls).toEqual([[true], [false]])
  })

  it('a draft the embed hands back after a failed send starts no spell', async () => {
    mockSendTurn.mockRejectedValue(new Error('offline'))
    const onTyping = vi.fn()
    await act(async () => { render(embed('slot-1', onTyping)) })
    await type('ship it')
    await act(async () => { fireEvent.keyDown(composer(), { key: 'Enter' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(composer().value).toBe('ship it')
    await act(async () => { await vi.advanceTimersByTimeAsync(EMBED_TYPING_IDLE_MS * 2) })
    expect(onTyping.mock.calls).toEqual([[true], [false]])
  })

  it('a slot switch and an unmount end the spell', async () => {
    const onTyping = vi.fn()
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(embed('slot-1', onTyping)) })
    await type('draft one')
    await act(async () => { view.rerender(embed('slot-2', onTyping)) })
    expect(onTyping.mock.calls).toEqual([[true], [false]])
    await type('draft two')
    await act(async () => { view.unmount() })
    expect(onTyping.mock.calls).toEqual([[true], [false], [true], [false]])
  })
})
