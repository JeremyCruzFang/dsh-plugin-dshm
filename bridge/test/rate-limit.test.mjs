import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestRateLimit } from '../lib/server/rate-limit.js'

test('request bucket permits burst 50, sustains 20/s and never accumulates more than 50', () => {
  let now = 0
  const bucket = new RequestRateLimit(() => now)
  assert.equal(Array.from({ length: 51 }, () => bucket.take()).filter(Boolean).length, 50)
  now = 49; assert.equal(bucket.take(), false)
  now = 50; assert.equal(bucket.take(), true)
  assert.equal(bucket.take(), false)
  for (let i = 0; i < 100; i++) { now += 50; assert.equal(bucket.take(), true); assert.equal(bucket.take(), false) }
  now += 100000
  assert.equal(Array.from({ length: 51 }, () => bucket.take()).filter(Boolean).length, 50)
})
