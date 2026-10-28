import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Uploads } from '../lib/server/uploads.js'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const binary = (id, bytes, final = true) => { const header = Buffer.alloc(5); header.writeUInt32BE(id); header[4] = final ? 1 : 0; return Buffer.concat([header, bytes]) }
function setup() {
  const sent = [], committed = []; let streamId = 0
  const uploads = new Uploads(() => ++streamId, frame => sent.push(frame), async (...args) => { committed.push(args); return { attachmentId: 'attachment' } })
  return { uploads, sent, committed, begin(bytes, overrides = {}) { return uploads.begin({ sessionId: 'session', name: 'sample.bin', mime: 'application/octet-stream', size: bytes.length, sha256: hash(bytes), ...overrides }) } }
}

test('upload validates exact bytes before native commit and acknowledges every chunk', async () => {
  const state = setup(), bytes = Buffer.from('exact upload bytes'), upload = state.begin(bytes)
  try {
    state.uploads.receive(binary(upload.streamId, bytes.subarray(0, 4), false), 262144)
    await assert.rejects(state.uploads.finish(upload.uploadId, new AbortController().signal), { code: 'invalid-params' })
    assert.equal(state.committed.length, 0)
    state.uploads.receive(binary(upload.streamId, bytes.subarray(4)), 262144)
    assert.deepEqual(state.sent.map(frame => frame.bytes), [4, bytes.length])
    assert.deepEqual(await state.uploads.finish(upload.uploadId, new AbortController().signal), { attachmentId: 'attachment' })
    assert.deepEqual(state.committed[0].slice(0, 4), ['session', 'sample.bin', 'application/octet-stream', bytes])
    await assert.rejects(state.uploads.finish(upload.uploadId, new AbortController().signal), { code: 'not-found' })
  } finally { state.uploads.dispose() }
})

test('hash mismatch, short final and explicit abort never reach native upload', async () => {
  const state = setup(), bytes = Buffer.from('data')
  try {
    for (const overrides of [{ sha256: '0'.repeat(64) }, { size: bytes.length + 1 }]) {
      const upload = state.begin(bytes, overrides); state.uploads.receive(binary(upload.streamId, bytes), 262144)
      await assert.rejects(state.uploads.finish(upload.uploadId, new AbortController().signal), { code: 'invalid-params' })
    }
    const upload = state.begin(bytes); state.uploads.abort(upload.streamId)
    await assert.rejects(state.uploads.finish(upload.uploadId, new AbortController().signal), { code: 'not-found' })
    assert.equal(state.committed.length, 0)
  } finally { state.uploads.dispose() }
})

test('upload allocation and framing have bounded limits', () => {
  const state = setup(), bytes = Buffer.from('data')
  try {
    assert.throws(() => state.begin(bytes, { size: 32 * 1024 * 1024 + 1 }), { code: 'too-large' })
    assert.throws(() => state.begin(bytes, { mime: 'image/png', size: 20 * 1024 * 1024 + 1 }), { code: 'too-large', details: { limit: 20 * 1024 * 1024 } })
    const upload = state.begin(bytes)
    assert.throws(() => state.uploads.receive(binary(upload.streamId, Buffer.alloc(5)), 262144), { code: 'bad-frame' })
    assert.throws(() => state.uploads.receive(binary(upload.streamId, bytes), 3), { code: 'bad-frame' })
    assert.throws(() => state.uploads.receive(binary(100, bytes), 262144), { code: 'bad-frame' })
    const invalid = binary(upload.streamId, bytes); invalid[4] = 3
    assert.throws(() => state.uploads.receive(invalid, 262144), { code: 'bad-frame' })
    state.begin(bytes); state.begin(bytes)
    assert.throws(() => state.begin(bytes), { code: 'busy' })
  } finally { state.uploads.dispose() }
})
