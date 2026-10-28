import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { foldRecording } from './fold-recording.mjs';
import { eventValidators } from '../../../protocol/scripts/contract.mjs';

const root = resolve(import.meta.dirname, '../../../protocol/fixtures');
const fixtures = new Map();
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = resolve(root, entry.name);
  const raw = await readFile(resolve(directory, 'raw.jsonl'), 'utf8');
  const records = raw.trim().split('\n').map(JSON.parse);
  const metadata = JSON.parse(await readFile(resolve(directory, 'metadata.json'), 'utf8'));
  const expectedBytes = await readFile(resolve(directory, 'expected.json'), 'utf8');
  const expected = JSON.parse(expectedBytes);
  fixtures.set(entry.name, { directory, raw, records, metadata, expected, expectedBytes });
}
const events = fixture => fixture.expected.frames.map(entry => entry.frame).filter(frame => frame.t === 'ev');
const finalItems = fixture => new Map(events(fixture).filter(frame => frame.kind === 'timeline.upsert').map(frame => [frame.data.item.itemId, frame.data.item]));

test('all eight native recordings fold deterministically to their golden DMP transcripts', () => {
  assert.equal(fixtures.size, 8);
  for (const fixture of fixtures.values()) {
    const folded = foldRecording(fixture.records, fixture.metadata);
    assert.deepEqual(folded.transcript, fixture.expected);
    assert.equal(JSON.stringify(folded.transcript, null, 2) + '\n', fixture.expectedBytes, 'Golden serialized DMP bytes match');
    assert.deepEqual(folded.replay, fixture.metadata.replay);
    assert.deepEqual(folded.mock, fixture.metadata.mock);
    const snapshot = fixture.records.find(record => record.frame.type === 'snapshot').frame;
    let seq = snapshot.cursor;
    for (const record of fixture.records) if (record.source === 'session' && record.frame.type === 'event') assert.equal(record.frame.event.seq, ++seq, 'Native session sequence is contiguous');
    assert.ok(events(fixture).some(frame => frame.kind === 'timeline.delta'));
    let checkpoint = snapshot.cursor;
    for (const frame of events(fixture).filter(frame => frame.kind === 'timeline.upsert')) {
      assert.ok(frame.data.throughSeq >= checkpoint, 'Durable checkpoint never regresses');
      checkpoint = frame.data.throughSeq;
    }
  }
});

test('only real human input becomes a user bubble; injected context and machine paths are removed', () => {
  for (const fixture of fixtures.values()) {
    assert.doesNotMatch(fixture.raw, /\/Users\/|\/Applications\/|\/private\/|\/var\/folders\/|\.credentials\.yaml|Bearer\s|sk-[A-Za-z0-9]{16}/);
    const native = fixture.records.filter(record => record.frame.type === 'event' && record.frame.event.type === 'user/message').map(record => record.frame.event.data);
    const human = native.filter(message => message.source?.kind === 'user');
    const projected = [...finalItems(fixture).values()].filter(item => item.kind === 'user_message');
    assert.equal(projected.length, human.length);
    assert.ok(projected.every(item => item.text.startsWith('SPIKE_')));
    for (const message of native.filter(message => message.source?.kind !== 'user')) {
      assert.deepEqual(Object.keys(message.source), ['kind']);
      assert.deepEqual(message.content, [{ type: 'text', text: '[redacted runtime context]' }]);
    }
  }
});

test('recorded approval branches keep role IDs and exhibit real execution versus refusal', async () => {
  const allow = fixtures.get('tools-allow'), deny = fixtures.get('tools-deny');
  for (const fixture of [allow, deny]) {
    const items = [...finalItems(fixture).values()];
    assert.ok(items.some(item => item.kind === 'tool_call' && item.tool.kind === 'read' && item.status === 'succeeded'));
    assert.ok(items.some(item => item.kind === 'tool_call' && item.tool.kind === 'edit' && item.status === 'succeeded'));
    assert.ok(items.some(item => item.kind === 'changes' && item.available && item.fileCount === 1));
    const opening = events(fixture).find(frame => frame.kind === 'interaction.open').data.interaction;
    assert.equal(opening.interactionId, 'interaction-1'); assert.equal(opening.toolCallId, 'call-3'); assert.equal(opening.blocking, true);
    assert.ok((await readFile(resolve(fixture.directory, 'workspace/download.txt'))).byteLength > 131072);
  }
  const allowed = finalItems(allow).get('tool-call-3'), denied = finalItems(deny).get('tool-call-3');
  assert.equal(allowed.status, 'succeeded'); assert.equal(allowed.output.text, 'DSHM_SPIKE_APPROVAL_FIXTURE\n');
  assert.equal(denied.status, 'denied'); assert.equal(denied.output.isError, true); assert.doesNotMatch(denied.output.text, /DSHM_SPIKE_APPROVAL_FIXTURE/);
});

test('question, cancellation, model change, deliverable, and retained background output survive projection', () => {
  const question = fixtures.get('question');
  assert.equal(events(question).find(frame => frame.kind === 'interaction.open').data.interaction.questions[0].questionId, 'fixture-choice');
  const interrupted = fixtures.get('interrupt-queue');
  assert.ok([...finalItems(interrupted).values()].some(item => item.kind === 'assistant_message' && item.state === 'cancelled'));
  assert.equal(events(interrupted).filter(frame => frame.kind === 'queue.update').at(-1).data.queue[0].text, 'SPIKE_TEXT queued after interruption');
  const changed = fixtures.get('model-change');
  assert.equal(events(changed).filter(frame => frame.kind === 'session.update').at(-1).data.session.summary.model.model, 'fixture-alt');
  assert.ok([...finalItems(fixtures.get('deliverable')).values()].some(item => item.kind === 'deliverables' && item.deliverables[0].path === 'fixture-change.txt'));
  const jobs = fixtures.get('background-job');
  const output = events(jobs).filter(frame => frame.kind === 'job.output').flatMap(frame => frame.data.chunks).map(chunk => chunk.text).join('');
  assert.equal(output, 'DSHM_SPIKE_JOB_START\nDSHM_SPIKE_JOB_END\n');
  assert.equal(events(jobs).filter(frame => frame.kind === 'job.status').at(-1).data.job.status, 'completed');
});

const liveMetadata = { live: true, scenario: 'live', sessionId: 'session-test', title: null, recordedAt: '2026-10-26T00:00:00Z', summary: { model: { provider: 'fixture', model: 'fixture' }, sessionId: 'session-test', title: null, status: 'idle', pendingInteractions: 0, updatedAt: '2026-10-26T00:00:00Z', archived: false, pinned: false } };
const { createProjectionFold } = await import('./fold-recording.mjs');

test('live streaming and durable-only reconstruction keep assistant identity and display order', () => {
  for (const name of ['qa', 'interrupt-queue']) {
    const fixture = fixtures.get(name);
    const live = createProjectionFold(liveMetadata), restored = createProjectionFold(liveMetadata);
    for (const record of fixture.records) {
      if (record.source !== 'session') continue;
      live.accept(record);
      if (record.frame.type === 'event') restored.accept(record);
    }
    const messages = fold => fold.state().items.filter(item => item.kind === 'assistant_message').map(({ itemId, order, seq, text, state }) => ({ itemId, order, seq, text, state }));
    assert.deepEqual(messages(live), messages(restored), name);
  }
});

test('live reasoning and text settle separately with UTF-8 byte caps and full content retained', () => {
  const fold = createProjectionFold(liveMetadata);
  const accept = frame => fold.accept({ source: 'session', frame, atMs: 0 });
  accept({ type: 'event', event: { type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } } });
  accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt', turn: 1, step: 1, startedAfterSeq: 0 } });
  const reasoning = 'Reasoning 中文. '.repeat(25000), text = 'Answer 中文. '.repeat(30000);
  accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', chunk: { type: 'reasoning-delta', text: reasoning } } });
  accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', chunk: { type: 'text-delta', text } } });
  const result = accept({ type: 'event', event: { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }] }, stream: [{ type: 'chunk', time: 1, chunk: { type: 'block-start', blockType: 'reasoning' } }] } } });
  const state = fold.state();
  assert.equal(state.items.length, 2);
  assert.deepEqual(state.items.map(i => i.kind), ['reasoning', 'assistant_message']);
  assert.deepEqual(state.items.map(i => i.text), [reasoning, text]);
  for (const item of state.inlineItems) {
    assert.equal(item.state, 'complete'); assert.ok(Buffer.byteLength(item.text) <= 262144);
    assert.equal(eventValidators['timeline.upsert']({ item, throughSeq: 1 }), true, JSON.stringify(eventValidators['timeline.upsert'].errors));
    assert.ok(item.truncated.totalBytes > 262144); assert.ok(!item.text.endsWith('\uFFFD'));
  }
  const updates = result.filter(entry => entry.frame.kind === 'timeline.upsert');
  assert.equal(updates[0].frame.data.throughSeq, 0);
  assert.equal(updates[1].frame.data.throughSeq, 1);
});

test('live cancellation removes pending interaction and surface replacement records a tombstone', () => {
  const fold = createProjectionFold(liveMetadata);
  const event = value => fold.accept({ source: 'session', frame: { type: 'event', event: value }, atMs: 0 });
  event({ type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'original' }] }, surfaceOp: 'append' });
  event({ type: 'tool/call', seq: 1, time: 2, data: { callId: 'call', name: 'bash', arguments: '{}' } });
  fold.accept({ source: 'interaction', frame: { type: 'waterfall', event: 'approval/request', eventId: 'interaction', request: { callId: 'call' } }, atMs: 0 });
  assert.equal(fold.state().interactions.length, 1);
  fold.accept({ source: 'interaction', frame: { type: 'cancel', eventId: 'interaction' }, atMs: 0 });
  assert.equal(fold.state().interactions.length, 0);
  assert.equal(fold.state().session.summary.pendingInteractions, 0);
  event({ type: 'developer/message', seq: 2, time: 3, data: {}, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] });
  assert.ok(!fold.state().items.some(i => i.itemId === 'user-0'));
  assert.deepEqual(fold.state().removed, [['user-0', 2]]);
});

test('live native job registration, permissions, deliverable IDs and attachments keep their durable identity', () => {
  const fold = createProjectionFold(liveMetadata);
  const event = (type, seq, data) => fold.accept({ source: 'session', frame: { type: 'event', event: { type, seq, time: seq + 1, data } }, atMs: 0 });
  event('tool/call', 0, { callId: 'call', name: 'bash', arguments: '{"run_in_background":true}' });
  assert.equal(fold.state().items[0].jobId, undefined);
  event('job/registered', 1, { jobId: 'bash-real', toolCall: { callId: 'call' } });
  assert.equal(fold.state().items[0].jobId, 'bash-real');
  assert.deepEqual(fold.state().items[0].order, { seq: 0, index: 0 });
  event('permission/preset', 2, { preset: 'workspace-write' });
  assert.equal(fold.state().session.permission.current, 'workspace-write');
  event('deliverables/presented', 3, { files: [{ path: '/fixture/workspace/report.txt' }] });
  assert.equal(fold.state().items.find(item => item.kind === 'deliverables').deliverables[0].deliverableId, 'd.c2Vzc2lvbi10ZXN0.3.0');
  event('user/message', 4, { source: { kind: 'user' }, content: [{ type: 'image', attachment: { name: 'photo.png', mediaType: 'image/png', bytes: 68 } }, { type: 'file', attachment: { name: 'notes.txt', bytes: 12 } }] });
  const user = fold.state().items.find(item => item.kind === 'user_message');
  assert.equal(user.text, '');
  assert.deepEqual(user.attachments, [{ name: 'photo.png', mime: 'image/png', size: 68 }, { name: 'notes.txt', size: 12 }]);
  event('workspace/changes', 5, { turn: 1 });
  fold.accept({ source: 'change-state', frame: { seq: 5, available: true, fileCount: 2, added: 3, deleted: 1 }, atMs: 0 });
  assert.equal(fold.state().items.find(item => item.kind === 'changes').available, true);
  fold.accept({ source: 'change-state', frame: { seq: 5, available: false }, atMs: 0 });
  const changes = fold.state().items.find(item => item.kind === 'changes');
  assert.equal(changes.available, false);
  assert.equal(changes.fileCount, 2);
  event('tool/result', 6, { message: { toolCallId: 'call', content: [{ type: 'text', text: 'first marker\nfinal marker\n' }], isError: false } });
  const tool = fold.state().items.find(item => item.kind === 'tool_call');
  assert.equal(tool.jobId, 'bash-real');
  assert.equal(tool.output.text, 'first marker\nfinal marker\n');
  assert.equal(tool.status, 'succeeded');
  assert.deepEqual(tool.order, { seq: 0, index: 0 });
  for (const item of fold.state().inlineItems) assert.equal(eventValidators['timeline.upsert']({ item, throughSeq: 6 }), true, JSON.stringify(eventValidators['timeline.upsert'].errors));
});
