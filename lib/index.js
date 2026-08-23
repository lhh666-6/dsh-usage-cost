import { mkdir, readFile, writeFile } from "node:fs/promises";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { z as z$1 } from "zod";
import { countTokens } from "gpt-tokenizer";
import { dirname } from "node:path";
//#region src/pricing.ts
/**
* Default DeepSeek pricing in CNY per 1M tokens.
*
* Fixed-price rows (no peak fields): deepseek-chat / deepseek-reasoner.
* Peak/off-peak rows (effective 2026-08-17, Beijing time):
*   deepseek-v4-flash: off-peak ¥0.05/1.5/4.5, peak ¥0.10/3.0/9.0.
*   deepseek-v4-pro:   off-peak ¥0.15/4.5/13.5, peak ¥0.30/9.0/27.0.
*/
const DEFAULT_MODEL_PRICING = [
	{
		id: "deepseek-chat",
		cacheHit: .5,
		cacheMiss: 2,
		output: 8
	},
	{
		id: "deepseek-reasoner",
		cacheHit: 1,
		cacheMiss: 4,
		output: 16
	},
	{
		id: "deepseek-v4-flash",
		cacheHit: .05,
		cacheMiss: 1.5,
		output: 4.5,
		peakCacheHit: .1,
		peakCacheMiss: 3,
		peakOutput: 9
	},
	{
		id: "deepseek-v4-pro",
		cacheHit: .15,
		cacheMiss: 4.5,
		output: 13.5,
		peakCacheHit: .3,
		peakCacheMiss: 9,
		peakOutput: 27
	}
];
/** Default peak windows in Beijing time (UTC+8): 09:00–12:00 and 14:00–18:00. */
const DEFAULT_PEAK_WINDOWS = [{
	start: 540,
	end: 720
}, {
	start: 840,
	end: 1080
}];
/** Validation bound: a price must be a finite non-negative number. */
function validPrice(value) {
	return Number.isFinite(value) && value >= 0;
}
/**
* Validate one pricing entry. A malformed entry fails loud at load/settings
* resolution so a typo in cordis.yml or settings.yaml never silently zeroes cost.
* Peak fields are all-or-nothing: presence enables peak/off-peak pricing.
* @param entry - raw pricing row.
* @throws when any field is not a finite non-negative number, the id is empty,
*   or only some peak fields are present.
*/
function validateEntry(entry) {
	if (typeof entry.id !== "string" || entry.id.trim().length === 0) throw new Error("usage-cost: a pricing entry must declare a non-empty model id");
	for (const field of [
		"cacheHit",
		"cacheMiss",
		"output"
	]) if (!validPrice(entry[field])) throw new Error(`usage-cost: pricing entry "${entry.id}" ${field} must be a finite non-negative number`);
	const peakFields = [
		"peakCacheHit",
		"peakCacheMiss",
		"peakOutput"
	];
	const presentCount = peakFields.filter((field) => entry[field] !== void 0).length;
	if (presentCount > 0 && presentCount < peakFields.length) throw new Error(`usage-cost: pricing entry "${entry.id}" must declare peakCacheHit/peakCacheMiss/peakOutput together`);
	for (const field of peakFields) {
		const value = entry[field];
		if (value !== void 0 && !validPrice(value)) throw new Error(`usage-cost: pricing entry "${entry.id}" ${field} must be a finite non-negative number`);
	}
}
/**
* Resolve the configured pricing table into a validated, collision-checked list
* keyed by the normalized model id (first occurrence wins).
* @param models - raw configured pricing rows.
* @returns an ordered list of validated rows in configuration order.
*/
function resolvePricing(models) {
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	for (const raw of models) {
		validateEntry(raw);
		const id = normalizeModel(raw.id);
		if (seen.has(id)) continue;
		seen.add(id);
		resolved.push({
			id,
			cacheHit: raw.cacheHit,
			cacheMiss: raw.cacheMiss,
			output: raw.output,
			peakCacheHit: raw.peakCacheHit,
			peakCacheMiss: raw.peakCacheMiss,
			peakOutput: raw.peakOutput
		});
	}
	return resolved;
}
/** Lower-case and trim a model id for prefix matching. */
function normalizeModel(model) {
	return model.trim().toLowerCase();
}
/**
* Fuzzy-match a provider model id to a configured pricing row.
* Matching order: exact normalized id, then the longest configured id that is a
* prefix of the model id (`deepseek-v4-pro-0813` matches `deepseek-v4-pro`).
* @param model - the provider model id from the request header.
* @param pricing - validated pricing rows in configuration order.
* @returns the matched row, or undefined when no row matches.
*/
function matchModelPricing(model, pricing) {
	const key = normalizeModel(model);
	let best;
	for (const entry of pricing) {
		if (key === entry.id) return entry;
		if (key.startsWith(entry.id) && (best === void 0 || entry.id.length > best.id.length)) best = entry;
	}
	return best;
}
/**
* Whether an epoch-millisecond instant falls inside a configured peak window.
* Windows are expressed in Beijing time (UTC+8), matching DeepSeek's published
* schedule regardless of the machine's local timezone.
* @param epochMs - Unix epoch milliseconds.
* @param windows - configured peak windows; an empty list means never peak.
* @returns true when the instant is inside any peak window.
*/
function isPeakTime(epochMs, windows) {
	if (windows.length === 0) return false;
	const date = new Date(epochMs);
	const minutes = (date.getUTCHours() + 8) % 24 * 60 + date.getUTCMinutes();
	return windows.some((window) => minutes >= window.start && minutes < window.end);
}
/**
* Compute cost in CNY from peak and off-peak token splits.
* A fixed-price row prices both splits with its base rates; a peak/off-peak row
* prices the peak split with peak rates and the off-peak split with base rates.
* @param pricing - the matched pricing row.
* @param peak - peak-window token counts.
* @param offPeak - off-peak-window token counts.
* @returns the cost in CNY.
*/
function computeCost(pricing, peak, offPeak) {
	const peakPrice = pricing.peakCacheHit !== void 0 ? {
		cacheHit: pricing.peakCacheHit,
		cacheMiss: pricing.peakCacheMiss ?? 0,
		output: pricing.peakOutput ?? 0
	} : {
		cacheHit: pricing.cacheHit,
		cacheMiss: pricing.cacheMiss,
		output: pricing.output
	};
	const offPrice = {
		cacheHit: pricing.cacheHit,
		cacheMiss: pricing.cacheMiss,
		output: pricing.output
	};
	return (peak.cacheHit * peakPrice.cacheHit + peak.cacheMiss * peakPrice.cacheMiss + peak.output * peakPrice.output + offPeak.cacheHit * offPrice.cacheHit + offPeak.cacheMiss * offPrice.cacheMiss + offPeak.output * offPrice.output) / 1e6;
}
/** Default resolved configuration for a composition entry that omits every tunable. */
const DEFAULT_CONFIG = {
	models: DEFAULT_MODEL_PRICING,
	budgetYuan: 0,
	peakWindows: DEFAULT_PEAK_WINDOWS,
	chunkInterval: 50,
	timeIntervalMs: 100
};
//#endregion
//#region src/estimator.ts
/**
* Local token estimation backed by gpt-tokenizer (a pure-JS BPE tokenizer
* approximating the DeepSeek tokenizer closely enough for streaming estimates).
* Every estimate is tagged `~` in the UI and replaced by the provider `usage`
* when the response ends, so the exact approximation error never surfaces as a
* hard number after calibration.
*
* @module dsh-usage-cost/estimator
*/
/** Characters per token fallback when the tokenizer throws on exotic input. */
const CHARS_PER_TOKEN_FALLBACK = 4;
/**
* Estimate the token count of one plain string.
* @param text - the text to price.
* @returns a non-negative token estimate; the empty string is zero.
*/
function estimateTextTokens(text) {
	if (text.length === 0) return 0;
	try {
		return Math.max(0, countTokens(text));
	} catch {
		return Math.ceil(text.length / CHARS_PER_TOKEN_FALLBACK);
	}
}
//#endregion
//#region src/projection.ts
/**
* The `usageCost` session-projection unit: a pure fold over the durable
* session log that produces whole-session token usage, cost, wall time, and the
* data-status (estimating / calibrated / incomplete). Authoritative provider
* `usage` on `assistant/message` replaces streaming estimates; a step that ends
* without usage keeps its estimate and marks the session `incomplete` without
* touching calibrated history.
*
* @module dsh-usage-cost/projection
*/
const totalsBucketSchema = z$1.object({
	costYuan: z$1.number(),
	inputTokens: z$1.number(),
	outputTokens: z$1.number(),
	cacheHitTokens: z$1.number(),
	cacheMissTokens: z$1.number(),
	requests: z$1.number().int()
});
const totalsSchema = z$1.object({
	today: totalsBucketSchema,
	month: totalsBucketSchema,
	total: totalsBucketSchema,
	main: totalsBucketSchema,
	subagent: totalsBucketSchema,
	models: z$1.record(z$1.string(), totalsBucketSchema)
});
const pricingSchema = z$1.object({
	id: z$1.string(),
	cacheHit: z$1.number(),
	cacheMiss: z$1.number(),
	output: z$1.number(),
	peakCacheHit: z$1.number().optional(),
	peakCacheMiss: z$1.number().optional(),
	peakOutput: z$1.number().optional()
}).nullable();
const balanceSchema = z$1.object({
	balanceYuan: z$1.number().nullable(),
	error: z$1.string().nullable(),
	fetchedAt: z$1.number().nullable()
});
const usageCostSchema = z$1.object({
	model: z$1.string().nullable(),
	status: z$1.enum([
		"idle",
		"estimating",
		"calibrated",
		"incomplete"
	]),
	inputTokens: z$1.number(),
	outputTokens: z$1.number(),
	cacheHitTokens: z$1.number(),
	cacheMissTokens: z$1.number(),
	totalTokens: z$1.number(),
	costYuan: z$1.number().nullable(),
	durationMs: z$1.number(),
	tokensPerSecond: z$1.number().nullable(),
	calibrated: z$1.boolean(),
	pricing: pricingSchema,
	budgetYuan: z$1.number(),
	remainingMonth: z$1.number().nullable(),
	remainingTotal: z$1.number().nullable(),
	balance: balanceSchema,
	totals: totalsSchema
});
/** The in-flight step boundary and streaming estimator, or null when idle. */
const stepStateSchema = z$1.object({
	turn: z$1.number().int(),
	step: z$1.number().int(),
	startTime: z$1.number(),
	outputText: z$1.string(),
	outputTokens: z$1.number(),
	chunkCount: z$1.number().int(),
	lastEstimateTime: z$1.number()
}).nullable();
z$1.object({
	model: z$1.string().nullable(),
	status: z$1.enum([
		"idle",
		"estimating",
		"calibrated",
		"incomplete"
	]),
	authInput: z$1.number(),
	authCacheRead: z$1.number(),
	authCacheWrite: z$1.number(),
	authOutput: z$1.number(),
	authPeakCacheHit: z$1.number(),
	authPeakCacheMiss: z$1.number(),
	authPeakOutput: z$1.number(),
	estOutput: z$1.number(),
	systemText: z$1.string(),
	messagesText: z$1.string(),
	estInput: z$1.number(),
	step: stepStateSchema,
	totalDurationMs: z$1.number()
});
/** Concatenate the text of content blocks, recursing through tool-result payloads. */
function contentText(blocks) {
	let out = "";
	for (const block of blocks) switch (block.type) {
		case "text":
		case "reasoning":
			out += block.text;
			break;
		case "tool-result": out += contentText(block.content);
	}
	return out;
}
/** System prompt plus tool schema names/descriptions, as input-priceable text. */
function headerText(header) {
	let out = header.system ?? "";
	for (const tool of header.tools ?? []) out += `${tool.name} ${tool.description ?? ""}`;
	return out;
}
/** Whether a stream chunk carries output text worth pricing (text or reasoning). */
function chunkText(chunk) {
	switch (chunk.type) {
		case "text-delta":
		case "reasoning-delta": return chunk.text;
		default: return null;
	}
}
/** Prompt tokens from one provider usage record (disjoint fields summed). */
function promptTokens(usage) {
	return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}
/**
* Build the `usageCost` projection definition. The fold owns token/timing
* mathematics only; cost and aggregate totals are injected so the unit stays
* replay-pure while cost still reflects live pricing at read time.
* @param deps - cost resolver, totals snapshot, and throttle tunables.
* @returns the registrable projection definition.
*/
function createUsageCostProjection(deps) {
	const init = () => ({
		model: null,
		status: "idle",
		authInput: 0,
		authCacheRead: 0,
		authCacheWrite: 0,
		authOutput: 0,
		authPeakCacheHit: 0,
		authPeakCacheMiss: 0,
		authPeakOutput: 0,
		estOutput: 0,
		systemText: "",
		messagesText: "",
		estInput: 0,
		step: null,
		totalDurationMs: 0
	});
	const apply = (state, event) => {
		switch (event.type) {
			case "request/header": {
				const model = event.data.header.config.model;
				const systemText = headerText(event.data.header);
				if (model === state.model && systemText === state.systemText) return state;
				return {
					...state,
					model,
					systemText,
					estInput: estimateTextTokens(systemText + state.messagesText)
				};
			}
			case "user/message": {
				const text = contentText(event.data.content);
				if (text.length === 0) return state;
				const messagesText = state.messagesText + text;
				return {
					...state,
					messagesText,
					estInput: estimateTextTokens(state.systemText + messagesText)
				};
			}
			case "tool/result": {
				const text = contentText(event.data.message.content);
				if (text.length === 0) return state;
				const messagesText = state.messagesText + text;
				return {
					...state,
					messagesText,
					estInput: estimateTextTokens(state.systemText + messagesText)
				};
			}
			case "step/start": return {
				...state,
				status: "estimating",
				step: {
					turn: event.data.turn,
					step: event.data.step,
					startTime: event.time,
					outputText: "",
					outputTokens: 0,
					chunkCount: 0,
					lastEstimateTime: event.time
				}
			};
			case "assistant/chunk": {
				const step = state.step;
				if (step === null || step.turn !== event.data.turn || step.step !== event.data.step) return state;
				const text = chunkText(event.data.chunk);
				if (text === null) return state;
				const outputText = step.outputText + text;
				const chunkCount = step.chunkCount + 1;
				const due = chunkCount >= deps.chunkInterval || event.time - step.lastEstimateTime >= deps.timeIntervalMs;
				const outputTokens = due ? estimateTextTokens(outputText) : step.outputTokens + estimateTextTokens(text);
				return {
					...state,
					step: {
						...step,
						outputText,
						outputTokens,
						chunkCount: due ? 0 : chunkCount,
						lastEstimateTime: due ? event.time : step.lastEstimateTime
					}
				};
			}
			case "assistant/message": {
				const step = state.step;
				if (step === null || step.turn !== event.data.turn || step.step !== event.data.step) return state;
				const durationMs = Math.max(0, event.time - step.startTime);
				const usage = event.data.usage;
				if (usage !== void 0) {
					const cacheRead = usage.cacheReadTokens ?? 0;
					const cacheMiss = usage.inputTokens;
					const output = usage.outputTokens;
					const peak = deps.isPeakTime(event.time);
					return {
						...state,
						status: "calibrated",
						authInput: state.authInput + promptTokens(usage),
						authCacheRead: state.authCacheRead + cacheRead,
						authCacheWrite: state.authCacheWrite + (usage.cacheWriteTokens ?? 0),
						authOutput: state.authOutput + output,
						authPeakCacheHit: state.authPeakCacheHit + (peak ? cacheRead : 0),
						authPeakCacheMiss: state.authPeakCacheMiss + (peak ? cacheMiss : 0),
						authPeakOutput: state.authPeakOutput + (peak ? output : 0),
						step: null,
						totalDurationMs: state.totalDurationMs + durationMs
					};
				}
				return {
					...state,
					status: "incomplete",
					estOutput: state.estOutput + step.outputTokens,
					step: null,
					totalDurationMs: state.totalDurationMs + durationMs
				};
			}
			case "step/end": {
				const step = state.step;
				if (step === null || step.turn !== event.data.turn || step.step !== event.data.step) return state;
				return {
					...state,
					status: "incomplete",
					estOutput: state.estOutput + step.outputTokens,
					step: null,
					totalDurationMs: state.totalDurationMs + Math.max(0, event.time - step.startTime)
				};
			}
			default: return state;
		}
	};
	const view = (state) => {
		const streaming = state.step !== null;
		const cacheHitTokens = state.authCacheRead;
		const cacheMissTokens = streaming ? Math.max(0, state.estInput - state.authCacheRead) : state.authInput - state.authCacheRead - state.authCacheWrite;
		const inputTokens = streaming ? state.estInput : state.authInput;
		const outputTokens = state.authOutput + state.estOutput + (state.step?.outputTokens ?? 0);
		const model = state.model;
		const authCacheMiss = state.authInput - state.authCacheRead - state.authCacheWrite;
		const peak = {
			cacheHit: state.authPeakCacheHit,
			cacheMiss: state.authPeakCacheMiss,
			output: state.authPeakOutput
		};
		const offPeak = {
			cacheHit: state.authCacheRead - state.authPeakCacheHit,
			cacheMiss: authCacheMiss - state.authPeakCacheMiss,
			output: state.authOutput - state.authPeakOutput
		};
		const nowPeak = deps.isPeakTime(Date.now());
		const estMiss = Math.max(0, cacheMissTokens - authCacheMiss);
		const estOut = state.estOutput + (state.step?.outputTokens ?? 0);
		if (nowPeak) {
			peak.cacheMiss += estMiss;
			peak.output += estOut;
		} else {
			offPeak.cacheMiss += estMiss;
			offPeak.output += estOut;
		}
		const costYuan = model === null ? null : deps.resolveCost(model, peak, offPeak);
		const totals = deps.getTotals();
		const budgetYuan = deps.getBudget();
		const pricing = model === null ? null : deps.resolvePricingEntry(model);
		const remainingMonth = budgetYuan > 0 ? budgetYuan - totals.month.costYuan : null;
		const remainingTotal = budgetYuan > 0 ? budgetYuan - totals.total.costYuan : null;
		const balance = deps.getBalance();
		return {
			model,
			status: streaming ? "estimating" : state.status,
			inputTokens,
			outputTokens,
			cacheHitTokens,
			cacheMissTokens,
			totalTokens: inputTokens + outputTokens,
			costYuan,
			durationMs: state.totalDurationMs,
			tokensPerSecond: state.totalDurationMs > 0 && outputTokens > 0 ? outputTokens / (state.totalDurationMs / 1e3) : null,
			calibrated: !streaming && state.status === "calibrated",
			pricing,
			budgetYuan,
			remainingMonth,
			remainingTotal,
			balance,
			totals
		};
	};
	return {
		key: "usageCost",
		schema: usageCostSchema,
		init,
		apply,
		view,
		stateVersion: 2
	};
}
//#endregion
//#region src/aggregates.ts
/**
* Cross-session aggregate store: today, this-month, and per-model token/cost
* totals accumulated from authoritative provider `usage`, persisted as one JSON
* document under the DSH home. A per-session sequence watermark makes
* accumulation idempotent across restarts and event replays. Local-only: no
* data ever leaves the machine.
*
* @module dsh-usage-cost/aggregates
*/
const PERSIST_VERSION = 1;
/** Debounce interval before an aggregate change is written to disk. */
const FLUSH_DELAY_MS = 500;
function emptyBucket() {
	return {
		costYuan: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheHitTokens: 0,
		cacheMissTokens: 0,
		requests: 0
	};
}
function todayKey(now) {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function monthKey(now) {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
function addBucket(target, inc) {
	return {
		costYuan: target.costYuan + inc.costYuan,
		inputTokens: target.inputTokens + inc.inputTokens,
		outputTokens: target.outputTokens + inc.outputTokens,
		cacheHitTokens: target.cacheHitTokens + inc.cacheHitTokens,
		cacheMissTokens: target.cacheMissTokens + inc.cacheMissTokens,
		requests: target.requests + inc.requests
	};
}
function cloneBucket(bucket) {
	return { ...bucket };
}
/** Parse a persisted document defensively; any malformed shape yields a fresh state. */
function parseDocument(raw) {
	try {
		const value = JSON.parse(raw);
		if (value === null || typeof value !== "object") return null;
		if (value.version !== PERSIST_VERSION) return null;
		if (typeof value.todayKey !== "string" || typeof value.monthKey !== "string") return null;
		return {
			version: PERSIST_VERSION,
			todayKey: value.todayKey,
			today: {
				...emptyBucket(),
				...value.today ?? {}
			},
			monthKey: value.monthKey,
			month: {
				...emptyBucket(),
				...value.month ?? {}
			},
			total: {
				...emptyBucket(),
				...value.total ?? {}
			},
			main: {
				...emptyBucket(),
				...value.main ?? {}
			},
			subagent: {
				...emptyBucket(),
				...value.subagent ?? {}
			},
			models: typeof value.models === "object" && value.models !== null ? Object.fromEntries(Object.entries(value.models).map(([k, v]) => [k, {
				...emptyBucket(),
				...v
			}])) : {},
			watermark: typeof value.watermark === "object" && value.watermark !== null ? value.watermark : {}
		};
	} catch {
		return null;
	}
}
/**
* Owns the durable today/month/model totals. The plugin fiber starts it once,
* records committed usage events, and disposes it (flushing) on unload.
*/
var UsageTotalsStore = class {
	filePath;
	pricing;
	peakWindows;
	state;
	flushTimer;
	dirty = false;
	disposed = false;
	/**
	* @param filePath - absolute JSON document path under the DSH home.
	* @param pricing - thunk returning the current validated pricing table.
	* @param peakWindows - thunk returning the current peak windows.
	*/
	constructor(filePath, pricing, peakWindows) {
		this.filePath = filePath;
		this.pricing = pricing;
		this.peakWindows = peakWindows;
		this.state = {
			version: PERSIST_VERSION,
			todayKey: todayKey(/* @__PURE__ */ new Date()),
			today: emptyBucket(),
			monthKey: monthKey(/* @__PURE__ */ new Date()),
			month: emptyBucket(),
			total: emptyBucket(),
			main: emptyBucket(),
			subagent: emptyBucket(),
			models: {},
			watermark: {}
		};
	}
	/** Load the persisted document if present, else start from empty totals. */
	async start() {
		try {
			const parsed = parseDocument(await readFile(this.filePath, "utf8"));
			if (parsed !== null) this.state = parsed;
		} catch (error) {
			if (error.code !== "ENOENT") console.warn("dsh-usage-cost: could not load aggregates; starting from empty totals", error);
		}
		this.rollover();
	}
	/** Reset today/month buckets when the local calendar rolled past their keys. */
	rollover() {
		const now = /* @__PURE__ */ new Date();
		if (this.state.todayKey !== todayKey(now)) {
			this.state.todayKey = todayKey(now);
			this.state.today = emptyBucket();
		}
		if (this.state.monthKey !== monthKey(now)) {
			this.state.monthKey = monthKey(now);
			this.state.month = emptyBucket();
		}
	}
	/**
	* Fold one authoritative usage record into the totals, idempotently by session
	* sequence watermark. Unpriced models accumulate tokens with zero cost.
	* @param sessionId - owning session identity.
	* @param seq - the assistant/message event sequence.
	* @param model - the raw provider model id.
	* @param usage - the authoritative provider usage.
	* @param category - whether the session is a top-level (main) or subagent (child) session.
	* @param time - the assistant/message event epoch-millisecond timestamp.
	*/
	record(sessionId, seq, model, usage, category, time) {
		if (this.disposed) return;
		const last = this.state.watermark[sessionId];
		if (last !== void 0 && seq <= last) return;
		this.rollover();
		const entry = matchModelPricing(model, this.pricing());
		const modelKey = entry?.id ?? (model.length > 0 ? model : "unknown");
		const cacheHit = usage.cacheReadTokens ?? 0;
		const cacheWrite = usage.cacheWriteTokens ?? 0;
		const cacheMiss = usage.inputTokens;
		const output = usage.outputTokens;
		const isPeak = isPeakTime(time, this.peakWindows());
		const inc = {
			costYuan: entry === void 0 ? 0 : computeCost(entry, isPeak ? {
				cacheHit,
				cacheMiss,
				output
			} : {
				cacheHit: 0,
				cacheMiss: 0,
				output: 0
			}, isPeak ? {
				cacheHit: 0,
				cacheMiss: 0,
				output: 0
			} : {
				cacheHit,
				cacheMiss,
				output
			}),
			inputTokens: cacheHit + cacheMiss + cacheWrite,
			outputTokens: output,
			cacheHitTokens: cacheHit,
			cacheMissTokens: cacheMiss,
			requests: 1
		};
		this.state.today = addBucket(this.state.today, inc);
		this.state.month = addBucket(this.state.month, inc);
		this.state.total = addBucket(this.state.total, inc);
		if (category === "subagent") this.state.subagent = addBucket(this.state.subagent, inc);
		else this.state.main = addBucket(this.state.main, inc);
		this.state.models[modelKey] = addBucket(this.state.models[modelKey] ?? emptyBucket(), inc);
		this.state.watermark[sessionId] = seq;
		this.scheduleFlush();
	}
	/** Detached snapshot of today/month/model totals. */
	snapshot() {
		this.rollover();
		return {
			today: cloneBucket(this.state.today),
			month: cloneBucket(this.state.month),
			total: cloneBucket(this.state.total),
			main: cloneBucket(this.state.main),
			subagent: cloneBucket(this.state.subagent),
			models: Object.fromEntries(Object.entries(this.state.models).map(([k, v]) => [k, cloneBucket(v)]))
		};
	}
	scheduleFlush() {
		this.dirty = true;
		if (this.flushTimer !== void 0) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = void 0;
			this.flush();
		}, FLUSH_DELAY_MS);
	}
	/** Write the current state to disk, creating the parent directory on demand. */
	async flush() {
		if (!this.dirty || this.disposed) return;
		this.dirty = false;
		try {
			await mkdir(dirname(this.filePath), { recursive: true });
			await writeFile(this.filePath, JSON.stringify(this.state), "utf8");
		} catch (error) {
			this.dirty = true;
			console.warn("dsh-usage-cost: could not persist aggregates", error);
		}
	}
	/** Cancel the debounce and flush pending totals (idempotent). */
	async dispose() {
		if (this.flushTimer !== void 0) {
			clearTimeout(this.flushTimer);
			this.flushTimer = void 0;
		}
		await this.flush();
		this.disposed = true;
	}
};
//#endregion
//#region src/balance.ts
const BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";
const REFRESH_MS = 3e5;
const EMPTY_BALANCE = {
	balanceYuan: null,
	error: null,
	fetchedAt: null
};
/**
* Owns the periodic balance fetch and the latest in-memory snapshot. Started by
* the plugin fiber, disposed (timer cleared) on unload.
*/
var BalancePoller = class {
	state = { ...EMPTY_BALANCE };
	timer;
	disposed = false;
	resolveKey;
	/**
	* @param resolveKey - thunk returning the API key, or null while unconfigured.
	*/
	constructor(resolveKey) {
		this.resolveKey = resolveKey;
	}
	/** Fetch once immediately, then on the refresh interval. */
	async start() {
		await this.refresh();
		if (this.disposed) return;
		this.timer = setInterval(() => {
			this.refresh();
		}, REFRESH_MS);
	}
	/** Fetch the current balance and replace the snapshot. Never throws. */
	async refresh() {
		if (this.disposed) return;
		try {
			const key = await this.resolveKey();
			if (key === null) {
				this.state = {
					balanceYuan: null,
					error: "未配置 DEEPSEEK_API_KEY",
					fetchedAt: null
				};
				return;
			}
			const response = await fetch(BALANCE_ENDPOINT, {
				headers: {
					Authorization: `Bearer ${key}`,
					Accept: "application/json"
				},
				signal: AbortSignal.timeout(15e3)
			});
			if (!response.ok) {
				this.state = {
					balanceYuan: null,
					error: `HTTP ${response.status}`,
					fetchedAt: null
				};
				return;
			}
			const data = await response.json();
			const raw = (data.balance_infos?.find((entry) => entry.currency === "CNY") ?? data.balance_infos?.[0])?.total_balance;
			const balanceYuan = raw === void 0 ? null : Number(raw);
			if (balanceYuan === null || !Number.isFinite(balanceYuan)) {
				this.state = {
					balanceYuan: null,
					error: "余额数据缺失",
					fetchedAt: null
				};
				return;
			}
			this.state = {
				balanceYuan,
				error: null,
				fetchedAt: Date.now()
			};
		} catch (error) {
			this.state = {
				balanceYuan: null,
				error: error instanceof Error ? error.message : "网络错误",
				fetchedAt: null
			};
		}
	}
	/** Detached copy of the latest balance snapshot. */
	snapshot() {
		return { ...this.state };
	}
	/** Stop the refresh timer (idempotent). */
	dispose() {
		this.disposed = true;
		if (this.timer !== void 0) clearInterval(this.timer);
		this.timer = void 0;
	}
};
//#endregion
//#region src/index.ts
/**
* Host half of dsh-usage-cost: registers the `usageCost` session projection
* (live per-session usage/cost), accumulates cross-session today/month/model
* totals from authoritative usage, and installs a user-settings section for the
* configurable DeepSeek pricing table. Everything stays local.
*
* @module dsh-usage-cost
*/
/** Cordis plugin name (also the row id in cordis.yml). */
const name = "usage-cost";
/** No hard dependencies: the projection and settings registrations are optional children. */
const inject = [];
/** Settings namespace for the pricing table and throttle tunables. */
const NS = settingsNamespace("usage-cost");
const pricingEntrySchema = z.object({
	id: z.string().required(),
	cacheHit: z.number().min(0),
	cacheMiss: z.number().min(0),
	output: z.number().min(0),
	peakCacheHit: z.any(),
	peakCacheMiss: z.any(),
	peakOutput: z.any()
});
const peakWindowSchema = z.object({
	start: z.number().min(0).max(1439),
	end: z.number().min(0).max(1440)
});
/** Plugin config, also the settings-section shape (schema defaults fill omissions). */
const Config = z.object({
	models: z.array(pricingEntrySchema).default(DEFAULT_CONFIG.models),
	budgetYuan: z.number().min(0).default(DEFAULT_CONFIG.budgetYuan),
	peakWindows: z.array(peakWindowSchema).default(DEFAULT_CONFIG.peakWindows),
	chunkInterval: z.number().step(1).min(1).default(DEFAULT_CONFIG.chunkInterval),
	timeIntervalMs: z.number().min(0).default(DEFAULT_CONFIG.timeIntervalMs)
});
/**
* Compose the usage/cost host capabilities for one plugin fiber.
* @param ctx - Cordis context owning every effect below.
* @param config - composition entry config (possibly partial); settings may override it.
*/
function apply(ctx, config = {}) {
	const base = {
		models: config.models ?? DEFAULT_CONFIG.models,
		budgetYuan: config.budgetYuan ?? DEFAULT_CONFIG.budgetYuan,
		peakWindows: config.peakWindows ?? DEFAULT_CONFIG.peakWindows,
		chunkInterval: config.chunkInterval ?? DEFAULT_CONFIG.chunkInterval,
		timeIntervalMs: config.timeIntervalMs ?? DEFAULT_CONFIG.timeIntervalMs
	};
	let current = () => base;
	let pricing = resolvePricing(base.models);
	const recompute = () => {
		pricing = resolvePricing(current().models);
	};
	recompute();
	const resolveCost = (model, peak, offPeak) => {
		const entry = matchModelPricing(model, pricing);
		if (entry === void 0) return null;
		return computeCost(entry, peak, offPeak);
	};
	const resolvePricingEntry = (model) => matchModelPricing(model, pricing) ?? null;
	const getBudget = () => current().budgetYuan;
	const isPeak = (epochMs) => isPeakTime(epochMs, current().peakWindows);
	installSettingsSection(ctx, NS, Config, base, {
		setSource: (source) => {
			current = source;
		},
		onChange: recompute
	});
	const resolveApiKey = async () => {
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const resolved = await credentials.resolve("DEEPSEEK_API_KEY");
			if (resolved !== void 0 && resolved.value.length > 0) return resolved.value;
		}
		const envKey = process.env.DEEPSEEK_API_KEY;
		if (envKey !== void 0 && envKey.length > 0) return envKey;
		try {
			const text = await readFile(dshHomePath(".credentials.yaml"), "utf8");
			const match = /^\s*DEEPSEEK_API_KEY\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*$/m.exec(text);
			const value = match !== null ? match[1] ?? match[2] ?? match[3] : null;
			if (value !== null && value.length > 0) return value;
		} catch {}
		return null;
	};
	let balanceSnapshot = () => EMPTY_BALANCE;
	const balancePoller = new BalancePoller(resolveApiKey);
	balanceSnapshot = () => balancePoller.snapshot();
	ctx.effect(() => {
		balancePoller.start();
		return () => balancePoller.dispose();
	}, "usage-cost: balance poller");
	const totals = new UsageTotalsStore(dshHomePath("usage-cost", "aggregates.json"), () => pricing, () => current().peakWindows);
	ctx.effect(() => {
		totals.start();
		return () => {
			totals.dispose();
		};
	}, "usage-cost: totals store");
	const modelBySession = /* @__PURE__ */ new WeakMap();
	ctx.on("session/event", (session, event) => {
		if (event.type === "request/header") {
			modelBySession.set(session, event.data.header.config.model);
			return;
		}
		if (event.type === "assistant/message" && event.data.usage !== void 0) {
			const header = session.header;
			const category = header.origin === "subagent" || (header.delegationDepth ?? 0) >= 1 ? "subagent" : "main";
			totals.record(session.id, event.seq, modelBySession.get(session) ?? "", event.data.usage, category, event.time);
		}
	});
	ctx.inject(["sessionProjections"], (projectionCtx) => {
		projectionCtx.sessionProjections.register(createUsageCostProjection({
			resolveCost,
			isPeakTime: isPeak,
			resolvePricingEntry,
			getBudget,
			getBalance: () => balanceSnapshot(),
			getTotals: () => totals.snapshot(),
			chunkInterval: base.chunkInterval,
			timeIntervalMs: base.timeIntervalMs
		}));
	});
}
//#endregion
export { Config, apply, inject, name };
