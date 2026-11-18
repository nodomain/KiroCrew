/**
 * "Share into app": the confirmation dialog previews what the gateway's privacy
 * filter held, and the share sends the preview's digest plus exactly the rows
 * the owner ticked. Only the `api` network boundary is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../api/client'
import { ApiError } from '../api/apiError'
import { i18nT } from '../i18n/t'
import { ShareIntoAppDialog } from '../pages/chat/ShareIntoApp'

vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, api: { chatSharePreview: vi.fn(), chatShare: vi.fn() } }
})

const target = { name: 'crew-rooms', display_name: 'Crew Rooms' }

beforeEach(() => {
  vi.mocked(api.chatSharePreview).mockReset().mockResolvedValue({
    ok: true,
    rows: 3,
    memory_mode: 'temporary',
    digest: 'd1',
    held: [
      { index: 0, role: 'user', reasons: ['email-address'], excerpt: 'mail a colleague' },
      { index: 2, role: 'user', reasons: ['access-token'], excerpt: 'a token' },
    ],
  })
  vi.mocked(api.chatShare).mockReset().mockResolvedValue({ ok: true, key: 'chat-2', messages: 3, held: 1, released: 1, memory_mode: 'temporary' })
})

describe('ShareIntoAppDialog', () => {
  it('shares the previewed digest with only the ticked rows released', async () => {
    const user = userEvent.setup()
    render(<ShareIntoAppDialog slotKey="chat-1" target={target} onClose={() => {}} />)
    expect(await screen.findByText('mail a colleague')).toBeTruthy()
    expect(api.chatSharePreview).toHaveBeenCalledWith('chat-1', 'crew-rooms')
    const boxes = screen.getAllByRole('checkbox')
    await user.click(boxes[1])
    await user.click(screen.getByRole('button', { name: i18nT('pages.chatPage.share_into_app_confirm') }))
    await waitFor(() => expect(api.chatShare).toHaveBeenCalledWith('chat-1', 'crew-rooms', 'd1', [2]))
    expect(await screen.findByText(i18nT('pages.chatPage.share_into_app_done', { app: 'Crew Rooms' }))).toBeTruthy()
  })

  it('says to check again when the chat changed since the preview', async () => {
    vi.mocked(api.chatShare).mockRejectedValue(
      new ApiError(409, 'changed', JSON.stringify({ error: 'changed', code: 'share_preview_stale' })),
    )
    const user = userEvent.setup()
    render(<ShareIntoAppDialog slotKey="chat-1" target={target} onClose={() => {}} />)
    await screen.findByText('a token')
    await user.click(screen.getByRole('button', { name: i18nT('pages.chatPage.share_into_app_confirm') }))
    expect(await screen.findByText(i18nT('pages.chatPage.share_into_app_stale'))).toBeTruthy()
    expect(screen.getByRole('button', { name: i18nT('pages.chatPage.share_into_app_check_again') })).toBeTruthy()
  })
})
