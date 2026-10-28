// This adapter is deliberately the only layer that interprets native records.
// The recorder driver, fixtures, mock host, and clients exchange DMP afterwards.
import { deliverableId } from './ids.mjs';
const utf8 = (text, limit) => { const bytes = Buffer.from(text); let end = Math.min(bytes.length, limit); while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; return bytes.subarray(0, end).toString('utf8'); };
const iso = value => new Date(typeof value === 'number' ? value : value ?? 0).toISOString();
const textOf = message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const relative = value => value?.replace(/^\/fixture\/workspace\/?/, '') || '.';
const kindOf = name => ({ bash: 'shell', write: 'edit', read: 'read', ask_user_question: 'question', present: 'present' }[name] ?? 'other');
const modelOf = native => ({ provider: native.provider, model: native.model, ...(native.reasoningEffort ? { effort: native.reasoningEffort } : {}) });

export function createProjectionFold(metadata, options = {}) {
  const records = options.relatedRecords ?? [];
  const settled = options.settled ?? new Map();
  const frames = [], replay = [], mock = { files: [{ path: 'fixture-change.txt', mime: 'text/plain' }], changes: [], jobs: [], jobOutput: [] };
  if (metadata.scenario.startsWith('tools-')) mock.files.push({ path: 'download.txt', mime: 'text/plain' });
  const push = (from, frame, atMs = 0) => {
    if (frame.t === 'res') frame.ok = true;
    if (frame.t === 'ev') { frame.sub = frame.subId; frame.kind = frame.event; delete frame.subId; delete frame.event; }
    replay.push({ frameIndex: frames.length, delayMs: Math.max(0, atMs - previousAt) }); previousAt = atMs; frames.push({ from, frame });
  };
  let previousAt = 0, currentSeq = 0, lastTime = 0, requestId = 2;
  const subId = 'sub-session';
  const emit = (event, data, atMs) => push('server', { t: 'ev', subId, event, data }, atMs);
  const items = new Map(), calls = new Map(), attempts = new Map(), pending = new Map();
  const approvalIds = new Map();
  const removed = new Map();
  const origins = new Map();
  const activeStreams = new Map();
  const creationPositions = new Map();
  const nativeTimes = [];
  let currentQueue = [];
  const snapshot = options.snapshot;
  currentSeq = snapshot?.cursor ?? (metadata.live ? -1 : 0);
  const baselineEvents = snapshot?.records?.map(r => r.event) ?? [];
  lastTime = baselineEvents.at(-1)?.time ?? Date.parse(metadata.recordedAt);
  const summary = { sessionId: metadata.sessionId, workspaceId: 'workspace-fixture', title: metadata.title, status: 'idle', pendingInteractions: 0, updatedAt: iso(lastTime), archived: false, pinned: false, model: { provider: 'dshm-fixtures', model: 'fixture', effort: 'low' }, ...(metadata.summary ?? {}) };
  if (metadata.live && !metadata.summary?.model) delete summary.model;
  let permission = metadata.permission;
  const session = () => ({ summary: structuredClone(summary), ...(metadata.live ? { ...(metadata.cwd ? { cwd: metadata.cwd } : {}), ...(permission ? { permission: { current: permission } } : {}) } : { cwd: '/fixture/workspace', permission: { current: 'workspace-write' } }) });
  const update = at => { summary.updatedAt = iso(lastTime); emit('session.update', { session: session() }, at); };
  // Display order is fixed when an item is first created; later updates (results,
  // settlement) raise item.seq but must never move the item.
  const createdAtSeq = new Map();
  const orderOf = itemId => {
    const existing = items.get(itemId)?.order;
    if (existing) return existing;
    const seq = creationPositions.get(itemId) ?? currentSeq;
    const index = createdAtSeq.get(seq) ?? 0;
    createdAtSeq.set(seq, index + 1);
    return { seq, index };
  };
  const inline = item => {
    const value = structuredClone(item);
    if (['user_message', 'assistant_message', 'reasoning'].includes(value.kind) && Buffer.byteLength(value.text) > 262144) {
      value.truncated = { totalBytes: Buffer.byteLength(value.text) }; value.text = utf8(value.text, 262144);
    }
    if (value.kind === 'tool_call') {
      value.input.raw = utf8(value.input.raw, 8192);
      if (value.output && Buffer.byteLength(value.output.text) > 65536) {
        value.output.totalBytes = Buffer.byteLength(value.output.text); value.output.truncated = true; value.output.text = utf8(value.output.text, 65536);
      }
    }
    return value;
  };
  const upsert = (item, at) => {
    item.order = orderOf(item.itemId); items.set(item.itemId, item); removed.delete(item.itemId);
    const source = origins.get(item.itemId) ?? new Set(); source.add(currentSeq); origins.set(item.itemId, source);
    emit('timeline.upsert', { item: inline(item), throughSeq: currentSeq }, at);
  };
  const base = (id, kind, event = {}) => ({ itemId: id, seq: currentSeq, time: iso(event.time ?? lastTime), kind, ...(Number.isInteger(event.data?.turn) ? { turn: event.data.turn } : {}) });
  push('client', { t: 'req', id: 1, method: 'session.watch', params: { sessionId: metadata.sessionId } });
  push('server', { t: 'res', id: 1, result: { subId, session: session(), items: [], cursor: { throughSeq: currentSeq }, hasMoreBefore: false, resumed: false, removedItemIds: [], interactions: [], queue: [] } });
  let jobSubscribed = false, jobsSubscribed = false, lastChangeId, checkpoint = currentSeq;
  const jobOf = native => ({ jobId: 'job-1', sessionId: metadata.sessionId, title: native.label ?? 'Background shell job', status: native.status, output: native.output ?? { earliest: 0, total: 0 }, ...(native.startedAt ? { startedAt: iso(native.startedAt) } : {}), ...(native.finishedAt ? { endedAt: iso(native.finishedAt) } : {}) });
  const accept = record => {
    const recordStart = frames.length;
    const { source, frame, atMs } = record;
    if (source === 'session' && frame.type === 'event') {
      const event = frame.event, data = event.data;
      currentSeq = event.seq; lastTime = event.time;
      if (metadata.live && event.surfaceOp?.op === 'replace' && event.type !== 'tool/result') {
        const replaced = new Set(event.sourceEventSeqs ?? []);
        for (const [itemId, source] of origins) if ([...source].some(seq => replaced.has(seq) || seq >= event.surfaceOp.startSeq && seq <= event.surfaceOp.endSeq)) {
          items.delete(itemId); origins.delete(itemId); removed.set(itemId, currentSeq);
          emit('timeline.remove', { itemId, throughSeq: currentSeq }, atMs);
        }
      }
      if (metadata.live && event.type === 'agent/inbox/spliced') {
        const group = currentQueue.filter(q => q.mode === data.target);
        group.splice(data.start, data.removedCount ?? 0, ...(data.inserted ?? []).map(q => ({ queueItemId: q.id, text: textOf(q), mode: data.target })));
        currentQueue = [...currentQueue.filter(q => q.mode !== data.target), ...group];
        emit('queue.update', { queue: structuredClone(currentQueue) }, atMs);
      }
      if (metadata.live && event.type === 'session/title') { summary.title = data.title ?? data.value ?? null; update(atMs); }
      if (metadata.live && event.type === 'permission/preset') {
        permission = data.preset; update(atMs);
        upsert({ ...base(`permission-${currentSeq}`, 'notice'), level: 'info', text: `Permission selected: ${permission}`, code: 'permission-changed' }, atMs);
      }
      if (metadata.live && event.type === 'approval/asked') {
        const call = calls.get(data.callId);
        const id = `i-${metadata.sessionId}-${data.callId ?? data.id}`;
        approvalIds.set(data.id, id);
        if (call) { call.status = 'awaiting-approval'; call.seq = currentSeq; upsert(call, atMs); }
        upsert({ ...base(`interaction-${id}`, 'interaction', event), interactionId: id, interactionKind: 'approval', state: 'pending', summary: call?.title ?? data.toolName ?? 'Approval', ...(data.callId ? { toolCallId: data.callId } : {}) }, atMs);
      }
      if (metadata.live && event.type === 'approval/decided') {
        const pendingItem = items.get(`interaction-${approvalIds.get(data.id)}`);
        if (pendingItem) {
          pendingItem.seq = currentSeq; pendingItem.state = 'answered'; pendingItem.outcome = data.outcome === 'rejected' ? 'deny' : 'allow-once'; upsert(pendingItem, atMs);
          const call = calls.get(pendingItem.toolCallId); if (call && data.outcome === 'rejected') call.status = 'denied';
        }
      }
      if (event.type === 'turn/start') { summary.status = 'running'; update(atMs); }
      if (event.type === 'model/selection') {
        summary.model = modelOf(data); update(atMs);
        upsert({ ...base(`model-${currentSeq}`, 'notice'), level: 'info', text: `Model selected: ${data.provider}/${data.model} (${data.reasoningEffort})`, code: 'model-changed' }, atMs);
      }
      if (event.type === 'user/message' && data.source?.kind === 'user') upsert({ ...base(`user-${event.seq}`, 'user_message', event), text: textOf(data), attachments: metadata.live ? (data.content ?? []).filter(part => ['image', 'file'].includes(part.type)).map(part => ({ name: part.attachment?.name ?? (part.type === 'image' ? 'Image' : 'File'), ...(part.attachment?.mediaType ? { mime: part.attachment.mediaType } : {}), ...(Number.isInteger(part.attachment?.bytes) ? { size: part.attachment.bytes } : {}) })) : [] }, atMs);
      if (event.type === 'assistant/message') {
        const kinds = metadata.live ? [...new Set((data.message.content ?? []).map(part => part.type).filter(kind => ['text', 'reasoning'].includes(kind)))] : ['text'];
        for (const blockKind of kinds) {
          const text = (data.message.content ?? []).filter(part => part.type === blockKind).map(part => part.text).join('\n');
          if (!text) continue;
          const attemptId = settled.get(event.seq) ?? (metadata.live ? `t${data.turn}-s${data.step}` : undefined);
          const prefix = blockKind === 'reasoning' ? 'reasoning' : 'assistant';
          const itemId = attemptId ? `${prefix}-${attemptId}` : `${prefix}-${event.seq}`;
          if (metadata.live && !creationPositions.has(itemId)) {
            const first = (data.stream ?? []).find(chunk => chunk.type.endsWith('-chunks') || chunk.chunk?.type === 'block-start');
            const firstTime = first?.time0 ?? first?.time;
            const before = nativeTimes.findLast(entry => entry.time <= firstTime);
            creationPositions.set(itemId, before?.seq ?? event.seq);
          }
          upsert({ ...base(itemId, blockKind === 'reasoning' ? 'reasoning' : 'assistant_message', event), text, state: data.interrupted ? 'cancelled' : 'complete', ...(blockKind === 'text' && summary.model ? { model: structuredClone(summary.model) } : {}) }, atMs);
          if (metadata.live) attempts.delete(`${prefix}-${attemptId}`);
        }
      }
      if (event.type === 'tool/call') {
        let args = {};
        try { args = JSON.parse(data.arguments); } catch { /* Preserve truncated input as raw. */ }
        const item = { ...base(`tool-${data.callId}`, 'tool_call', event), callId: data.callId, tool: { name: data.name, kind: kindOf(data.name) }, title: args.description ?? `${data.name}${args.file_path ? ` ${relative(args.file_path)}` : ''}`, input: { raw: data.arguments.slice(0, 8192), ...(args.command ? { command: args.command } : {}), ...(args.file_path ? { path: relative(args.file_path) } : {}) }, status: 'running' };
        if (metadata.live && [...pending.values()].some(interaction => interaction.kind === 'approval' && interaction.toolCallId === data.callId)) item.status = 'awaiting-approval';
        if (args.run_in_background && !metadata.live) item.jobId = 'job-1';
        calls.set(data.callId, item); upsert(item, atMs);
      }
      if (metadata.live && event.type === 'job/registered') {
        const item = calls.get(data.toolCall?.callId);
        if (item) { item.jobId = data.jobId; item.seq = currentSeq; upsert(item, atMs); }
      }
      if (event.type === 'tool/result') {
        const item = calls.get(data.message.toolCallId);
        if (item) {
          item.seq = currentSeq; item.status = data.message.isError ? (item.status === 'denied' ? 'denied' : 'failed') : 'succeeded'; item.output = { text: metadata.live ? textOf(data.message) : textOf(data.message).slice(0, 65536), truncated: !metadata.live && textOf(data.message).length > 65536, isError: data.message.isError === true }; upsert(item, atMs);
          for (const interaction of items.values()) if (interaction.kind === 'interaction' && interaction.toolCallId === item.callId && interaction.state === 'answered') { interaction.seq = currentSeq; upsert(interaction, atMs); }
        }
      }
      if (event.type === 'workspace/changes') {
        lastChangeId = `change-${event.seq}`;
        const native = records.find(r => r.source === 'changes.summary')?.frame;
        upsert({ ...base(lastChangeId, 'changes', event), changeId: lastChangeId, fileCount: native?.total ?? 0, added: native?.added ?? 0, deleted: native?.deleted ?? 0, available: Boolean(native) }, atMs);
      }
      if (event.type === 'deliverables/presented') upsert({ ...base(`deliverables-${event.seq}`, 'deliverables', event), deliverables: data.files.map((file, index) => ({ deliverableId: metadata.live ? deliverableId(metadata.sessionId, event.seq, index) : `deliverable-${event.seq}-${index}`, name: relative(file.path).split('/').at(-1), path: relative(file.path), ...(file.description ? { description: file.description } : {}) })) }, atMs);
      if (event.type === 'turn/end') {
        const reason = data.reason?.kind === 'aborted' ? 'cancelled' : data.reason?.kind === 'error' ? 'error' : 'completed';
        for (const [id, item] of attempts) if (item.state === 'streaming') { item.seq = currentSeq; item.state = reason === 'cancelled' ? 'cancelled' : reason === 'error' ? 'failed' : 'complete'; upsert(item, atMs); attempts.delete(id); }
        upsert({ ...base(`turn-end-${event.seq}`, 'turn_end', event), reason }, atMs);
        summary.status = reason === 'error' ? 'error' : 'idle'; update(atMs);
      }
    }
    if (source === 'session' && frame.type === 'assistant-stream') {
      const stream = frame.frame;
      if (metadata.live && stream.type === 'start') {
        const identity = `t${stream.turn}-s${stream.step}`;
        activeStreams.set(stream.attemptId, { ...stream, identity });
        creationPositions.set(`assistant-${identity}`, stream.startedAfterSeq);
        creationPositions.set(`reasoning-${identity}`, stream.startedAfterSeq);
      }
      const streamId = metadata.live ? activeStreams.get(stream.attemptId)?.identity ?? stream.attemptId : stream.attemptId;
      if (stream.type === 'chunk' && ['text-delta', ...(metadata.live ? ['reasoning-delta'] : [])].includes(stream.chunk?.type)) {
        const attemptKey = metadata.live ? `${stream.chunk.type === 'reasoning-delta' ? 'reasoning' : 'assistant'}-${streamId}` : streamId;
        let item = attempts.get(attemptKey);
        if (!item) { item = { ...base(`${stream.chunk.type === 'reasoning-delta' ? 'reasoning' : 'assistant'}-${streamId}`, stream.chunk.type === 'reasoning-delta' ? 'reasoning' : 'assistant_message'), text: '', state: 'streaming', ...(stream.chunk.type === 'text-delta' && summary.model ? { model: structuredClone(summary.model) } : {}) }; attempts.set(attemptKey, item); upsert(item, atMs); }
        const before = Buffer.byteLength(item.text);
        item.text += stream.chunk.text;
        const append = metadata.live ? utf8(stream.chunk.text, Math.max(0, 262144 - before)) : stream.chunk.text;
        if (append) emit('timeline.delta', { itemId: item.itemId, field: 'text', append }, atMs);
      }
      if (stream.type === 'end' && stream.outcome?.kind === 'committed') { attempts.delete(streamId); if (metadata.live) { attempts.delete(`assistant-${streamId}`); attempts.delete(`reasoning-${streamId}`); } }
    }
    if (metadata.live && source === 'interaction-expire') {
      for (const id of frame.ids) {
        const item = items.get(`interaction-${id}`);
        if (item?.state === 'pending' && !pending.has(id)) { item.state = 'expired'; item.seq = currentSeq; upsert(item, atMs); }
      }
      summary.status = frame.status; summary.pendingInteractions = pending.size; update(atMs);
    }
    if (metadata.live && source === 'interaction-warning') {
      const itemId = 'interaction-unidentified';
      if (!items.has(itemId)) upsert({ ...base(itemId, 'notice'), level: 'warning', text: `${frame.kind === 'approval' ? 'An approval' : 'A question'} is waiting on your computer that DSHM can't identify. Answer it in DeepSeek Harness.` }, atMs);
      summary.status = frame.status; summary.pendingInteractions = pending.size; update(atMs);
    }
    if (source === 'interaction' && frame.type === 'waterfall') {
      const tool = calls.get(frame.request.callId) ?? (metadata.live ? undefined : [...calls.values()].findLast(call => ['running', 'awaiting-approval'].includes(call.status)));
      const callId = metadata.live ? frame.request.callId : tool?.callId;
      const kind = frame.event === 'approval/request' ? 'approval' : 'question';
      const toolName = tool?.tool.name ?? (metadata.live ? frame.request.toolName ?? 'unknown' : 'bash');
      const interaction = { interactionId: frame.eventId, sessionId: metadata.sessionId, kind, blocking: true, createdAt: iso(lastTime), ...(callId ? { toolCallId: callId } : {}), ...(kind === 'approval' ? { approval: { toolName, toolKind: tool?.tool.kind ?? (metadata.live ? kindOf(toolName) : 'shell'), title: tool?.title ?? (metadata.live ? 'Approval' : 'Run a shell command'), ...(tool?.input.command ? { command: tool.input.command } : {}), ...(frame.request.reason ? { reason: frame.request.reason } : {}) } } : { questions: (frame.request.questions ?? []).map(q => ({ questionId: q.id, question: q.question, options: q.options ?? [], multiSelect: q.multiSelect ?? false, ...(q.header ? { header: q.header } : {}) })) }) };
      pending.set(frame.eventId, interaction);
      if (tool) { tool.status = kind === 'approval' ? 'awaiting-approval' : 'running'; tool.seq = currentSeq; upsert(tool, atMs); }
      upsert({ ...base(`interaction-${frame.eventId}`, 'interaction'), interactionId: frame.eventId, interactionKind: kind, state: 'pending', summary: kind === 'approval' ? interaction.approval.title : interaction.questions.map(q => q.question).join('\n'), ...(callId ? { toolCallId: callId } : {}) }, atMs);
      summary.status = 'needs-input'; summary.pendingInteractions = pending.size; update(atMs);
      emit('interaction.open', { interaction }, atMs);
    }
    if (metadata.live && source === 'interaction' && frame.type === 'cancel') {
      const interaction = pending.get(frame.eventId);
      if (interaction) {
        pending.delete(frame.eventId);
        const item = items.get(`interaction-${frame.eventId}`);
        if (item) { item.state = 'cancelled'; item.seq = currentSeq; upsert(item, atMs); }
        summary.pendingInteractions = pending.size;
        if (summary.status === 'needs-input') summary.status = pending.size ? 'needs-input' : 'running';
        emit('interaction.close', { interactionId: frame.eventId, reason: 'cancelled' }, atMs); update(atMs);
      }
    }
    if (source === 'answer') {
      const interaction = pending.get(frame.eventId);
      if (!interaction) return;
      const answer = interaction.kind === 'approval' ? { kind: 'approval', decision: frame.value === 'rejected' ? 'deny' : 'allow-once' } : { kind: 'question', answers: frame.value.answers.map(a => ({ questionId: a.id, selected: a.selected })) };
      const id = requestId++;
      push('client', { t: 'req', id, method: 'interaction.answer', params: { interactionId: frame.eventId, answer } }, atMs);
      push('server', { t: 'res', id, result: { settled: true } }, atMs);
      emit('interaction.close', { interactionId: frame.eventId, reason: 'answered' }, atMs);
      const item = items.get(`interaction-${frame.eventId}`); item.state = 'answered'; item.seq = currentSeq; item.outcome = interaction.kind === 'approval' ? answer.decision : 'answered'; upsert(item, atMs);
      if (interaction.kind === 'approval' && answer.decision === 'deny' && calls.has(interaction.toolCallId)) calls.get(interaction.toolCallId).status = 'denied';
      pending.delete(frame.eventId); summary.pendingInteractions = pending.size; summary.status = 'running'; update(atMs);
    }
    if (source === 'queue') {
      const queue = ['next-turn', 'next-step'].flatMap(mode => (frame[mode] ?? []).map((q, index) => ({ queueItemId: q.id ?? `queue-${index}`, text: (q.content ?? q.input?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n'), mode })));
      currentQueue = queue; emit('queue.update', { queue }, atMs);
    }
    if (metadata.live && source === 'permission') { permission = frame.current; update(atMs); }
    if (metadata.live && source === 'change-state') {
      const item = items.get(`change-${frame.seq}`);
      if (item) {
        item.available = frame.available;
        for (const key of ['fileCount', 'added', 'deleted']) if (Number.isInteger(frame[key])) item[key] = frame[key];
        item.seq = currentSeq; upsert(item, atMs);
      }
    }
    if (source === 'changes.summary') {
      const result = { files: frame.files.map((file, index) => ({ index, path: relative(file.path), display: relative(file.path), status: 'modified', added: file.added, deleted: file.deleted })), added: frame.added, deleted: frame.deleted };
      mock.changes.push({ changeId: lastChangeId, ...result });
      const id = requestId++; push('client', { t: 'req', id, method: 'changes.summary', params: { sessionId: metadata.sessionId, changeId: lastChangeId } }, atMs); push('server', { t: 'res', id, result }, atMs);
    }
    if (source === 'changes.diff') {
      const change = mock.changes.at(-1);
      if (change) {
        change.diff = { kind: frame.kind, path: relative(frame.path), ...(frame.hunks ? { hunks: frame.hunks, coarse: frame.coarse } : {}) };
        const id = requestId++; push('client', { t: 'req', id, method: 'changes.diff', params: { sessionId: metadata.sessionId, changeId: change.changeId, index: 0 } }, atMs); push('server', { t: 'res', id, result: { diff: change.diff } }, atMs);
      }
    }
    if (source === 'jobs' && frame.type === 'rows') {
      const jobs = frame.jobs.map(jobOf); mock.jobs = jobs;
      if (!jobsSubscribed) { const id = requestId++; push('client', { t: 'req', id, method: 'jobs.watch', params: { sessionId: metadata.sessionId } }, atMs); push('server', { t: 'res', id, result: { subId: 'sub-jobs', jobs } }, atMs); jobsSubscribed = true; }
      else push('server', { t: 'ev', subId: 'sub-jobs', event: 'jobs.replace', data: { jobs } }, atMs);
    }
    if (source === 'job' && frame.type === 'opened' && !jobSubscribed) { const id = requestId++; push('client', { t: 'req', id, method: 'job.watch', params: { sessionId: metadata.sessionId, jobId: 'job-1', fromByte: 0 } }, atMs); push('server', { t: 'res', id, result: { subId: 'sub-job', job: jobOf(frame.job), from: frame.from } }, atMs); jobSubscribed = true; }
    if (source === 'job' && frame.type === 'output') { const chunks = frame.chunks.map(({ at, text, channel, gapBefore, lossy }) => ({ at, text, channel, ...(gapBefore !== undefined ? { gapBefore } : {}), ...(lossy !== undefined ? { lossy } : {}) })); mock.jobOutput.push(...chunks); push('server', { t: 'ev', subId: 'sub-job', event: 'job.output', data: { chunks, next: frame.next } }, atMs); }
    if (source === 'job' && frame.type === 'status') push('server', { t: 'ev', subId: 'sub-job', event: 'job.status', data: { job: jobOf(frame.job) } }, atMs);
    // A native record can affect several visible items. Advance the resumable
    // watermark only once all those replacements have been sent.
    const updates = frames.slice(recordStart).filter(entry => ['timeline.upsert', 'timeline.remove'].includes(entry.frame.kind));
    for (const entry of updates.slice(0, -1)) entry.frame.data.throughSeq = checkpoint;
    if (updates.length) checkpoint = updates.at(-1).frame.data.throughSeq;
    if (metadata.live && source === 'session' && frame.type === 'event') nativeTimes.push({ seq: frame.event.seq, time: frame.event.time });
  };
  return {
    accept(record) {
      const from = frames.length;
      accept(record);
      const emitted = frames.slice(from);
      if (metadata.live) { frames.length = 0; replay.length = 0; }
      return emitted;
    },
    state: () => ({ session: session(), items: [...items.values()].map(item => structuredClone(item)), inlineItems: [...items.values()].map(inline), interactions: [...pending.values()].map(i => structuredClone(i)), queue: structuredClone(currentQueue), throughSeq: currentSeq, removed: [...removed] }),
    result: () => ({ transcript: { description: `${metadata.title}; recorded native DSH with deterministic model`, frames }, replay, mock }),
  };
}

export function foldRecording(records, metadata) {
  const settled = new Map();
  for (const { frame } of records) if (frame.type === 'assistant-stream' && frame.frame.type === 'end' && frame.frame.outcome?.seq) settled.set(frame.frame.outcome.seq, frame.frame.attemptId);
  const snapshot = records.find(r => r.source === 'session' && r.frame.type === 'snapshot')?.frame;
  const fold = createProjectionFold(metadata, { snapshot, settled, relatedRecords: records });
  for (const record of records) fold.accept(record);
  return fold.result();
}
