/**
 * UsageCapsule: status-bar pill plus a sectioned detail panel. Live data
 * arrives as the `usageCost` projection whole value through `useProjection`.
 * Sections: session usage → unit price → budget & remaining → categorized
 * consumption (main/subagent, per model, today/month/all-time).
 */

import { useCallback, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageCostProjection } from '../types.ts'
import { formatCost, formatDuration, formatTokens, formatTokensCompact, formatPrice, percentOf } from './format.ts'

type CapsuleProps = PropsRuntime<'conversation.session.header.utilities'>

const RED = 'var(--dsw-alias-state-error-primary)'
const AMBER = 'var(--dsw-alias-state-warn-primary)'
const GREEN = 'var(--dsw-alias-state-success-primary)'
const GRAY = 'var(--dsw-alias-label-tertiary)'

/**
 * Right inset for the header capsule. The capsule lives in the right-aligned
 * `conversation.session.header.utilities` strip; a positive `marginRight`
 * shifts the whole capsule group (pill + its anchored detail panel) leftwards
 * so it stops covering adjacent chrome. Tune this value if you need more/less
 * clearance.
 */
const CAPSULE_RIGHT_INSET_PX = 160

const STATUS_META: Record<UsageCostProjection['status'], { label: string; color: string }> = {
  idle: { label: '等待中', color: GRAY },
  estimating: { label: '估算中', color: AMBER },
  calibrated: { label: '已校准', color: GREEN },
  incomplete: { label: '未完成', color: GRAY },
}

const capsuleStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid var(--dsw-alias-border-l3)',
  background: 'var(--dsw-alias-bg-overlay)',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 11.5,
  lineHeight: 1.3,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  userSelect: 'none',
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  zIndex: 1000,
  width: 340,
  padding: 14,
  borderRadius: 12,
  border: '1px solid var(--dsw-alias-border-l3)',
  background: 'var(--dsw-specific-menu)',
  color: 'var(--dsw-alias-label-primary)',
  boxShadow: '0 8px 24px var(--dsw-alias-bg-mask-1)',
  fontSize: 12.5,
  lineHeight: 1.5,
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 11,
  border: '1px solid',
}

const dotStyle: CSSProperties = { width: 6, height: 6, borderRadius: 999 }

const sectionTitleStyle: CSSProperties = {
  margin: '4px 0 2px',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--dsw-alias-label-caption)',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '2px 0',
}

const labelStyle: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }
const valueStyle: CSSProperties = { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary)' }
const monoStyle: CSSProperties = { fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontVariantNumeric: 'tabular-nums' }
const mutedStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)', padding: '2px 0' }

const barTrackStyle: CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: 'var(--dsw-alias-border-l2)',
  overflow: 'hidden',
  margin: '4px 0 6px',
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }): ReactElement {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueColor ? { ...valueStyle, color: valueColor } : valueStyle}>{value}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <div style={sectionTitleStyle}>{title}</div>
      {children}
    </div>
  )
}

function Divider(): ReactElement {
  return <div style={{ height: 1, margin: '8px 0', background: 'var(--dsw-alias-border-l3)' }} />
}

function SubDivider(): ReactElement {
  return <div style={{ height: 1, margin: '6px 0', background: 'var(--dsw-alias-border-l2)' }} />
}

function StatusBadge({ status }: { status: UsageCostProjection['status'] }): ReactElement {
  const meta = STATUS_META[status]
  return (
    <span style={{ ...badgeStyle, color: meta.color, borderColor: meta.color }}>
      <span style={{ ...dotStyle, background: meta.color }} />
      {meta.label}
    </span>
  )
}

function RatioBar({ main, subagent }: { main: number; subagent: number }): ReactElement {
  const pct = percentOf(main, main + subagent)
  return (
    <div style={barTrackStyle}>
      <div style={{ width: `${pct}%`, height: '100%', background: GREEN, borderRadius: 3 }} />
    </div>
  )
}

function DetailPanel({ projection }: { projection: UsageCostProjection }): ReactElement {
  const approximate = !projection.calibrated
  const mark = approximate ? '~' : ''
  const cost = projection.costYuan
  const costValue = cost === null ? '未配置价格' : `${approximate ? '~' : ''}${formatCost(cost)}`
  const tps = projection.tokensPerSecond === null
    ? '—'
    : `${projection.tokensPerSecond.toFixed(1)} tok/s`
  const p = projection.pricing
  const totals = projection.totals
  const budget = projection.budgetYuan
  const budgetOn = budget > 0
  const remTotal = projection.remainingTotal
  const remMonth = projection.remainingMonth
  const balance = projection.balance

  const remainingColor = (r: number | null): string | undefined =>
    r === null ? undefined : r < 0 ? RED : r < budget * 0.1 ? AMBER : GREEN

  const models = Object.entries(totals.models).sort((a, b) => b[1].costYuan - a[1].costYuan)

  return (
    <div style={panelStyle} role="dialog" aria-label="用量与成本详情">
      <div style={headerStyle}>
        <span style={{ ...monoStyle, fontWeight: 600 }}>{projection.model ?? '—'}</span>
        <StatusBadge status={projection.status} />
      </div>

      <Divider />

      <Section title="本次会话">
        <Row label="输入 token" value={`${mark}${formatTokens(projection.inputTokens)}`} />
        <Row label="输出 token" value={`${mark}${formatTokens(projection.outputTokens)}`} />
        <Row label="缓存命中" value={`${mark}${formatTokens(projection.cacheHitTokens)}`} />
        <Row label="缓存未命中" value={`${mark}${formatTokens(projection.cacheMissTokens)}`} />
        <Row label="总 token" value={`${mark}${formatTokens(projection.totalTokens)}`} />
        <Row label="本次成本" value={costValue} />
        <Row label="耗时 · 速度" value={`${formatDuration(projection.durationMs)} · ${tps}`} />
      </Section>

      <Divider />

      <Section title="单价（¥ / 1M token）">
        {p === null ? (
          <div style={mutedStyle}>未配置价格</div>
        ) : p.peakCacheHit === undefined ? (
          <>
            <Row label="缓存命中" value={formatPrice(p.cacheHit)} />
            <Row label="缓存未命中" value={formatPrice(p.cacheMiss)} />
            <Row label="输出" value={formatPrice(p.output)} />
          </>
        ) : (
          <>
            <Row label="缓存命中（闲时/高峰）" value={`${formatPrice(p.cacheHit)} / ${formatPrice(p.peakCacheHit)}`} />
            <Row label="缓存未命中（闲时/高峰）" value={`${formatPrice(p.cacheMiss)} / ${formatPrice(p.peakCacheMiss ?? 0)}`} />
            <Row label="输出（闲时/高峰）" value={`${formatPrice(p.output)} / ${formatPrice(p.peakOutput ?? 0)}`} />
          </>
        )}
      </Section>

      <Divider />

      <Section title="额度与剩余">
        {balance.balanceYuan !== null ? (
          <Row label="账户余额" value={formatCost(balance.balanceYuan)} valueColor={GREEN} />
        ) : balance.error !== null ? (
          <div style={mutedStyle}>账户余额获取失败（{balance.error}）</div>
        ) : (
          <div style={mutedStyle}>账户余额加载中…</div>
        )}
        {!budgetOn ? (
          <div style={mutedStyle}>未设置总额度（在 settings.yaml 的 usage-cost.budgetYuan 配置）</div>
        ) : (
          <>
            <Row label="累计总消耗" value={formatCost(totals.total.costYuan)} />
            <Row label="累计剩余" value={remTotal === null ? '—' : formatCost(remTotal)} valueColor={remainingColor(remTotal)} />
            <Row label="本月消耗" value={formatCost(totals.month.costYuan)} />
            <Row label="本月剩余" value={remMonth === null ? '—' : formatCost(remMonth)} valueColor={remainingColor(remMonth)} />
          </>
        )}
      </Section>

      <Divider />

      <Section title="分类消耗">
        <Row label="主对话" value={formatCost(totals.main.costYuan)} />
        <Row label="子代理" value={formatCost(totals.subagent.costYuan)} />
        <RatioBar main={totals.main.costYuan} subagent={totals.subagent.costYuan} />
        <SubDivider />
        <div style={mutedStyle}>按模型</div>
        {models.length === 0 ? (
          <div style={mutedStyle}>暂无数据</div>
        ) : (
          models.map(([id, bucket]) => (
            <Row key={id} label={id} value={formatCost(bucket.costYuan)} />
          ))
        )}
        <SubDivider />
        <div style={mutedStyle}>按日期</div>
        <Row label="今日" value={formatCost(totals.today.costYuan)} />
        <Row label="本月" value={formatCost(totals.month.costYuan)} />
        <Row label="累计" value={formatCost(totals.total.costYuan)} />
      </Section>
    </div>
  )
}

export function UsageCapsule({ useProjection }: CapsuleProps): ReactElement | null {
  const projection = useProjection('usageCost')
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen(value => !value), [])

  if (projection === undefined) return null

  const approximate = !projection.calibrated
  const mark = approximate ? '~' : ''
  const model = projection.model ?? '—'
  const inTok = projection.inputTokens
  const outTok = projection.outputTokens
  const cost = projection.costYuan === null ? '未配置价格' : formatCost(projection.costYuan)
  const isEstimating = projection.status === 'estimating'
  const p = projection.pricing
  const balanceYuan = projection.balance.balanceYuan
  const remTotal = projection.remainingTotal
  // Prefer the fetched account balance; fall back to the self-set budget remaining.
  const shownRemaining = balanceYuan !== null ? balanceYuan : remTotal
  const shownColor = balanceYuan !== null
    ? GREEN
    : remTotal === null
      ? undefined
      : remTotal < 0 ? RED : remTotal < projection.budgetYuan * 0.1 ? AMBER : GREEN
  const priceTip = p === null
    ? '未配置价格'
    : p.peakCacheHit === undefined
      ? `单价（每 1M）：缓存命中 ${formatPrice(p.cacheHit)} · 未命中 ${formatPrice(p.cacheMiss)} · 输出 ${formatPrice(p.output)}`
      : `单价（每 1M）闲时/高峰：缓存命中 ${formatPrice(p.cacheHit)}/${formatPrice(p.peakCacheHit)} · 未命中 ${formatPrice(p.cacheMiss)}/${formatPrice(p.peakCacheMiss ?? 0)} · 输出 ${formatPrice(p.output)}/${formatPrice(p.peakOutput ?? 0)}`

  return (
    <div style={{ position: 'relative', display: 'inline-flex', marginRight: CAPSULE_RIGHT_INSET_PX }}>
      <button
        type="button"
        style={capsuleStyle}
        onClick={toggle}
        aria-expanded={open}
        aria-label="用量与成本"
        title={isEstimating ? `${priceTip}（流式估算中）` : priceTip}
      >
        <b style={monoStyle}>{approximate ? `${mark}${cost}` : cost}</b>
        {shownRemaining !== null && (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>余 <b style={{ ...monoStyle, color: shownColor }}>{formatCost(shownRemaining)}</b></span>
          </>
        )}
        {isEstimating && <span style={{ opacity: 0.6 }}>·</span>}
      </button>
      {open && <DetailPanel projection={projection} />}
    </div>
  )
}
