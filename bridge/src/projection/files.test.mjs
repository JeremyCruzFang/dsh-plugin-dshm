import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, rename, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileProjection } from '../../lib/projection/files.js'

const signal = () => AbortSignal.timeout(10000)
const event = (type, seq, data) => ({ source: 'session', frame: { type: 'event', event: { type, seq, time: 1000, data } }, atMs: 0 })

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dshm-files-')), cwd = join(root, 'workspace'), home = join(root, 'test-home')
  await mkdir(cwd); await mkdir(home)
  await writeFile(join(cwd, 'inside.txt'), 'one\ntwo\nthree')
  await writeFile(join(root, 'outside.txt'), 'explicitly declared outside content')
  await symlink(join(root, 'outside.txt'), join(cwd, 'escape'))
  await symlink(join(root), join(cwd, 'escape-dir'))
  await symlink(join(cwd, 'inside.txt'), join(cwd, 'contained'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = [], fetches = [], records = [], changeStates = [], replies = new Map()
  const access = {
    home,
    session: async id => { if (id !== 's') throw Object.assign(new Error('not-found'), { code: 'not-found' }); return { cwd, records } },
    call: async (namespace, method, args) => {
      calls.push({ namespace, method, args })
      assert.equal(namespace, 'workspaceFiles')
      assert.equal(args.workspaceFileScopeId, 's')
      if (method === 'stat') return { version: 'native-version', bytes: (await stat(args.path)).size }
      if (method === 'list') return { path: '', entries: [{ name: 'inside.txt', type: 'file', size: 13 }], truncated: false }
      const data = await readFile(args.path)
      if (method === 'readBytes') return { data, version: 'native-version', eof: true }
      let text
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); if (text.includes('\0')) throw Error('nul') }
      catch { throw Object.assign(new Error('not-text'), { code: 'workspace-file/not-text' }) }
      const lines = text.split('\n'), { offset, limit } = args.range
      return { text: lines.slice(offset - 1, offset - 1 + limit).join('\n'), offset, lines: lines.slice(offset - 1, offset - 1 + limit).length, eof: offset - 1 + limit >= lines.length, version: 'native-version' }
    },
    fetch: async request => {
      const url = new URL(request.url); fetches.push(url)
      return replies.get(url.pathname)?.clone() ?? new Response('', { status: 404 })
    },
    changeState: (sessionId, seq, state) => changeStates.push({ sessionId, seq, ...state }),
  }
  return { root, cwd, home, access, calls, fetches, records, replies, changeStates, projection: new FileProjection(access) }
}

test('files reject traversal, absolute, drive and UNC syntax before native file access', async t => {
  const { cwd, calls, projection } = await fixture(t)
  for (const path of ['..', '../outside.txt', 'inside/../inside.txt', join(cwd, 'inside.txt'), 'C:\\outside.txt', 'C:/outside.txt', 'C:outside.txt', '\\\\server\\share\\file', '//server/share/file', '\\?\\C:\\file', 'escape', 'escape-dir/outside.txt']) {
    for (const method of ['files.list', 'files.read', 'files.stat', 'files.download']) {
      const operation = method === 'files.download' ? projection.content.bind(projection) : projection.request.bind(projection)
      await assert.rejects(operation(method, { sessionId: 's', path }, signal()), { code: 'forbidden-path' }, `${method}: ${path}`)
    }
  }
  assert.equal(calls.length, 0)
})

test('files preserve line paging, native versions, stat kinds and safe contained symlinks', async t => {
  const { projection } = await fixture(t)
  assert.deepEqual(await projection.request('files.list', { sessionId: 's', path: '.' }, signal()), { path: '.', entries: [{ name: 'inside.txt', type: 'file', size: 13 }], truncated: false })
  assert.deepEqual(await projection.request('files.read', { sessionId: 's', path: 'inside.txt', offset: 2, limit: 1 }, signal()), { path: 'inside.txt', text: 'two', offset: 2, lines: 1, eof: false, version: 'native-version' })
  assert.deepEqual(await projection.request('files.stat', { sessionId: 's', path: 'inside.txt' }, signal()), { type: 'file', size: 13, version: 'native-version' })
  assert.equal((await projection.request('files.stat', { sessionId: 's', path: '.' }, signal())).type, 'dir')
  assert.equal((await projection.request('files.stat', { sessionId: 's', path: 'contained' }, signal())).type, 'symlink')
  assert.equal(Buffer.from(await projection.content('files.download', { sessionId: 's', path: 'contained' }, signal())).toString(), 'one\ntwo\nthree')
})

test('files text pages fit serialized JSON including escapes; binary and huge lines fail explicitly', async t => {
  const { cwd, calls, projection } = await fixture(t)
  const line = '\t'.repeat(1000)
  await writeFile(join(cwd, 'escapes.txt'), Array(2000).fill(line).join('\n'))
  const page = await projection.request('files.read', { sessionId: 's', path: 'escapes.txt' }, signal())
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024 - 1024)
  assert.ok(page.lines > 0 && page.lines < 2000)
  assert.equal(page.eof, false)
  assert.ok(calls.filter(call => call.method === 'read').length > 1)
  const next = await projection.request('files.read', { sessionId: 's', path: 'escapes.txt', offset: page.offset + page.lines }, signal())
  assert.equal(next.offset, page.lines + 1)
  assert.equal(next.text.split('\n').length, next.lines)
  await writeFile(join(cwd, 'invalid.txt'), Buffer.from([0xc0, 0xff]))
  await writeFile(join(cwd, 'nul.txt'), Buffer.from([0x61, 0, 0x62]))
  for (const path of ['invalid.txt', 'nul.txt']) await assert.rejects(projection.request('files.read', { sessionId: 's', path }, signal()), { code: 'invalid-params', details: { reason: 'not-text' } })
  await writeFile(join(cwd, 'huge-line.txt'), '\t'.repeat(600000))
  await assert.rejects(projection.request('files.read', { sessionId: 's', path: 'huge-line.txt' }, signal()), { code: 'too-large', details: { limit: 1048576 } })
})

test('a DMP 5000-line request returns a valid shorter page within the native 2000-line cap', async t => {
  const { cwd, calls, projection } = await fixture(t)
  await writeFile(join(cwd, 'many-lines.txt'), Array.from({ length: 3500 }, (_, index) => `line ${index + 1}`).join('\n'))
  const first = await projection.request('files.read', { sessionId: 's', path: 'many-lines.txt', limit: 5000 }, signal())
  assert.equal(calls.at(-1).args.range.limit, 2000)
  assert.equal(first.lines, 2000)
  assert.equal(first.eof, false)
  const second = await projection.request('files.read', { sessionId: 's', path: 'many-lines.txt', offset: first.offset + first.lines, limit: 5000 }, signal())
  assert.equal(second.lines, 1500)
  assert.equal(second.eof, true)
  assert.equal(second.text.split('\n')[0], 'line 2001')
})

test('binary downloads preserve bytes and reject missing, directories and files over 32 MiB', async t => {
  const { cwd, calls, projection } = await fixture(t)
  const bytes = Buffer.from([0, 255, 12, 80])
  await writeFile(join(cwd, 'bytes'), bytes)
  assert.deepEqual(Buffer.from(await projection.content('files.download', { sessionId: 's', path: 'bytes' }, signal())), bytes)
  for (const path of ['missing', '.']) await assert.rejects(projection.content('files.download', { sessionId: 's', path }, signal()), { code: 'not-found' })
  await writeFile(join(cwd, 'large'), '')
  await truncate(join(cwd, 'large'), 32 * 1024 * 1024 + 1)
  const before = calls.length
  await assert.rejects(projection.content('files.download', { sessionId: 's', path: 'large' }, signal()), { code: 'too-large', details: { limit: 33554432 } })
  assert.equal(calls.length, before)
})

test('deliverable IDs resolve only durable declarations, permit declared outside files and fetch current bytes', async t => {
  const { root, cwd, records, projection } = await fixture(t)
  records.push(event('deliverables/presented', 11, { turn: 2, files: [{ path: join(root, 'outside.txt'), description: 'outside' }, { path: 'inside.txt' }] }))
  const listed = await projection.request('deliverables.list', { sessionId: 's' }, signal())
  assert.equal(listed.deliverables.length, 2)
  assert.equal(listed.deliverables[0].deliverableId, 'd.cw.11.0')
  assert.equal(listed.deliverables[0].presentedAt, '1970-01-01T00:00:01.000Z')
  assert.equal(Buffer.from(await projection.content('deliverables.download', { deliverableId: 'd.cw.11.0' }, signal())).toString(), 'explicitly declared outside content')
  await writeFile(join(root, 'outside.txt'), 'changed now')
  assert.equal(Buffer.from(await projection.content('deliverables.download', { deliverableId: 'd.cw.11.0' }, signal())).toString(), 'changed now')
  assert.equal(Buffer.from(await projection.content('deliverables.download', { deliverableId: 'd.cw.11.1' }, signal())).toString(), 'one\ntwo\nthree')
  for (const deliverableId of ['d.cw.11.2', 'd.cw.12.0', 'd.cw.011.0', join(root, 'outside.txt')]) await assert.rejects(projection.content('deliverables.download', { deliverableId }, signal()), { code: 'not-found' })
  await rm(join(root, 'outside.txt'))
  await assert.rejects(projection.content('deliverables.download', { deliverableId: 'd.cw.11.0' }, signal()), { code: 'not-found' })
  await symlink(join(cwd, 'inside.txt'), join(root, 'outside.txt'))
  await assert.rejects(projection.content('deliverables.download', { deliverableId: 'd.cw.11.0' }, signal()), { code: 'not-found' })
})

test('changes use declared snapshot coordinates, project exact fields, and expire missing native snapshots', async t => {
  const { records, replies, fetches, changeStates, projection } = await fixture(t)
  records.push(event('workspace/changes', 42, { turn: 1 }))
  replies.set('/api/changes.summary', Response.json({ turn: 1, total: 1, files: [{ path: 'new.txt', display: 'new.txt', added: 1, deleted: 0 }], added: 1, deleted: 0 }))
  replies.set('/api/changes.diff', Response.json({ kind: 'text', path: 'new.txt', display: 'new.txt', before: false, after: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }], coarse: false }))
  const params = { sessionId: 's', changeId: 'change-42' }
  assert.deepEqual(await projection.request('changes.summary', params, signal()), { files: [{ index: 0, path: 'new.txt', display: 'new.txt', status: 'added', added: 1, deleted: 0 }], added: 1, deleted: 0 })
  assert.deepEqual(changeStates.at(-1), { sessionId: 's', seq: 42, available: true, fileCount: 1, added: 1, deleted: 0 })
  assert.deepEqual(await projection.request('changes.diff', { ...params, index: 0 }, signal()), { diff: { kind: 'text', path: 'new.txt', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }], coarse: false } })
  assert.ok(fetches.every(url => url.searchParams.get('sessionId') === 's' && url.searchParams.get('seq') === '42'))
  await assert.rejects(projection.request('changes.diff', { ...params, index: 2 }, signal()), { code: 'not-found' })
  await assert.rejects(projection.request('changes.summary', { ...params, changeId: 'change-43' }, signal()), { code: 'not-found' })
  replies.clear()
  for (const method of ['changes.summary', 'changes.diff']) await assert.rejects(projection.request(method, { ...params, index: 0 }, signal()), { code: 'expired' })
  assert.deepEqual(changeStates.at(-1), { sessionId: 's', seq: 42, available: false })
})


test('DSH home is denied for nested workspaces and declared deliverables, including home symlink aliases', async t => {
  const { root, cwd, home, access, calls, records, projection } = await fixture(t)
  const nested = join(home, 'workspace'), fixtureFile = join(nested, 'synthetic-private.txt')
  await mkdir(nested); await writeFile(fixtureFile, 'synthetic protected marker')
  await symlink(home, join(root, 'home-alias'))
  access.home = join(root, 'home-alias')
  access.session = async () => ({ cwd: nested, records })
  for (const method of ['files.list', 'files.read', 'files.stat', 'files.download']) {
    const operation = method === 'files.download' ? projection.content.bind(projection) : projection.request.bind(projection)
    await assert.rejects(operation(method, { sessionId: 's', path: method === 'files.list' ? '.' : 'synthetic-private.txt' }, signal()), { code: 'forbidden-path' })
  }
  access.session = async () => ({ cwd, records })
  await symlink(fixtureFile, join(cwd, 'into-home'))
  for (const method of ['files.list', 'files.read', 'files.stat', 'files.download']) {
    const operation = method === 'files.download' ? projection.content.bind(projection) : projection.request.bind(projection)
    await assert.rejects(operation(method, { sessionId: 's', path: 'into-home' }, signal()), { code: 'forbidden-path' })
  }
  records.push(event('deliverables/presented', 50, { turn: 1, files: [{ path: fixtureFile }, { path: join(cwd, 'into-home') }, { path: join(root, 'home-alias', 'workspace', 'synthetic-private.txt') }] }))
  for (let index = 0; index < 3; index++) await assert.rejects(projection.content('deliverables.download', { deliverableId: `d.cw.50.${index}` }, signal()), { code: 'forbidden-path' })
  assert.equal(calls.length, 0, 'protected contents never reach the native file service')
})

test('post-read checks discard native data and metadata after a path component is swapped to a symlink', async t => {
  for (const method of ['files.list', 'files.read', 'files.stat', 'files.download', 'deliverables.download']) {
    const { root, cwd, access, calls, records, projection } = await fixture(t)
    const directory = join(cwd, 'changing'), displaced = join(cwd, 'original'), outside = join(root, 'swap-outside')
    await mkdir(directory); await mkdir(outside)
    await writeFile(join(directory, 'item.txt'), 'original public content')
    await writeFile(join(outside, 'item.txt'), 'synthetic content to discard')
    records.push(event('deliverables/presented', 60, { turn: 1, files: [{ path: join(directory, 'item.txt') }] }))
    const call = access.call
    access.call = async (...args) => {
      await rename(directory, displaced); await symlink(outside, directory)
      return call(...args)
    }
    const operation = method.endsWith('.download') ? projection.content.bind(projection) : projection.request.bind(projection)
    const params = method === 'deliverables.download' ? { deliverableId: 'd.cw.60.0' } : { sessionId: 's', path: method === 'files.list' ? 'changing' : 'changing/item.txt' }
    await assert.rejects(operation(method, params, signal()), { code: 'forbidden-path' }, method)
    assert.equal(calls.length, 1, 'the native read completes but its result is discarded')
  }
})
