import { isDeepStrictEqual } from 'node:util'
import type { DmpObject } from '../types.js'
import type { NativeRecord } from './fold-recording.mjs'

const object = (value: unknown): DmpObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as DmpObject : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const idFor = (sessionId: string, nativeId: string) => `i-${sessionId}-${nativeId}`
export interface InteractionIdentity { id: string; callId?: string }

function pending(records: readonly NativeRecord[]) {
  const calls = new Map<string, DmpObject>(), approvals = new Map<string, DmpObject>()
  for (const record of records) {
    if (record.source !== 'session' || record.frame.type !== 'event') continue
    const event = object(record.frame.event), data = object(event.data)
    if (event.type === 'tool/call') calls.set(string(data.callId), data)
    if (event.type === 'tool/result') calls.delete(string(object(data.message).toolCallId))
    if (event.type === 'approval/asked') approvals.set(string(data.id), data)
    if (event.type === 'approval/decided') approvals.delete(string(data.id))
    if (event.type === 'turn/end') { calls.clear(); approvals.clear() }
  }
  return { calls, approvals }
}

// Exact translation used by installed dsh-tool-ask-user questionRequest().
function questions(call: DmpObject): unknown {
  let input: DmpObject
  try { input = object(JSON.parse(string(call.arguments))) } catch { return }
  if (!Array.isArray(input.questions)) return
  return input.questions.map(value => {
    const question = object(value)
    return { id: question.id, question: question.question,
      ...(question.header !== undefined ? { header: question.header } : {}),
      ...(question.options !== undefined ? { options: question.options } : {}),
      ...(question.multi_select !== undefined ? { multiSelect: question.multi_select } : {}),
    }
  })
}

/** Native eventId addresses delivery only; it never contributes to DMP identity. */
export function interactionIdentity(sessionId: string, event: string, request: DmpObject, records: readonly NativeRecord[]): InteractionIdentity | undefined {
  const callId = string(request.callId) || string(object(request.wait).callId)
  if (callId) return { id: idFor(sessionId, callId), callId }
  const { calls, approvals } = pending(records)
  if (event === 'approval/request') {
    const matches = [...approvals.values()].filter(audit => !audit.callId && audit.toolName === request.toolName && audit.reason === request.reason)
    if (matches.length === 1 && string(matches[0].id)) return { id: idFor(sessionId, string(matches[0].id)) }
  } else if (event === 'user-questions/request' && Array.isArray(request.questions)) {
    const matches = [...calls.values()].filter(call => call.name === 'ask_user_question' && isDeepStrictEqual(questions(call), request.questions))
    if (matches.length === 1 && string(matches[0].callId)) {
      const callId = string(matches[0].callId)
      return { id: idFor(sessionId, callId), callId }
    }
  }
  // Missing or ambiguous evidence is resolved by a bounded follow-stream wait.
}

/** A follow snapshot can precede $events' pending-delivery replay after ready. */
export function expectedInteractionIds(sessionId: string, records: readonly NativeRecord[]): string[] {
  const { calls, approvals } = pending(records)
  return [...new Set([
    ...[...approvals.values()].map(audit => idFor(sessionId, string(audit.callId) || string(audit.id))),
    ...[...calls.values()].filter(call => call.name === 'ask_user_question').map(call => idFor(sessionId, string(call.callId))),
  ])]
}
