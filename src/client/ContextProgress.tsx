/**
 * ContextProgress: an ambient context-window occupancy readout rendered in the
 * composer dock (the band under the composer card, beside the shipped stats
 * line). It reads the framework's existing `contextPressure` projection — the
 * provider-anchored next-request prompt estimate (`projectedTokens`) against the
 * newest route capacity (`contextWindow`) — so it stays accurate across model
 * switches and compactions without any host-side work of its own.
 *
 * @module dsh-usage-cost/client/ContextProgress
 */

import type { CSSProperties, ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formatTokensCompact } from './format.ts'

type DockProps = PropsRuntime<'conversation.composer.dock'>

/** Minimal read-only view of the shipped `contextPressure` projection value. */
interface ContextPressure {
  projectedTokens?: number
  contextWindow?: number
}

const rowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  lineHeight: 1.4,
  color: 'var(--dsw-alias-label-tertiary)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const trackStyle: CSSProperties = {
  width: 88,
  height: 4,
  borderRadius: 2,
  background: 'var(--dsw-alias-border-l2)',
  overflow: 'hidden',
}

/**
 * Context-occupancy bar. Renders nothing until the projection reports both a
 * capacity and a prompt estimate.
 * @param props - framework dock kit including `useProjection`.
 */
export function ContextProgress({ useProjection }: DockProps): ReactElement | null {
  // The shipped projection key is not merged into this package's
  // SessionProjectionMap type, so read it loosely with a local shape.
  const pressure = useProjection('contextPressure' as any) as ContextPressure | undefined
  if (pressure === undefined) return null
  const { projectedTokens, contextWindow } = pressure
  if (projectedTokens === undefined || contextWindow === undefined || contextWindow <= 0) return null

  const pct = Math.min(100, Math.round((projectedTokens / contextWindow) * 100))
  const color = pct >= 90
    ? 'var(--dsw-alias-state-error-primary)'
    : pct >= 70
      ? 'var(--dsw-alias-state-warn-primary)'
      : 'var(--dsw-alias-state-success-primary)'

  return (
    <div style={rowStyle} title={`上下文占用 ${formatTokensCompact(projectedTokens)} / ${formatTokensCompact(contextWindow)}（${pct}%）`}>
      <span>上下文</span>
      <div style={trackStyle}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span>{formatTokensCompact(projectedTokens)} / {formatTokensCompact(contextWindow)}</span>
    </div>
  )
}
