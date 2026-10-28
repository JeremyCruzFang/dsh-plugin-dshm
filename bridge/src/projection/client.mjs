// Only this browser boundary names DSH services and shared platform modules.
import * as React from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { createSettingsCard } from '../ui/card.mjs'

export const inject = ['slots']
const SettingsCard = createSettingsCard(React, primitives, 'api/dshm')

export function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dshm', order: 60, label: () => 'DSHM',
  }, SettingsCard))
}
