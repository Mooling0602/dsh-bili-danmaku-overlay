/**
 * Credential access for the Host half.
 *
 * ── Where the secrets live ─────────────────────────────────────────────────
 *
 * The plugin stores nothing. `SESSDATA` and `bili_jct` are read from the Harness
 * credential document (`~/.dsh/.credentials.yaml`, `refs` section) which the user
 * manages themselves through the Harness. This module only reads; there is no
 * write path, no cache on disk, and no route that returns a token value.
 *
 * ── Why the document is scanned rather than parsed ─────────────────────────
 *
 * The file can hold unrelated credentials. A whole-document YAML parse would pull
 * every other secret into memory and make an accidental log or crash dump far
 * more damaging. A line scan extracts the one requested key and discards the
 * rest, so the other refs never exist as objects in this process.
 *
 * ── What crosses the wire ──────────────────────────────────────────────────
 *
 * `credentialStatus()` returns booleans only — whether a session and a csrf token
 * are present — never a prefix, a length, or a hash of either. The page needs to
 * know if it may offer a send box, and nothing more.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CSRF_REF, SESSDATA_REF } from './config.ts'

/** A failure the page should show verbatim instead of a generic 500. */
export class BiliError extends Error {
  /** Bilibili's numeric code, or a short string tag for local failures. */
  readonly code: number | string | undefined

  /**
   * @param message - operator-facing explanation, already localized.
   * @param code - Bilibili code or local tag, when one applies.
   */
  constructor(message: string, code?: number | string) {
    super(message)
    this.name = 'BiliError'
    this.code = code
  }
}

/** Location of the credential document the Harness owns. */
export const CREDENTIAL_FILE = join(homedir(), '.dsh', '.credentials.yaml')

/** What the page is told about credential availability; booleans only. */
export interface CredentialStatus {
  readonly ok: boolean
  readonly configured: boolean
  readonly hasSessdata: boolean
  readonly hasCsrf: boolean
  readonly csrfRef: string
  readonly error?: string
}

/**
 * Extract one `refs.<name>` scalar with a line scan.
 *
 * Only the requested key is materialized; the surrounding document is walked as
 * text and dropped. Handles the two shapes a stored ref takes in practice: a bare
 * value, and a quoted value, with an optional trailing comment.
 *
 * @param name - the ref key to read.
 * @returns the trimmed value.
 * @throws {BiliError} when the file is missing or the key is absent.
 */
function readCredentialRef(name: string): string {
  let text: string
  try {
    text = readFileSync(CREDENTIAL_FILE, 'utf8')
  } catch {
    throw new BiliError(`未找到凭据文件 ${CREDENTIAL_FILE}，请先在 DSH 中配置登录凭据`, 'no-credential')
  }

  const lines = text.split(/\r?\n/)
  let inRefs = false
  let refsIndent = -1

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trimStart()

    // A top-level key ends the previous section; `refs:` opens the one we want.
    if (!trimmed.startsWith(' ') && indent === 0) {
      inRefs = /^refs\s*:\s*$/.test(trimmed)
      refsIndent = inRefs ? 0 : -1
      continue
    }
    if (!inRefs) continue
    if (indent <= refsIndent) {
      inRefs = false
      continue
    }

    const match = new RegExp(`^${name}\\s*:\\s*(.*)$`).exec(trimmed)
    if (!match) continue

    let value = (match[1] ?? '').trim()
    const hash = value.search(/\s#/)
    if (hash >= 0) value = value.slice(0, hash).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    return value
  }

  throw new BiliError(`凭据文件缺少 refs.${name}`, 'no-credential')
}

/**
 * Extract one cookie value from a raw `a=1; b=2` header string.
 *
 * @param cookie - the Cookie header.
 * @param name - the cookie to read.
 * @returns the value, or an empty string when absent.
 */
export function cookieValue(cookie: string, name: string): string {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match ? (match[1] ?? '').trim() : ''
}

/**
 * Build the Cookie header used for outbound Bilibili calls.
 *
 * The stored `SESSDATA` ref may hold either the bare token or a full Cookie
 * header, because both are common ways to copy it out of a browser. A separate
 * `bili_jct` ref supplies the csrf token when only the session was stored.
 *
 * @returns a Cookie header carrying at least `SESSDATA`.
 * @throws {BiliError} when no session token is configured.
 */
export function buildCookie(): string {
  const stored = readCredentialRef(SESSDATA_REF).trim()
  if (stored === '') {
    throw new BiliError(`凭据 refs.${SESSDATA_REF} 为空`, 'no-credential')
  }

  const base = stored.includes('=') ? stored : `SESSDATA=${stored}`
  if (cookieValue(base, 'bili_jct') !== '') return base

  let csrfRef = ''
  try {
    csrfRef = readCredentialRef(CSRF_REF).trim()
  } catch {
    return base
  }
  if (csrfRef === '') return base

  const value = csrfRef.startsWith('bili_jct=') ? csrfRef.slice('bili_jct='.length) : csrfRef
  return `${base}; bili_jct=${value}`
}

/**
 * Report whether a usable login is configured, without sending anything.
 *
 * Never throws: a failure is itself an answer the page renders as "not
 * configured", which is more useful than a failed request.
 *
 * @returns the availability flags.
 */
export function credentialStatus(): CredentialStatus {
  try {
    const cookie = buildCookie()
    const hasSess = cookieValue(cookie, 'SESSDATA') !== ''
    const hasCsrf = cookieValue(cookie, 'bili_jct') !== ''
    return {
      ok: true,
      configured: hasSess,
      hasSessdata: hasSess,
      hasCsrf,
      csrfRef: CSRF_REF,
    }
  } catch (error) {
    return {
      ok: true,
      configured: false,
      hasSessdata: false,
      hasCsrf: false,
      csrfRef: CSRF_REF,
      error: error instanceof Error && error.message !== '' ? error.message : '未配置登录凭据',
    }
  }
}
