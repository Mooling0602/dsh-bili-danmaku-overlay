/**
 * The notice a credential problem raises.
 *
 * ── Why the mapping lives here and not in the Host ─────────────────────────
 *
 * The Host knows which condition it hit; the page knows how to word it. Splitting
 * them that way is what lets a login method be added on the Host side without the
 * page learning a new string: the new method reports its own code, and the page
 * either finds wording for it or falls back to the sentence the Host supplied.
 *
 * The fallback is not decoration. A page and a Host are not guaranteed to be the
 * same version, because the Client half is a bundle rebuilt independently of the
 * process serving it, so a code this build has never heard of is a normal state
 * rather than a bug. Worded by falling back, it still tells the reader what went
 * wrong instead of showing a raw identifier.
 */

import type { CopyKey } from './copy.ts'
import type { DialogSpec } from './dialog.tsx'
import type { Credential } from './api.ts'

/** What a notice needs from the overlay to be rendered. */
export interface CredentialNoticeInput {
  /** The credential as the Host last reported it. */
  readonly credential: Credential | null
  /** Localized lookup, so the notice follows the page's language. */
  readonly t: (key: CopyKey) => string
  /**
   * Called when the reader asks to sign in by scanning a QR code.
   *
   * The notice does not know how that sign-in works, and it should not: the button is
   * reserved here so the wording and the placement stay stable while the flow behind
   * it is built. Offering the entry before the flow exists is deliberate, because the
   * alternative is a notice that tells the reader to edit a credential file by hand
   * with no hint that anything better is coming.
   */
  readonly onQrLogin: () => void
}

/**
 * Wording for each condition the Host can report.
 *
 * The keys are the codes `CredentialCode` defines on the Host side. A code absent
 * here is not an error: `credentialNotice` falls back to the Host's own sentence,
 * which is what keeps an older page honest against a newer Host.
 */
const TITLES: Readonly<Record<string, CopyKey>> = {
  expired: 'credentialExpiredTitle',
  missing: 'credentialMissingTitle',
  unreadable: 'credentialUnreadableTitle',
  'no-csrf': 'credentialNoCsrfTitle',
}

/**
 * The body for a condition, chosen by which store the login came from.
 *
 * The generic sentence names no file, and it is what both a reader with no
 * credential at all and one whose scanned login lapsed see. The refs variant is used
 * only when that store is the one at fault, because telling a reader to update a
 * section that is not the source of their problem sends them to edit the wrong place.
 */
const BODIES: Readonly<Record<string, CopyKey>> = {
  expired: 'credentialExpiredBody',
  missing: 'credentialMissingBody',
  unreadable: 'credentialUnreadableBody',
  'no-csrf': 'credentialNoCsrfBody',
}

/** Bodies that name the refs section, used when that store is the one reporting. */
const BODIES_FROM_REFS: Readonly<Record<string, CopyKey>> = {
  expired: 'credentialExpiredBodyRefs',
  missing: 'credentialMissingBodyRefs',
}

/** Bodies that name a scanned login, used when that store is the one reporting. */
const BODIES_FROM_SCANNED: Readonly<Record<string, CopyKey>> = {
  expired: 'credentialExpiredBodyScanned',
}

/**
 * The body key for a condition, given the store the login came from.
 *
 * `source` is absent when neither store produced a session, and that is exactly the
 * case that must not claim the refs section is stale: the reader may never have
 * written one. In that state the generic sentence is the only accurate one.
 *
 * @param code - the condition the Host reported.
 * @param source - the store the credential came from, or undefined for neither.
 * @returns the dictionary key to read, or undefined for a code this build lacks.
 */
function bodyKeyFor(code: string, source: 'custom' | 'scanned' | undefined): CopyKey | undefined {
  if (source === 'custom') {
    const refs = BODIES_FROM_REFS[code]
    if (refs !== undefined) return refs
  }
  if (source === 'scanned') {
    const scanned = BODIES_FROM_SCANNED[code]
    if (scanned !== undefined) return scanned
  }
  return BODIES[code]
}

/**
 * Decide which condition to describe, in the order the reader can act on.
 *
 * A credential that was never configured outranks one that is present but stale,
 * because the fix is different: the first needs a token written, the second needs a
 * token replaced. The `valid` verdict alone cannot separate them, since both read as
 * `no`, which is why the reported code is consulted first and the verdict only fills
 * in when no code arrived.
 *
 * @param credential - the reported credential.
 * @returns the code to word, or null when nothing is wrong enough to interrupt for.
 */
function problemCode(credential: Credential): string | null {
  // A request that never reached the Host says nothing about the credential, so it is
  // not a condition to word. The row stays neutral and no notice is raised.
  if (credential.code === 'unreachable') return null
  if (credential.code !== undefined && credential.code !== '') return credential.code
  if (!credential.configured) return 'missing'
  if (credential.valid === 'no') return 'expired'
  if (credential.hasCsrf === false) return 'no-csrf'
  return null
}

/**
 * Word the body of a notice.
 *
 * The detail the Host reported is kept alongside the dictionary sentence rather than
 * replaced by it: a reader whose credential file is missing and one whose file lacks
 * only a key need different fixes, and the Host is the only half that can tell them
 * apart. A code with no dictionary entry falls back to that detail alone.
 *
 * @param credential - the reported credential.
 * @param bodyKey - the dictionary key for this code, when this build knows it.
 * @param t - the page's own wording lookup.
 * @returns the body text.
 */
function bodyText(
  credential: Credential,
  bodyKey: CopyKey | undefined,
  t: (key: CopyKey) => string,
): string {
  const detail = credential.reason ?? credential.error ?? ''
  if (bodyKey === undefined) return detail === '' ? t('credentialNoticeBody') : detail
  const body = t(bodyKey)
  // Only the `missing` condition benefits from the Host's wording, which names the
  // file or the ref that is absent. The others already say everything the reader can
  // act on, so appending would repeat the same instruction twice.
  const namesWhatIsAbsent = credential.code === 'missing' && detail !== ''
  return namesWhatIsAbsent ? `${body}\n${detail}` : body
}
/**
 * Word a credential condition in one short line, for the ball menu's row.
 *
 * It exists so the row and the notice say the same thing. The row used to print the
 * Host's `reason`, which is written for whoever reads a log, while the notice printed
 * the dictionary sentence, and a reader who saw both read two different accounts of one
 * problem. The dictionary wins here for the same reason it wins in the notice, and the
 * Host's sentence is the fallback only for a code this build has no wording for.
 *
 * @param credential - the reported credential.
 * @param t - the page's own wording lookup.
 * @returns the short line, or an empty string when nothing is wrong.
 */
export function credentialSummary(credential: Credential | null, t: (key: CopyKey) => string): string {
  if (credential === null) return t('credentialUnknown')
  const code = problemCode(credential)
  if (code === null) {
    return credential.configured ? '' : credential.error ?? t('credentialMissing')
  }
  if (code === 'expired') {
    return credential.source === 'scanned' ? t('credentialExpiredScanned') : t('credentialExpired')
  }
  if (code === 'missing') return t('credentialMissing')
  if (code === 'unreadable') return t('credentialUnreadable')
  if (code === 'no-csrf') return t('credentialNoCsrf')
  // A code this build has no wording for, which is a normal state rather than a
  // defect because the Client bundle and the Host are versioned separately.
  return credential.reason ?? credential.error ?? ''
}

/**
 * Build the notice for the current credential.
 *
 * Returns null when there is nothing to say. A credential that is simply unknown,
 * because the session check could not reach Bilibili, does not raise a notice: a
 * network failure is not the reader's problem to fix, and telling them to replace a
 * working token is worse than saying nothing. That state stays visible as the neutral
 * row in the ball menu.
 *
 * @param input - the reported credential and the page's own wording lookup.
 * @returns the notice, or null when the credential raises none.
 */
export function credentialNotice(input: CredentialNoticeInput): DialogSpec | null {
  const { credential, t } = input
  if (credential === null) return null
  // A missing file is reported as `error` beside `valid: 'no'`, and the code that
  // accompanies it already says which of the two conditions it is.
  const code = problemCode(credential)
  if (code === null) return null
  const titleKey = TITLES[code]
  const bodyKey = bodyKeyFor(code, credential.source)
  return {
    title: titleKey === undefined ? t('credentialNoticeTitle') : t(titleKey),
    // The dictionary words the condition, because it knows how to say what to do next.
    // The Host's own sentence is added when it carries a detail the dictionary cannot
    // know, such as which ref is absent, and is the whole message for a code this build
    // has never heard of.
    message: bodyText(credential, bodyKey, t),
    actions: [
      {
        label: t('qrLogin'),
        // The sign-in flow replaces this notice with its own, so the layer stands
        // aside instead of closing a notice the callback has already swapped.
        replaces: true,
        onPress: input.onQrLogin,
      },
      { label: t('confirm'), primary: true },
    ],
  }
}
