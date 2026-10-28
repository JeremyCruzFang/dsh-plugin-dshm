import type { DmpObject } from '../types.js'
export interface NativeRecord { source: string; frame: DmpObject; atMs: number; nativeSeq?: number }
export interface FoldState {
  session: DmpObject
  items: DmpObject[]
  inlineItems: DmpObject[]
  interactions: DmpObject[]
  queue: DmpObject[]
  throughSeq: number
  removed: [string, number][]
}
export interface FoldEntry { from: 'client' | 'server'; frame: DmpObject }
export interface Fold {
  accept(record: NativeRecord): FoldEntry[]
  state(): FoldState
  result(): { transcript: { description: string; frames: FoldEntry[] }; replay: DmpObject[]; mock: DmpObject }
}
export function createProjectionFold(metadata: DmpObject, options?: DmpObject): Fold
export function foldRecording(records: NativeRecord[], metadata: DmpObject): ReturnType<Fold['result']>
