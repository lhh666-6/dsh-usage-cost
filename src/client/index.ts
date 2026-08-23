/**
 * Browser half of dsh-usage-cost: a status-bar capsule in the conversation
 * header utilities strip plus a click-to-expand detail panel. Live per-session
 * values arrive through the `usageCost` session projection (the framework's
 * `useProjection` standard kit); no store, subscriptions, or polling.
 *
 * @module dsh-usage-cost/client
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { UsageCapsule } from './UsageCapsule.tsx'
import { ContextProgress } from './ContextProgress.tsx'

/** Required services: the header-utilities slot registry only. */
export const inject = ['slots']

/**
 * Register the capsule into the conversation header's right-aligned utilities
 * and the context-occupancy readout into the composer dock.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'usage-cost',
    order: 0,
  }, UsageCapsule))

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'usage-cost-context',
    order: 0,
  }, ContextProgress))
}
