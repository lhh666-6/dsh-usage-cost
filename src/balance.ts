/**
 * DeepSeek account-balance poller: fetches the account's total balance from the
 * public balance endpoint with the configured API key and serves the latest
 * snapshot to the projection. Only the balance number crosses the network; no
 * usage data ever leaves the machine.
 *
 * @module dsh-usage-cost/balance
 */

import type { AccountBalance } from './types.ts'

const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'
const REFRESH_MS = 5 * 60 * 1000

export const EMPTY_BALANCE: AccountBalance = { balanceYuan: null, error: null, fetchedAt: null }

/**
 * Owns the periodic balance fetch and the latest in-memory snapshot. Started by
 * the plugin fiber, disposed (timer cleared) on unload.
 */
export class BalancePoller {
  private state: AccountBalance = { ...EMPTY_BALANCE }
  private timer: NodeJS.Timeout | undefined
  private disposed = false
  private readonly resolveKey: () => Promise<string | null>

  /**
   * @param resolveKey - thunk returning the API key, or null while unconfigured.
   */
  constructor(resolveKey: () => Promise<string | null>) {
    this.resolveKey = resolveKey
  }

  /** Fetch once immediately, then on the refresh interval. */
  async start(): Promise<void> {
    await this.refresh()
    if (this.disposed) return
    this.timer = setInterval(() => { void this.refresh() }, REFRESH_MS)
  }

  /** Fetch the current balance and replace the snapshot. Never throws. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    try {
      const key = await this.resolveKey()
      if (key === null) {
        this.state = { balanceYuan: null, error: '未配置 DEEPSEEK_API_KEY', fetchedAt: null }
        return
      }
      const response = await fetch(BALANCE_ENDPOINT, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        this.state = { balanceYuan: null, error: `HTTP ${response.status}`, fetchedAt: null }
        return
      }
      const data = await response.json() as {
        is_available?: boolean
        balance_infos?: Array<{ currency?: string; total_balance?: string }>
      }
      const info = data.balance_infos?.find((entry) => entry.currency === 'CNY') ?? data.balance_infos?.[0]
      const raw = info?.total_balance
      const balanceYuan = raw === undefined ? null : Number(raw)
      if (balanceYuan === null || !Number.isFinite(balanceYuan)) {
        this.state = { balanceYuan: null, error: '余额数据缺失', fetchedAt: null }
        return
      }
      this.state = { balanceYuan, error: null, fetchedAt: Date.now() }
    } catch (error) {
      this.state = {
        balanceYuan: null,
        error: error instanceof Error ? error.message : '网络错误',
        fetchedAt: null,
      }
    }
  }

  /** Detached copy of the latest balance snapshot. */
  snapshot(): AccountBalance {
    return { ...this.state }
  }

  /** Stop the refresh timer (idempotent). */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}
