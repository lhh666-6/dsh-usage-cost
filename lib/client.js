window.__ModuleLoader__.load({
	id: "dsh-usage-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/format.ts
		/**
		* Pure presentation of usage/cost figures: compact token and CNY formatters.
		* Product copy is Chinese (repo convention); these helpers format numbers only.
		*
		* @module dsh-usage-cost/client/format
		*/
		/** Format a token count with thousands separators, or a compact k/M form. */
		function formatTokens(tokens) {
			const rounded = Math.round(tokens);
			if (!Number.isFinite(rounded)) return "—";
			return rounded.toLocaleString("en-US");
		}
		/** Compact token count for the capsule: 1234 → 1.2k, 1234567 → 1.23M. */
		function formatTokensCompact(tokens) {
			if (!Number.isFinite(tokens) || tokens < 0) return "—";
			if (tokens < 1e3) return String(Math.round(tokens));
			if (tokens < 1e6) return `${(tokens / 1e3).toFixed(1)}k`;
			return `${(tokens / 1e6).toFixed(2)}M`;
		}
		/** Format a CNY cost, keeping enough precision for sub-cent token pricing. */
		function formatCost(yuan) {
			if (!Number.isFinite(yuan)) return "—";
			if (yuan === 0) return "¥0";
			if (yuan >= 1) return `¥${yuan.toFixed(2)}`;
			if (yuan >= .01) return `¥${yuan.toFixed(4)}`;
			return `¥${yuan.toFixed(6)}`;
		}
		/** Format a millisecond duration as human-readable seconds/minutes. */
		function formatDuration(ms) {
			if (!Number.isFinite(ms) || ms < 0) return "—";
			if (ms < 1e3) return `${Math.round(ms)}ms`;
			if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
			const minutes = Math.floor(ms / 6e4);
			const seconds = Math.round(ms % 6e4 / 1e3);
			return `${minutes}m${String(seconds).padStart(2, "0")}s`;
		}
		/** Format a per-1M price rate with exactly two decimals (e.g. ¥0.50). */
		function formatPrice(yuan) {
			if (!Number.isFinite(yuan)) return "—";
			return `¥${yuan.toFixed(2)}`;
		}
		/** Integer percentage of value over total, clamped to [0, 100]; 0 when total ≤ 0. */
		function percentOf(value, total) {
			if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
			return Math.round(Math.min(100, Math.max(0, value / total * 100)));
		}
		//#endregion
		//#region src/client/UsageCapsule.tsx
		/**
		* UsageCapsule: status-bar pill plus a sectioned detail panel. Live data
		* arrives as the `usageCost` projection whole value through `useProjection`.
		* Sections: session usage → unit price → budget & remaining → categorized
		* consumption (main/subagent, per model, today/month/all-time).
		*/
		const RED = "var(--dsw-alias-state-error-primary)";
		const AMBER = "var(--dsw-alias-state-warn-primary)";
		const GREEN = "var(--dsw-alias-state-success-primary)";
		const GRAY = "var(--dsw-alias-label-tertiary)";
		/**
		* Right inset for the header capsule. The capsule lives in the right-aligned
		* `conversation.session.header.utilities` strip; a positive `marginRight`
		* shifts the whole capsule group (pill + its anchored detail panel) leftwards
		* so it stops covering adjacent chrome. Tune this value if you need more/less
		* clearance.
		*/
		const CAPSULE_RIGHT_INSET_PX = 160;
		const STATUS_META = {
			idle: {
				label: "等待中",
				color: GRAY
			},
			estimating: {
				label: "估算中",
				color: AMBER
			},
			calibrated: {
				label: "已校准",
				color: GREEN
			},
			incomplete: {
				label: "未完成",
				color: GRAY
			}
		};
		const capsuleStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 5,
			padding: "2px 8px",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l3)",
			background: "var(--dsw-alias-bg-overlay)",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			fontSize: 11.5,
			lineHeight: 1.3,
			cursor: "pointer",
			whiteSpace: "nowrap",
			userSelect: "none"
		};
		const panelStyle = {
			position: "absolute",
			top: "calc(100% + 6px)",
			right: 0,
			zIndex: 1e3,
			width: 340,
			padding: 14,
			borderRadius: 12,
			border: "1px solid var(--dsw-alias-border-l3)",
			background: "var(--dsw-specific-menu)",
			color: "var(--dsw-alias-label-primary)",
			boxShadow: "0 8px 24px var(--dsw-alias-bg-mask-1)",
			fontSize: 12.5,
			lineHeight: 1.5
		};
		const headerStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 8
		};
		const badgeStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 5,
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			border: "1px solid"
		};
		const dotStyle = {
			width: 6,
			height: 6,
			borderRadius: 999
		};
		const sectionTitleStyle = {
			margin: "4px 0 2px",
			fontSize: 11,
			letterSpacing: "0.06em",
			textTransform: "uppercase",
			color: "var(--dsw-alias-label-caption)"
		};
		const rowStyle$1 = {
			display: "flex",
			justifyContent: "space-between",
			gap: 12,
			padding: "2px 0"
		};
		const labelStyle = { color: "var(--dsw-alias-label-secondary)" };
		const valueStyle = {
			fontVariantNumeric: "tabular-nums",
			color: "var(--dsw-alias-label-primary)"
		};
		const monoStyle = {
			fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
			fontVariantNumeric: "tabular-nums"
		};
		const mutedStyle = {
			color: "var(--dsw-alias-label-tertiary)",
			padding: "2px 0"
		};
		const barTrackStyle = {
			height: 6,
			borderRadius: 3,
			background: "var(--dsw-alias-border-l2)",
			overflow: "hidden",
			margin: "4px 0 6px"
		};
		function Row({ label, value, valueColor }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: rowStyle$1,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: labelStyle,
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: valueColor ? {
						...valueStyle,
						color: valueColor
					} : valueStyle,
					children: value
				})]
			});
		}
		function Section({ title, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: sectionTitleStyle,
				children: title
			}), children] });
		}
		function Divider() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
				height: 1,
				margin: "8px 0",
				background: "var(--dsw-alias-border-l3)"
			} });
		}
		function SubDivider() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
				height: 1,
				margin: "6px 0",
				background: "var(--dsw-alias-border-l2)"
			} });
		}
		function StatusBadge({ status }) {
			const meta = STATUS_META[status];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: {
					...badgeStyle,
					color: meta.color,
					borderColor: meta.color
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
					...dotStyle,
					background: meta.color
				} }), meta.label]
			});
		}
		function RatioBar({ main, subagent }) {
			const pct = percentOf(main, main + subagent);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: barTrackStyle,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
					width: `${pct}%`,
					height: "100%",
					background: GREEN,
					borderRadius: 3
				} })
			});
		}
		function DetailPanel({ projection }) {
			const approximate = !projection.calibrated;
			const mark = approximate ? "~" : "";
			const cost = projection.costYuan;
			const costValue = cost === null ? "未配置价格" : `${approximate ? "~" : ""}${formatCost(cost)}`;
			const tps = projection.tokensPerSecond === null ? "—" : `${projection.tokensPerSecond.toFixed(1)} tok/s`;
			const p = projection.pricing;
			const totals = projection.totals;
			const budget = projection.budgetYuan;
			const budgetOn = budget > 0;
			const remTotal = projection.remainingTotal;
			const remMonth = projection.remainingMonth;
			const balance = projection.balance;
			const remainingColor = (r) => r === null ? void 0 : r < 0 ? RED : r < budget * .1 ? AMBER : GREEN;
			const models = Object.entries(totals.models).sort((a, b) => b[1].costYuan - a[1].costYuan);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: panelStyle,
				role: "dialog",
				"aria-label": "用量与成本详情",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: headerStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								...monoStyle,
								fontWeight: 600
							},
							children: projection.model ?? "—"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, { status: projection.status })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Divider, {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						title: "本次会话",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "输入 token",
								value: `${mark}${formatTokens(projection.inputTokens)}`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "输出 token",
								value: `${mark}${formatTokens(projection.outputTokens)}`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "缓存命中",
								value: `${mark}${formatTokens(projection.cacheHitTokens)}`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "缓存未命中",
								value: `${mark}${formatTokens(projection.cacheMissTokens)}`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "总 token",
								value: `${mark}${formatTokens(projection.totalTokens)}`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "本次成本",
								value: costValue
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "耗时 · 速度",
								value: `${formatDuration(projection.durationMs)} · ${tps}`
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Divider, {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: "单价（¥ / 1M token）",
						children: p === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: mutedStyle,
							children: "未配置价格"
						}) : p.peakCacheHit === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "缓存命中",
								value: formatPrice(p.cacheHit)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "缓存未命中",
								value: formatPrice(p.cacheMiss)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "输出",
								value: formatPrice(p.output)
							})
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "缓存命中（闲时/高峰）",
								value: `${formatPrice(p.cacheHit)} / ${formatPrice(p.peakCacheHit)}`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "缓存未命中（闲时/高峰）",
								value: `${formatPrice(p.cacheMiss)} / ${formatPrice(p.peakCacheMiss ?? 0)}`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "输出（闲时/高峰）",
								value: `${formatPrice(p.output)} / ${formatPrice(p.peakOutput ?? 0)}`
							})
						] })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Divider, {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						title: "额度与剩余",
						children: [balance.balanceYuan !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							label: "账户余额",
							value: formatCost(balance.balanceYuan),
							valueColor: GREEN
						}) : balance.error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: mutedStyle,
							children: [
								"账户余额获取失败（",
								balance.error,
								"）"
							]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: mutedStyle,
							children: "账户余额加载中…"
						}), !budgetOn ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: mutedStyle,
							children: "未设置总额度（在 settings.yaml 的 usage-cost.budgetYuan 配置）"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "累计总消耗",
								value: formatCost(totals.total.costYuan)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "累计剩余",
								value: remTotal === null ? "—" : formatCost(remTotal),
								valueColor: remainingColor(remTotal)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "本月消耗",
								value: formatCost(totals.month.costYuan)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "本月剩余",
								value: remMonth === null ? "—" : formatCost(remMonth),
								valueColor: remainingColor(remMonth)
							})
						] })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Divider, {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						title: "分类消耗",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "主对话",
								value: formatCost(totals.main.costYuan)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "子代理",
								value: formatCost(totals.subagent.costYuan)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RatioBar, {
								main: totals.main.costYuan,
								subagent: totals.subagent.costYuan
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SubDivider, {}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: mutedStyle,
								children: "按模型"
							}),
							models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: mutedStyle,
								children: "暂无数据"
							}) : models.map(([id, bucket]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: id,
								value: formatCost(bucket.costYuan)
							}, id)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SubDivider, {}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: mutedStyle,
								children: "按日期"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "今日",
								value: formatCost(totals.today.costYuan)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "本月",
								value: formatCost(totals.month.costYuan)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								label: "累计",
								value: formatCost(totals.total.costYuan)
							})
						]
					})
				]
			});
		}
		function UsageCapsule({ useProjection }) {
			const projection = useProjection("usageCost");
			const [open, setOpen] = (0, react.useState)(false);
			const toggle = (0, react.useCallback)(() => setOpen((value) => !value), []);
			if (projection === void 0) return null;
			const approximate = !projection.calibrated;
			const mark = approximate ? "~" : "";
			projection.model;
			projection.inputTokens;
			projection.outputTokens;
			const cost = projection.costYuan === null ? "未配置价格" : formatCost(projection.costYuan);
			const isEstimating = projection.status === "estimating";
			const p = projection.pricing;
			const balanceYuan = projection.balance.balanceYuan;
			const remTotal = projection.remainingTotal;
			const shownRemaining = balanceYuan !== null ? balanceYuan : remTotal;
			const shownColor = balanceYuan !== null ? GREEN : remTotal === null ? void 0 : remTotal < 0 ? RED : remTotal < projection.budgetYuan * .1 ? AMBER : GREEN;
			const priceTip = p === null ? "未配置价格" : p.peakCacheHit === void 0 ? `单价（每 1M）：缓存命中 ${formatPrice(p.cacheHit)} · 未命中 ${formatPrice(p.cacheMiss)} · 输出 ${formatPrice(p.output)}` : `单价（每 1M）闲时/高峰：缓存命中 ${formatPrice(p.cacheHit)}/${formatPrice(p.peakCacheHit)} · 未命中 ${formatPrice(p.cacheMiss)}/${formatPrice(p.peakCacheMiss ?? 0)} · 输出 ${formatPrice(p.output)}/${formatPrice(p.peakOutput ?? 0)}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					position: "relative",
					display: "inline-flex",
					marginRight: CAPSULE_RIGHT_INSET_PX
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: capsuleStyle,
					onClick: toggle,
					"aria-expanded": open,
					"aria-label": "用量与成本",
					title: isEstimating ? `${priceTip}（流式估算中）` : priceTip,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", {
							style: monoStyle,
							children: approximate ? `${mark}${cost}` : cost
						}),
						shownRemaining !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { opacity: .5 },
							children: "·"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["余 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", {
							style: {
								...monoStyle,
								color: shownColor
							},
							children: formatCost(shownRemaining)
						})] })] }),
						isEstimating && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { opacity: .6 },
							children: "·"
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailPanel, { projection })]
			});
		}
		//#endregion
		//#region src/client/ContextProgress.tsx
		const rowStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			fontSize: 11,
			lineHeight: 1.4,
			color: "var(--dsw-alias-label-tertiary)",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap"
		};
		const trackStyle = {
			width: 88,
			height: 4,
			borderRadius: 2,
			background: "var(--dsw-alias-border-l2)",
			overflow: "hidden"
		};
		/**
		* Context-occupancy bar. Renders nothing until the projection reports both a
		* capacity and a prompt estimate.
		* @param props - framework dock kit including `useProjection`.
		*/
		function ContextProgress({ useProjection }) {
			const pressure = useProjection("contextPressure");
			if (pressure === void 0) return null;
			const { projectedTokens, contextWindow } = pressure;
			if (projectedTokens === void 0 || contextWindow === void 0 || contextWindow <= 0) return null;
			const pct = Math.min(100, Math.round(projectedTokens / contextWindow * 100));
			const color = pct >= 90 ? "var(--dsw-alias-state-error-primary)" : pct >= 70 ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-success-primary)";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: rowStyle,
				title: `上下文占用 ${formatTokensCompact(projectedTokens)} / ${formatTokensCompact(contextWindow)}（${pct}%）`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "上下文" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: trackStyle,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
							width: `${pct}%`,
							height: "100%",
							background: color,
							borderRadius: 2
						} })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						formatTokensCompact(projectedTokens),
						" / ",
						formatTokensCompact(contextWindow)
					] })
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services: the header-utilities slot registry only. */
		const inject = ["slots"];
		/**
		* Register the capsule into the conversation header's right-aligned utilities
		* and the context-occupancy readout into the composer dock.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "usage-cost",
				order: 0
			}, UsageCapsule));
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "usage-cost-context",
				order: 0
			}, ContextProgress));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
