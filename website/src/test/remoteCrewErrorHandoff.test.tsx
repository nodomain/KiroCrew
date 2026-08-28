/**
 * Remote-crew failure → agent hand-off.
 *
 * The first-time-setup path is what these pin, in the two shapes it fails in:
 *  1. **Add** rejects the registration. The banner offers the hand-off, and the
 *     hand-off must not eat the form — hence the stash, and hence the ORDERING
 *     of `onHandoff` (before the navigation, while the subtree still exists).
 *  2. **Connect** fails. The evidence rides a 200 poll, so a surface has to
 *     journal it itself, and the report has to carry the diagnosis ladder — the
 *     part that says which link in the chain broke — not just the sentence shown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ErrorNotice from '../components/ErrorNotice'
import type { InstanceTunnelStatus } from '../api/client'
import {
  DRAFT_TTL_MS,
  clearInstanceFormDraft,
  peekInstanceFormDraft,
  stashInstanceFormDraft,
} from '../utils/instanceFormDraft'
import {
  instanceFailureMessage,
  reportInstanceFailure,
  __resetInstanceFailuresForTests,
} from '../utils/instanceFailureReport'
import { instanceFormValuesFrom, EMPTY_INSTANCE_FORM } from '../pages/settings/InstanceFormFields'
import {
  findReport,
  installSoftNavigate,
  recentErrors,
  __resetErrorJournalForTests,
  __resetNavSeamForTests,
} from '../utils/errorReport'

const navigated: string[] = []

beforeEach(() => {
  __resetErrorJournalForTests()
  __resetNavSeamForTests()
  __resetInstanceFailuresForTests()
  navigated.length = 0
  sessionStorage.clear()
  installSoftNavigate(to => { navigated.push(to) })
})

afterEach(() => {
  __resetNavSeamForTests()
  vi.restoreAllMocks()
})

const brokenStatus = (over: Partial<InstanceTunnelStatus> = {}): InstanceTunnelStatus => ({
  instance_id: 'cd-1',
  state: 'error',
  error: 'tunnel failed',
  diagnosis: {
    code: 'remote_down',
    ok: false,
    reason: 'SSH works but the remote dashboard is not responding',
    probes: [
      { name: 'ssh', ok: true },
      { name: 'remote_dashboard', ok: false },
    ],
  },
  ...over,
})

describe('add-form draft stash', () => {
  it('round-trips values and clears on demand', () => {
    expect(peekInstanceFormDraft()).toBeNull()
    expect(stashInstanceFormDraft({ ...EMPTY_INSTANCE_FORM, name: 'Box', sshHost: 'h' })).toBe(true)
    expect(peekInstanceFormDraft()).toMatchObject({ name: 'Box', sshHost: 'h' })
    // Non-destructive: StrictMode mounts twice, so the second mount must still
    // find the draft the first one read.
    expect(peekInstanceFormDraft()).toMatchObject({ name: 'Box' })
    clearInstanceFormDraft()
    expect(peekInstanceFormDraft()).toBeNull()
  })

  it('drops an entry past its TTL instead of re-seeding a stale form', () => {
    stashInstanceFormDraft({ ...EMPTY_INSTANCE_FORM, name: 'Old' })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DRAFT_TTL_MS + 1)
    expect(peekInstanceFormDraft()).toBeNull()
  })

  it('rejects a malformed payload rather than half-restoring a form', () => {
    sessionStorage.setItem('kirocrew_instance_form_draft', 'not json')
    expect(peekInstanceFormDraft()).toBeNull()
  })
})

describe('instanceFormValuesFrom', () => {
  it('accepts a complete record', () => {
    expect(instanceFormValuesFrom({ ...EMPTY_INSTANCE_FORM, name: 'Box' })).toMatchObject({
      name: 'Box',
      method: 'ssh',
    })
  })

  it('rejects a partial record whole', () => {
    // A merged-over-defaults restore would look complete while carrying a field
    // the user never typed, so a missing key must reject the entire payload.
    const { sshHost: _dropped, ...partial } = EMPTY_INSTANCE_FORM
    expect(instanceFormValuesFrom(partial)).toBeNull()
  })

  it('rejects a non-string field and an unknown transport', () => {
    expect(instanceFormValuesFrom({ ...EMPTY_INSTANCE_FORM, remotePort: 5476 })).toBeNull()
    expect(instanceFormValuesFrom({ ...EMPTY_INSTANCE_FORM, method: 'telnet' })).toBeNull()
    expect(instanceFormValuesFrom(null)).toBeNull()
    expect(instanceFormValuesFrom([EMPTY_INSTANCE_FORM])).toBeNull()
  })
})

describe('ErrorNotice askAgent hand-off ordering', () => {
  it('runs onHandoff BEFORE navigating, so a caller can persist its state', async () => {
    const order: string[] = []
    installSoftNavigate(to => { order.push(`navigate:${to}`) })
    render(
      <ErrorNotice
        message="name already in use"
        askAgent
        onHandoff={() => { order.push('handoff') }}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /agent/i }))
    // The navigation unmounts the subtree the caller's state lives in, so a
    // callback that ran afterwards could not save anything.
    expect(order).toEqual(['handoff', 'navigate:/chat'])
  })

  it('still hands off when the callback throws', async () => {
    render(
      <ErrorNotice
        message="name already in use"
        askAgent
        onHandoff={() => { throw new Error('stash exploded') }}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /agent/i }))
    expect(navigated).toEqual(['/chat'])
  })
})

describe('reportInstanceFailure', () => {
  it('journals the ladder as an ordered chain with the verdict as the code', () => {
    const message = reportInstanceFailure({
      id: 'cd-1',
      name: 'Box',
      transport: 'ssh',
      status: brokenStatus(),
      stage: 'connect',
      fallbackMessage: '',
    })
    expect(message).toBe('tunnel failed')
    const [report] = recentErrors()
    expect(report.source).toBe('system')
    expect(report.code).toBe('remote_down')
    // The chain is the actionable part: ssh ok + remote dashboard failed names a
    // different repair than ssh failed does.
    expect(report.detail).toContain('probes: ssh=ok -> remote_dashboard=FAILED')
    expect(report.detail).toContain('transport: ssh')
  })

  it('records once per distinct failure, so one down crew cannot flush the journal', () => {
    const args = {
      id: 'cd-1',
      name: 'Box',
      transport: 'ssh',
      status: brokenStatus(),
      stage: 'connect' as const,
      fallbackMessage: '',
    }
    reportInstanceFailure(args)
    reportInstanceFailure(args)
    reportInstanceFailure(args)
    expect(recentErrors()).toHaveLength(1)
    // A different verdict is a different failure and is reported again.
    reportInstanceFailure({
      ...args,
      status: brokenStatus({
        error: '',
        diagnosis: {
          code: 'ssh_unreachable',
          ok: false,
          reason: "Can't SSH to the host",
          probes: [{ name: 'ssh', ok: false }],
        },
      }),
    })
    expect(recentErrors()).toHaveLength(2)
    expect(recentErrors()[0].code).toBe('ssh_unreachable')
  })

  it('reports the watchdog case, which carries no backend error string', () => {
    // The tunnel says connected while the embedded pane never loaded — the one
    // failure with no self-evident cause, so it must not be the one with no report.
    const message = reportInstanceFailure({
      id: 'cd-1',
      name: 'Box',
      transport: 'ssm',
      status: { instance_id: 'cd-1', state: 'connected' },
      stage: 'pane_load',
      fallbackMessage: 'The pane failed to load',
    })
    expect(message).toBe('The pane failed to load')
    expect(recentErrors()[0].detail).toContain('stage: pane_load')
  })

  it('keys the report on the SAME string a surface should label the button with', () => {
    // The journal lookup is an exact message match. When both a tunnel error and
    // a ladder reason exist they differ, so a surface that labels its button with
    // the reason while the report was keyed on the error gets no report at all —
    // the hand-off silently loses the probe chain, which is the whole payload.
    const status = brokenStatus()
    expect(status.error).not.toBe(status.diagnosis?.reason)
    const keyed = reportInstanceFailure({
      id: 'cd-1',
      name: 'Box',
      transport: 'ssh',
      status,
      stage: 'connect',
      fallbackMessage: '',
    })
    expect(instanceFailureMessage(status, '')).toBe(keyed)
    expect(findReport(instanceFailureMessage(status, ''))?.code).toBe('remote_down')
  })

  it('never labels a failure with a stale healthy verdict', () => {
    // The stored diagnosis is the last ladder RUN, so an `ok` left over from
    // before the failure must not become the text of the failure.
    const status: InstanceTunnelStatus = {
      instance_id: 'cd-1',
      state: 'error',
      error: '',
      diagnosis: { code: 'ok', ok: true, reason: 'All checks passed', probes: [] },
    }
    expect(instanceFailureMessage(status, 'The pane failed to load')).toBe(
      'The pane failed to load',
    )
  })

  it('records nothing when there is no failure to describe', () => {
    expect(
      reportInstanceFailure({
        id: 'cd-1',
        name: 'Box',
        transport: 'ssh',
        status: { instance_id: 'cd-1', state: 'connected' },
        stage: 'connect',
        fallbackMessage: '',
      }),
    ).toBe('')
    expect(recentErrors()).toHaveLength(0)
  })
})
