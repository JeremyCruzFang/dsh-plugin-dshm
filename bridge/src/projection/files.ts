import { lstat, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { DmpError } from '../errors.js'
import type { DmpObject } from '../types.js'
import type { NativeRecord } from './fold-recording.mjs'
import { deliverableId } from './ids.mjs'

interface FileSession { cwd: string; records: readonly NativeRecord[] }
export interface FileProjectionAccess {
  home: string
  session(sessionId: string, signal: AbortSignal): Promise<FileSession>
  call(namespace: string, method: string, args: DmpObject, signal: AbortSignal): Promise<unknown>
  fetch(request: Request): Promise<Response>
  changeState?(sessionId: string, seq: number, state: { available: boolean; fileCount?: number; added?: number; deleted?: number }): void
}
interface FileTarget {
  path: string
  requested: string
  absolute: string
  home: string
  root?: string
  rootPath?: string
  stats: Stats
}
const object = (value: unknown): DmpObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as DmpObject : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const integer = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
const DOWNLOAD_LIMIT = 32 * 1024 * 1024
const TEXT_LIMIT = 1024 * 1024
// Leave room for the response envelope, including the largest request id.
const RESULT_LIMIT = TEXT_LIMIT - 1024
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const kind = (value: Stats): string => value.isSymbolicLink() ? 'symlink' : value.isDirectory() ? 'dir' : value.isFile() ? 'file' : 'other'
const events = (session: FileSession): DmpObject[] => session.records.filter(record => record.source === 'session').map(record => object(record.frame.event))

function fileError(error: unknown): never {
  if (error instanceof DmpError) throw error
  const code = string(object(error).code), name = string(object(error).name)
  if (name === 'AbortError') throw new DmpError('cancelled')
  if (name === 'TimeoutError') throw new DmpError('timeout')
  if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code) || code.includes('not-found') || code.includes('not-regular-file')) throw new DmpError('not-found')
  if (['EACCES', 'EPERM'].includes(code) || code.includes('outside-workspace')) throw new DmpError('forbidden-path')
  if (code.includes('not-text')) throw new DmpError('invalid-params', 'File is not text', { reason: 'not-text' })
  if (code.includes('too-large')) throw new DmpError('too-large', 'File exceeds the transfer limit', { limit: DOWNLOAD_LIMIT })
  if (code.includes('bad-request') || code.includes('not-directory')) throw new DmpError('invalid-params')
  if (code.includes('peer-disposed')) throw new DmpError('dsh-unavailable')
  throw new DmpError('internal', 'DSH file operation failed')
}

function requestedPath(value: unknown): string {
  if (typeof value !== 'string') throw new DmpError('invalid-params')
  // DMP paths use '/'. Reject Windows syntax on every OS before touching any
  // native file method, so a macOS-tested client cannot become a Windows escape.
  if (value.includes('\0') || value.includes('\\') || isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) throw new DmpError('forbidden-path')
  return value || '.'
}

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function budget<T extends DmpObject>(result: T): T {
  if (size(result) > RESULT_LIMIT) throw new DmpError('too-large', 'Result exceeds the text frame limit', { limit: TEXT_LIMIT })
  return result
}

export class FileProjection {
  constructor(private access: FileProjectionAccess) {}

  private allowed(path: string, home: string, root?: string): void {
    // Check both configured and real home paths: a home can itself be a symlink.
    // This deny rule also wins over the declared-deliverable workspace exception.
    if (within(home, path) || within(resolve(this.access.home), path) || root !== undefined && !within(root, path)) throw new DmpError('forbidden-path')
  }

  private async target(sessionId: string, input: unknown, signal: AbortSignal): Promise<FileTarget> {
    const path = requestedPath(input)
    const session = await this.access.session(sessionId, signal)
    if (!session.cwd || !isAbsolute(session.cwd)) throw new DmpError('dsh-incompatible', 'Session has no workspace root')
    try {
      signal.throwIfAborted()
      const home = await realpath(this.access.home), root = await realpath(session.cwd), requested = resolve(root, path)
      this.allowed(requested, home, root)
      const absolute = await realpath(requested)
      this.allowed(absolute, home, root)
      return { path, requested, absolute, home, root, rootPath: session.cwd, stats: await lstat(requested) }
    } catch (error) { return fileError(error) }
  }

  private async declaredTarget(cwd: string, path: string): Promise<FileTarget> {
    try {
      const home = await realpath(this.access.home), requested = resolve(cwd, path)
      this.allowed(requested, home)
      const absolute = await realpath(requested)
      this.allowed(absolute, home)
      return { path, requested, absolute, home, stats: await lstat(requested) }
    } catch (error) { return fileError(error) }
  }

  private async recheck(target: FileTarget): Promise<void> {
    try {
      const home = await realpath(this.access.home)
      const [requested, absolute, root] = await Promise.all([
        realpath(target.requested), realpath(target.absolute), target.rootPath ? realpath(target.rootPath) : undefined,
      ])
      if (home !== target.home || requested !== target.absolute || absolute !== target.absolute || root !== target.root) throw new DmpError('forbidden-path')
      this.allowed(requested, home, root)
    } catch { throw new DmpError('forbidden-path', 'File path changed during the operation') }
  }

  private async guardedCall(method: string, sessionId: string, target: FileTarget, extra: DmpObject, signal: AbortSignal): Promise<DmpObject> {
    // Native reads reopen a pathname. Verify resolution again before releasing
    // anything to DMP, including metadata, and discard results after a swap.
    try { return await this.call(method, sessionId, target.absolute, extra, signal) }
    finally { await this.recheck(target) }
  }

  private async call(method: string, sessionId: string, path: string, extra: DmpObject, signal: AbortSignal): Promise<DmpObject> {
    try { return object(await this.access.call('workspaceFiles', method, { workspaceFileScopeId: sessionId, path, ...extra }, signal)) }
    catch (error) { return fileError(error) }
  }

  async request(method: string, params: DmpObject, signal: AbortSignal): Promise<DmpObject> {
    signal.throwIfAborted()
    if (method.startsWith('changes.')) return this.changes(method, params, signal)
    if (method === 'deliverables.list') {
      const sessionId = string(params.sessionId), session = await this.access.session(sessionId, signal)
      return budget({ deliverables: events(session).filter(event => event.type === 'deliverables/presented').flatMap(event => array(object(event.data).files).flatMap((raw, index) => {
        const file = object(raw), path = string(file.path)
        if (!path) return []
        return [{ deliverableId: deliverableId(sessionId, integer(event.seq), index), name: basename(path.replaceAll('\\', '/')), path, ...(typeof file.description === 'string' ? { description: file.description } : {}), turn: integer(object(event.data).turn), presentedAt: new Date(typeof event.time === 'number' || typeof event.time === 'string' ? event.time : 0).toISOString() }]
      })) })
    }
    if (!['files.list', 'files.read', 'files.stat'].includes(method)) throw new DmpError('unsupported')
    const sessionId = string(params.sessionId), target = await this.target(sessionId, params.path, signal)
    if (method === 'files.list') {
      const result = await this.guardedCall('list', sessionId, target, {}, signal)
      return budget({ path: target.path, entries: array(result.entries).map(raw => {
        const entry = object(raw)
        return { name: string(entry.name), type: ['file', 'dir', 'symlink', 'other'].includes(string(entry.type)) ? entry.type : 'other', ...(typeof entry.size === 'number' ? { size: integer(entry.size) } : {}) }
      }), truncated: Boolean(result.truncated) })
    }
    if (method === 'files.stat') {
      // Native stat exposes only file versions. Directories and symlinks still
      // have useful DMP stat results; their opaque version describes that node.
      const result = target.stats.isFile() ? await this.guardedCall('stat', sessionId, target, {}, signal) : {}
      await this.recheck(target)
      return { type: kind(target.stats), size: target.stats.size, version: string(result.version) || `${target.stats.dev}:${target.stats.ino}:${target.stats.mtimeMs}:${target.stats.size}` }
    }
    // The DMP caller may request 5,000 lines, but the tested native version
    // accepts at most 2,000. A shorter page preserves the continuation contract.
    let limit = Math.min(2000, Math.max(1, integer(params.limit, 2000))), offset = Math.max(1, integer(params.offset, 1))
    for (;;) {
      let native: DmpObject
      try { native = await this.guardedCall('read', sessionId, target, { range: { offset, limit } }, signal) }
      catch (error) {
        if (error instanceof DmpError && error.code === 'too-large' && limit > 1) { limit = Math.max(1, Math.floor(limit / 2)); continue }
        if (error instanceof DmpError && error.code === 'too-large') throw new DmpError('too-large', 'A line exceeds the text frame limit', { limit: TEXT_LIMIT })
        throw error
      }
      const result = { path: target.path, text: string(native.text), offset: integer(native.offset, offset), lines: integer(native.lines), eof: Boolean(native.eof), version: string(native.version) }
      if (size(result) <= RESULT_LIMIT) return result
      // Retry the native line read, rather than slicing text and losing line or
      // EOF semantics. JSON escapes count against the frame budget too.
      if (result.lines <= 1 || limit <= 1) throw new DmpError('too-large', 'A line exceeds the text frame limit', { limit: TEXT_LIMIT })
      limit = Math.max(1, Math.min(limit - 1, Math.floor(result.lines / 2)))
    }
  }

  async content(method: string, params: DmpObject, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    let sessionId: string, target: FileTarget
    if (method === 'files.download') {
      sessionId = string(params.sessionId)
      target = await this.target(sessionId, params.path, signal)
    } else if (method === 'deliverables.download') {
      const match = /^d\.([A-Za-z0-9_-]+)\.(\d+)\.(\d+)$/.exec(string(params.deliverableId))
      if (!match) throw new DmpError('not-found')
      sessionId = Buffer.from(match[1], 'base64url').toString('utf8')
      const seq = Number(match[2]), index = Number(match[3])
      if (!sessionId || !Number.isSafeInteger(seq) || !Number.isSafeInteger(index) || deliverableId(sessionId, seq, index) !== params.deliverableId) throw new DmpError('not-found')
      const session = await this.access.session(sessionId, signal)
      const event = events(session).find(event => event.seq === seq && event.type === 'deliverables/presented')
      const declared = string(object(array(object(event?.data).files)[index]).path)
      if (!declared) throw new DmpError('not-found')
      target = await this.declaredTarget(session.cwd, declared)
    } else throw new DmpError('unsupported')
    try {
      const stats = method === 'files.download' ? await lstat(target.absolute) : target.stats
      if (!stats.isFile()) throw new DmpError('not-found')
      if (stats.size > DOWNLOAD_LIMIT) throw new DmpError('too-large', 'File exceeds the transfer limit', { limit: DOWNLOAD_LIMIT })
      const result = await this.guardedCall('readBytes', sessionId, target, { options: {} }, signal)
      if (!(result.data instanceof Uint8Array)) throw new DmpError('dsh-incompatible', 'Native file bytes are unavailable')
      if (result.data.byteLength > DOWNLOAD_LIMIT) throw new DmpError('too-large', 'File exceeds the transfer limit', { limit: DOWNLOAD_LIMIT })
      if (result.eof !== true) throw new DmpError('dsh-incompatible', 'Native full-file read returned partial bytes')
      return result.data
    } catch (error) { return fileError(error) }
  }

  private async changeFetch(route: string, sessionId: string, seq: number, signal: AbortSignal, index?: number): Promise<DmpObject> {
    const url = new URL(`/api/${route}`, 'http://localhost')
    url.search = new URLSearchParams({ sessionId, seq: String(seq), ...(index !== undefined ? { index: String(index) } : {}) }).toString()
    let response: Response
    try { response = await this.access.fetch(new Request(url, { signal })) } catch (error) { return fileError(error) }
    if (response.status === 404) {
      this.access.changeState?.(sessionId, seq, { available: false })
      throw new DmpError('expired', 'Changed-file snapshot is no longer available')
    }
    if (response.status === 400) throw new DmpError('invalid-params')
    if (!response.ok) throw new DmpError('dsh-unavailable', 'Changed-file snapshot could not be read')
    return object(await response.json())
  }

  private async changes(method: string, params: DmpObject, signal: AbortSignal): Promise<DmpObject> {
    const sessionId = string(params.sessionId), session = await this.access.session(sessionId, signal)
    const match = /^change-(\d+)$/.exec(string(params.changeId)), seq = match ? Number(match[1]) : -1
    if (!Number.isSafeInteger(seq) || !events(session).some(event => event.seq === seq && event.type === 'workspace/changes')) throw new DmpError('not-found')
    const summary = await this.changeFetch('changes.summary', sessionId, seq, signal), files = array(summary.files).map(object)
    this.access.changeState?.(sessionId, seq, { available: true, fileCount: files.length, added: integer(summary.added), deleted: integer(summary.deleted) })
    if (method === 'changes.summary') {
      const projected: DmpObject[] = []
      for (let index = 0; index < files.length; index++) {
        const file = files[index], diff = await this.changeFetch('changes.diff', sessionId, seq, signal, index)
        projected.push({ index, path: string(file.path), display: string(file.display || file.path).replaceAll('\\', '/'), status: diff.before === false ? 'added' : diff.after === false ? 'deleted' : 'modified', added: integer(file.added), deleted: integer(file.deleted) })
      }
      return budget({ files: projected, added: integer(summary.added), deleted: integer(summary.deleted) })
    }
    if (method !== 'changes.diff') throw new DmpError('unsupported')
    const index = integer(params.index, -1)
    if (index < 0 || index >= files.length) throw new DmpError('not-found')
    const native = await this.changeFetch('changes.diff', sessionId, seq, signal, index), path = string(native.path)
    if (native.kind === 'binary' || native.kind === 'oversized') return { diff: { kind: native.kind, path } }
    if (native.kind !== 'text') throw new DmpError('dsh-incompatible', 'Unknown changed-file comparison')
    return budget({ diff: { kind: 'text', path, hunks: array(native.hunks).map(raw => {
      const hunk = object(raw)
      return { oldStart: integer(hunk.oldStart), oldLines: integer(hunk.oldLines), newStart: integer(hunk.newStart), newLines: integer(hunk.newLines), lines: array(hunk.lines).map(string) }
    }), coarse: Boolean(native.coarse) } })
  }
}
