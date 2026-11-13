/**
 * The credential this plugin owns, kept apart from the Harness document.
 *
 * Why a second store exists
 *
 * `~/.dsh/.credentials.yaml` belongs to the Harness and is edited by hand. A login
 * obtained by scanning a QR code is obtained by this plugin, refreshed on its own
 * schedule, and carries fields the refs section has no place for, so writing it back
 * there would mean the plugin silently rewriting a document it does not own. Keeping
 * the two apart means each has one writer.
 *
 * Why under `~/.dsh` and not the profile directory
 *
 * A profile directory is the unit that a `dsh` profile owns, and the same person can
 * run several. A login is a fact about the person, not about one profile, so storing
 * it per profile would ask the reader to scan again for every profile they use. The
 * path sits under `~/.dsh` because that is the one directory every profile shares.
 *
 * What is written
 *
 * The file holds live session tokens, so it is created with mode `600` inside a
 * directory created with mode `700`. It is written by writing a sibling file and
 * renaming it over the target, which means a crash mid-write leaves the previous
 * working login in place rather than a half-written one that parses as nothing.
 * Nothing in this module returns a token to a caller outside the Host.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory the plugin owns under the Harness home. */
export const STORE_DIR = join(homedir(), '.dsh', 'bili-danmaku-overlay')

/** The file holding the scanned login. */
export const STORE_FILE = join(STORE_DIR, 'credential.json')

/**
 * The login this plugin holds.
 *
 * Field names follow the cookie names Bilibili uses, so a value read from here and a
 * value read from the refs section cannot be confused for one another during review.
 */
export interface StoredLogin {
  /** The session cookie, already decoded to the form a `Cookie` header takes. */
  readonly sessdata: string
  /** The csrf token a send requires. */
  readonly biliJct: string
  /** The numeric account id, when Bilibili returned one. */
  readonly dedeUserId?: string
  /** The account name, filled once the login was confirmed. */
  readonly uname?: string
  /**
   * Refresh token, stored even though nothing uses it yet.
   *
   * It is issued once at login and cannot be obtained later without signing in again,
   * so it is captured now and the renewal path can be built without asking the reader
   * to scan a second time.
   */
  readonly refreshToken?: string
  /** When the login was obtained, as an ISO timestamp. */
  readonly loggedInAt: string
}

/**
 * Read the stored login.
 *
 * A file that is absent, unreadable or not shaped like a login is treated as no login
 * at all. That is deliberate: a partially written or hand-edited file must not be
 * handed to an upstream request as though it were valid, and the caller's next move
 * for "no login" is the same in every one of those cases.
 *
 * @returns the stored login, or null when there is none usable.
 */
export function readLogin(): StoredLogin | null {
  let text: string
  try {
    text = readFileSync(STORE_FILE, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const sessdata = typeof record.sessdata === 'string' ? record.sessdata : ''
  if (sessdata === '') return null
  return {
    sessdata,
    biliJct: typeof record.biliJct === 'string' ? record.biliJct : '',
    dedeUserId: typeof record.dedeUserId === 'string' ? record.dedeUserId : undefined,
    uname: typeof record.uname === 'string' ? record.uname : undefined,
    refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : undefined,
    loggedInAt: typeof record.loggedInAt === 'string' ? record.loggedInAt : '',
  }
}

/**
 * Write the stored login, replacing whatever was there.
 *
 * The directory is created with mode `700` and the file with `600`. The rename at the
 * end is what makes the write atomic: a reader either sees the previous login or the
 * new one, never a file that is still being written.
 *
 * @param login - the login to persist.
 * @throws {Error} when the directory or the file cannot be written.
 */
export function writeLogin(login: StoredLogin): void {
  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 })
  // `mkdirSync` leaves an existing directory's mode alone, so the restriction is
  // applied again here. A directory created before this mode was chosen would
  // otherwise keep whatever it had.
  try {
    chmodSync(STORE_DIR, 0o700)
  } catch {
    // A directory the process cannot chmod is still usable, and failing the login
    // over it would be worse than writing the file.
  }
  const temporary = `${STORE_FILE}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(login, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // The mode passed above only applies when the file is created, so an existing file
  // written through the temporary path is narrowed again here.
  try {
    chmodSync(temporary, 0o600)
  } catch {
    // Same reasoning as the directory above.
  }
  renameSync(temporary, STORE_FILE)
}

/**
 * Drop the stored login.
 *
 * @returns whether a file was removed, so a caller can tell "cleared" from "there was
 * nothing to clear" without inspecting the directory itself.
 */
export function clearLogin(): boolean {
  try {
    rmSync(STORE_FILE)
    return true
  } catch {
    return false
  }
}
