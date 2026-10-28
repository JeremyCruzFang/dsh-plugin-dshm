// A checkout may retain output from another branch. Never ship orphan modules.
import { rm } from 'node:fs/promises'
await rm(new URL('../lib/', import.meta.url), { recursive: true, force: true })
