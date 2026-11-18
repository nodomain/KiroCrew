import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AppWindow, ChevronRight } from 'lucide-react'

import { api } from '../../api/client'
import Modal from '../../components/Modal'
import { Btn } from '../../components/ui'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../../components/ui/dropdown-menu'
import { i18nT } from '../../i18n/t'
import { parseErrorCode } from '../../utils/errorReport'

/** An app a chat can be shared into, as `GET /api/chat/share-targets` lists it. */
export interface ShareTarget {
  name: string
  display_name: string
}

/**
 * The session header menu's "Share into app" submenu: the installed apps that
 * can receive a chat, read lazily when the submenu opens. Picking one hands it
 * to `onPick`; the header menu owns the dialog, because this submenu unmounts
 * with the menu.
 */
export function ShareIntoAppSubmenu({ onPick }: { onPick: (target: ShareTarget) => void }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['chat-share-targets'],
    queryFn: () => api.chatShareTargets(),
    enabled: open,
  })
  const apps = data?.apps ?? []
  return (
    <DropdownMenuSub onOpenChange={setOpen}>
      <DropdownMenuSubTrigger>
        <AppWindow size={13} className="shrink-0 text-muted" />
        <span className="flex-1">{i18nT('pages.chatPage.share_into_app')}</span>
        <ChevronRight size={12} className="text-muted" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[200px]">
        {apps.map(app => (
          <DropdownMenuItem key={app.name} onSelect={() => onPick(app)}>
            {app.display_name}
          </DropdownMenuItem>
        ))}
        {!isLoading && apps.length === 0 && (
          <DropdownMenuItem disabled>{i18nT('pages.chatPage.share_into_app_none')}</DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

type Preview = Awaited<ReturnType<typeof api.chatSharePreview>>

/**
 * Confirms a share: shows what the gateway's privacy filter held, lets the owner
 * release single rows, and shares only the previewed transcript (the share sends
 * the preview's digest, and a chat that changed meanwhile is refused).
 */
export function ShareIntoAppDialog({ slotKey, target, onClose }: {
  slotKey: string
  target: ShareTarget | null
  onClose: () => void
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [release, setRelease] = useState<Set<number>>(new Set())
  const [status, setStatus] = useState<'loading' | 'ready' | 'sharing' | 'done' | 'error'>('loading')
  const [error, setError] = useState('')

  const load = () => {
    if (!target) return
    setStatus('loading')
    setPreview(null)
    setRelease(new Set())
    api.chatSharePreview(slotKey, target.name).then(
      p => { setPreview(p); setStatus('ready') },
      () => { setError(i18nT('pages.chatPage.share_into_app_failed')); setStatus('error') },
    )
  }
  // A new target or session starts a fresh preview.
  useEffect(load, [slotKey, target?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  const share = async () => {
    if (!target || !preview) return
    setStatus('sharing')
    try {
      await api.chatShare(slotKey, target.name, preview.digest, [...release])
      setStatus('done')
    } catch (e) {
      const body = (e as { body?: unknown } | null)?.body
      const stale = parseErrorCode(typeof body === 'string' ? body : undefined) === 'share_preview_stale'
      setError(i18nT(stale ? 'pages.chatPage.share_into_app_stale' : 'pages.chatPage.share_into_app_failed'))
      setStatus('error')
    }
  }

  const toggle = (index: number) => setRelease(prev => {
    const next = new Set(prev)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    return next
  })

  const app = target?.display_name ?? ''
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={i18nT('pages.chatPage.share_into_app_title', { app })}
      maxWidth={520}
      footer={status === 'done' ? (
        <Btn primary onClick={onClose}>{i18nT('components.modal.close')}</Btn>
      ) : (
        <>
          <Btn onClick={onClose}>{i18nT('components.confirmDialog.cancel')}</Btn>
          {status === 'error' && preview === null
            ? null
            : status === 'error'
              ? <Btn primary onClick={load}>{i18nT('pages.chatPage.share_into_app_check_again')}</Btn>
              : <Btn primary disabled={status !== 'ready'} onClick={() => { void share() }}>{i18nT('pages.chatPage.share_into_app_confirm')}</Btn>}
        </>
      )}
    >
      <div className="flex flex-col gap-3 text-sm text-text" data-testid="share-into-app-dialog">
        {status === 'done' ? (
          <p className="m-0">{i18nT('pages.chatPage.share_into_app_done', { app })}</p>
        ) : (
          <>
            <p className="m-0">{i18nT('pages.chatPage.share_into_app_body', { app })}</p>
            {status === 'loading' && <p className="m-0 text-muted">{i18nT('pages.chatPage.share_into_app_loading')}</p>}
            {status === 'error' && <p className="m-0 text-danger" role="alert">{error}</p>}
            {preview && preview.held.length === 0 && (
              <p className="m-0 text-muted">{i18nT('pages.chatPage.share_into_app_nothing_held')}</p>
            )}
            {preview && preview.held.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="m-0 font-medium">{i18nT('pages.chatPage.share_into_app_held')}</p>
                <ul className="m-0 p-0 list-none flex flex-col gap-2 max-h-[300px] overflow-auto">
                  {preview.held.map(row => (
                    <li key={row.index} className="rounded-md border border-border p-2 flex flex-col gap-1">
                      {/* The reasons are filter rule ids, shown as written. */}
                      <span className="text-xs text-muted">{row.reasons.join(', ')}</span>
                      <span className="break-words whitespace-pre-line">{row.excerpt}</span>
                      <label className="flex items-center gap-2 text-xs cursor-pointer">
                        <input type="checkbox" aria-label={i18nT('pages.chatPage.share_into_app_release')} checked={release.has(row.index)} onChange={() => toggle(row.index)} />
                        {i18nT('pages.chatPage.share_into_app_release')}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
