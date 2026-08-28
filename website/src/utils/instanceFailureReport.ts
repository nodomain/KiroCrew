/**
 * Journal a remote crew's tunnel failure so the error surfaces that render it can
 * hand the agent real context instead of one truncated sentence.
 *
 * ## Why these failures need their own recorder
 *
 * `api/client.ts`'s `apiFailure` journals every non-2xx, which already covers a
 * failed `POST /api/instances/{id}/connect`. But the two surfaces a user actually
 * sits in front of read the failure from a **200**: the 60-second instances poll
 * carries `status.error` and the diagnosis ladder's verdict, and
 * `POST …/diagnose` answers 200 whether the verdict is healthy or not. Neither
 * passes through `apiFailure`, so without this the journal has no entry and the
 * hand-off degrades to the bare display string — dropping the `probes` ladder,
 * which is the one part that says WHICH link in the chain is broken.
 *
 * ## De-duplication is required, not an optimization
 *
 * The journal is 20 entries deep and the poll repeats every 60 seconds. Recording
 * unconditionally would evict every other error in the tab within twenty minutes
 * of one persistently-down crew, so a report is written only when an instance's
 * failure SIGNATURE changes. A crew that recovers and breaks again the same way
 * is re-reported, because the signature clears on recovery.
 */

import { recordError } from './errorReport'
import type { InstanceTunnelStatus } from '../api/client'

/**
 * Last-reported signature per instance id. Module state, per tab, matching the
 * journal it feeds: persisting it would suppress the first report after a reload,
 * which is exactly when a user is looking at the failure.
 */
const _reported = new Map<string, string>()

/** What the caller was looking at when it decided this was a failure. */
export type InstanceFailureStage =
  /** The tunnel/diagnosis says broken. */
  | 'connect'
  /** The tunnel claims connected but the embedded dashboard never loaded. */
  | 'pane_load'

/**
 * Render the diagnosis ladder as the ordered chain it is.
 *
 * The probe list is the payload's most actionable part: `ssh=ok` followed by
 * `remote_dashboard=FAILED` names a different repair than `ssh=FAILED` does, and
 * a reader who only sees the summary sentence cannot tell them apart. Written as
 * a chain so the first FAILED entry reads as the broken link.
 */
function describeProbes(probes: { name: string; ok: boolean }[] | undefined): string {
  if (!probes?.length) return ''
  return 'probes: ' + probes.map(p => `${p.name}=${p.ok ? 'ok' : 'FAILED'}`).join(' -> ')
}

/**
 * The one string that identifies this failure.
 *
 * Both halves must agree on it: the journal is keyed by message, and
 * `AskAgentButton` recovers the report by exact match — so a surface that
 * DISPLAYS one string while the report was keyed on another silently degrades the
 * hand-off to a bare sentence with no ladder attached. Exported so a caller
 * derives its label from here rather than re-implementing the precedence.
 *
 * A diagnosis is only consulted when its verdict is negative: the stored result
 * is the last ladder RUN, so a stale `ok` would otherwise supply "All checks
 * passed" as the text of a failure.
 */
export function instanceFailureMessage(
  status: InstanceTunnelStatus | undefined,
  fallbackMessage: string,
): string {
  const diagnosis = status?.diagnosis
  return status?.error || (diagnosis && !diagnosis.ok ? diagnosis.reason : '') || fallbackMessage
}

/**
 * Record one instance failure, at most once per distinct failure.
 *
 * Returns the message the report was keyed on, which is also what a caller should
 * hand to `AskAgentButton` so its journal lookup resolves. Returns an empty
 * string when there was nothing worth reporting — the caller then has no
 * diagnostic to offer and should render no hand-off.
 */
export function reportInstanceFailure(input: {
  id: string
  name: string
  /** `ssh` / `ssm` — which transport's repair steps apply. */
  transport: string
  status: InstanceTunnelStatus | undefined
  stage: InstanceFailureStage
  /** Display string the surface is showing, used when the status carries no error. */
  fallbackMessage: string
}): string {
  const { id, name, transport, status, stage, fallbackMessage } = input
  const diagnosis = status?.diagnosis
  const message = instanceFailureMessage(status, fallbackMessage)
  if (!message) {
    _reported.delete(id)
    return ''
  }
  const code = diagnosis && !diagnosis.ok ? diagnosis.code : undefined
  const signature = [stage, status?.state ?? '', code ?? '', message].join('|')
  if (_reported.get(id) === signature) return message
  _reported.set(id, signature)
  recordError({
    source: 'system',
    message,
    // The ladder's verdict, not an HTTP code: `ssh_unreachable` and `remote_down`
    // are what distinguish the repairs, and they are stable strings.
    code,
    detail: [
      `crew: ${name} (${id})`,
      `transport: ${transport}`,
      `tunnel state: ${status?.state ?? 'unknown'}`,
      `stage: ${stage}`,
      diagnosis ? `diagnosis: ${diagnosis.code} — ${diagnosis.reason}` : '',
      describeProbes(diagnosis?.probes),
    ]
      .filter(Boolean)
      .join('\n'),
  })
  return message
}

/** Forget an instance's reported failure, so its next failure is journaled again. */
export function clearInstanceFailure(id: string): void {
  _reported.delete(id)
}

/** Test seam — the de-dup map is module state. */
export function __resetInstanceFailuresForTests(): void {
  _reported.clear()
}
