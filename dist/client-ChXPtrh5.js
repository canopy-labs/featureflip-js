//#region src/config.ts
var e = {
	streaming: !0,
	pollInterval: 3e4,
	flushInterval: 3e4,
	flushBatchSize: 100,
	initTimeout: 1e4,
	maxStreamRetries: 5
};
function t(t) {
	if (!t.sdkKey) throw Error("sdkKey is required");
	if (!t.baseUrl) throw Error("baseUrl is required");
	let n = t.baseUrl.replace(/\/+$/, "");
	return {
		sdkKey: t.sdkKey,
		baseUrl: n,
		streaming: t.streaming ?? e.streaming,
		pollInterval: t.pollInterval ?? e.pollInterval,
		flushInterval: t.flushInterval ?? e.flushInterval,
		flushBatchSize: t.flushBatchSize ?? e.flushBatchSize,
		initTimeout: t.initTimeout ?? e.initTimeout,
		maxStreamRetries: t.maxStreamRetries ?? e.maxStreamRetries
	};
}
//#endregion
//#region src/core/store.ts
var n = class {
	flags = /* @__PURE__ */ new Map();
	segments = /* @__PURE__ */ new Map();
	listeners = [];
	version = 0;
	getFlag(e) {
		return this.flags.get(e);
	}
	getSegment(e) {
		return this.segments.get(e);
	}
	getAllFlags() {
		return Array.from(this.flags.values());
	}
	getVersion() {
		return this.version;
	}
	init(e, t, n) {
		this.flags.clear(), this.segments.clear();
		for (let t of e) this.flags.set(t.key, t);
		for (let e of t) this.segments.set(e.key, e);
		this.version = n;
		for (let t of e) this.notifyListeners(t.key);
	}
	upsert(e) {
		let t = this.flags.get(e.key);
		t && t.version >= e.version || (this.flags.set(e.key, e), this.notifyListeners(e.key));
	}
	delete(e) {
		this.flags.delete(e) && this.notifyListeners(e);
	}
	onChange(e) {
		return this.listeners.push(e), () => {
			let t = this.listeners.indexOf(e);
			t >= 0 && this.listeners.splice(t, 1);
		};
	}
	notifyListeners(e) {
		for (let t of this.listeners) try {
			t(e);
		} catch {}
	}
};
//#endregion
//#region src/core/evaluator.ts
function r(e, t, n) {
	let r = n(`${e}:${t}`);
	return ((r[0] | r[1] << 8 | r[2] << 16 | r[3] << 24 >>> 0) >>> 0) % 100;
}
function i(e, t) {
	let n = e[t];
	if (n !== void 0) return n;
	if (t === "userId") return e.user_id;
	if (t === "user_id") return e.userId;
}
function a(e, t, n) {
	switch (e) {
		case "Equals": return n.some((e) => t === e);
		case "NotEquals": return n.every((e) => t !== e);
		case "Contains": return n.some((e) => t.includes(e));
		case "NotContains": return n.every((e) => !t.includes(e));
		case "StartsWith": return n.some((e) => t.startsWith(e));
		case "EndsWith": return n.some((e) => t.endsWith(e));
		case "In": return n.includes(t);
		case "NotIn": return !n.includes(t);
		case "MatchesRegex": return n.some((e) => {
			try {
				return new RegExp(e, "i").test(t);
			} catch {
				return !1;
			}
		});
		case "GreaterThan": return o(t, n[0], ">");
		case "GreaterThanOrEqual": return o(t, n[0], ">=");
		case "LessThan": return o(t, n[0], "<");
		case "LessThanOrEqual": return o(t, n[0], "<=");
		case "Before": return t < n[0];
		case "After": return t > n[0];
		default: return !1;
	}
}
function o(e, t, n) {
	let r = parseFloat(e), i = parseFloat(t);
	if (isNaN(r) || isNaN(i)) return !1;
	switch (n) {
		case ">": return r > i;
		case "<": return r < i;
		case ">=": return r >= i;
		case "<=": return r <= i;
	}
}
function s(e, t) {
	let n = i(t, e.attribute);
	if (n == null) return e.negate;
	let r = String(n).toLowerCase(), o = e.values.map((e) => e.toLowerCase()), s = a(e.operator, r, o);
	return e.negate ? !s : s;
}
function c(e, t, n) {
	return e.length === 0 ? !0 : t === "And" ? e.every((e) => s(e, n)) : e.some((e) => s(e, n));
}
function l(e, t) {
	return e.length === 0 ? !0 : e.every((e) => c(e.conditions, e.operator, t));
}
function u(e, t, n) {
	if (e.type === "Fixed") return e.variation ?? "";
	let a = i(t, e.bucketBy ?? "userId"), o = a == null ? "" : String(a), s = r(e.salt ?? "", o, n), c = 0;
	for (let t of e.variations ?? []) if (c += t.weight, s < c) return t.key;
	let l = e.variations ?? [];
	return l.length > 0 ? l[l.length - 1].key : "";
}
function d(e, t, n) {
	if (!e.enabled) return {
		value: e.variations.find((t) => t.key === e.offVariation)?.value ?? null,
		variationKey: e.offVariation,
		reason: "FlagDisabled"
	};
	let r = [...e.rules].sort((e, t) => e.priority - t.priority);
	for (let i of r) {
		let r;
		if (i.segmentKey && n.getSegment) {
			let e = n.getSegment(i.segmentKey);
			r = e ? c(e.conditions, e.conditionLogic, t) : !1;
		} else r = l(i.conditionGroups, t);
		if (r) {
			let r = u(i.serve, t, n.md5);
			return {
				value: e.variations.find((e) => e.key === r)?.value ?? null,
				variationKey: r,
				reason: "RuleMatch",
				ruleId: i.id
			};
		}
	}
	let i = u(e.fallthrough, t, n.md5);
	return {
		value: e.variations.find((e) => e.key === i)?.value ?? null,
		variationKey: i,
		reason: "Fallthrough"
	};
}
//#endregion
//#region src/core/events.ts
var f = class {
	queue = [];
	flushTimer = null;
	closed = !1;
	flushPromise = null;
	constructor(e, t, n) {
		this.sender = e, this.flushInterval = t, this.flushBatchSize = n;
	}
	start() {
		this.flushTimer ||= setInterval(() => {
			this.flush();
		}, this.flushInterval);
	}
	enqueue(e) {
		this.closed || (this.queue.push(e), this.queue.length >= this.flushBatchSize && this.flush());
	}
	async flush() {
		if (this.queue.length !== 0) return this.flushPromise ||= (async () => {
			for (; this.queue.length > 0;) {
				let e = this.queue.splice(0, this.flushBatchSize);
				try {
					await this.sender.sendEvents({ events: e });
				} catch {}
			}
		})().finally(() => {
			this.flushPromise = null;
		}), this.flushPromise;
	}
	async close() {
		for (this.closed = !0, this.flushTimer &&= (clearInterval(this.flushTimer), null); this.queue.length > 0;) await this.flush();
	}
}, p = class e {
	config;
	store;
	events;
	platform;
	initialized = !1;
	initPromise = null;
	eventSource = null;
	pollTimer = null;
	closed = !1;
	streamRetryCount = 0;
	streamRetryTimer = null;
	constructor(e, r) {
		this.config = t(e), this.store = new n(), this.platform = r, this.events = new f({ sendEvents: async (e) => {
			await this.platform.fetch(`${this.config.baseUrl}/v1/sdk/events`, {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify(e)
			});
		} }, this.config.flushInterval, this.config.flushBatchSize);
	}
	get isInitialized() {
		return this.initialized;
	}
	async waitForInitialization() {
		if (!this.initialized) return this.initPromise ||= this.initialize(), this.initPromise;
	}
	boolVariation(e, t, n) {
		return this.evaluateFlag(e, t, n);
	}
	stringVariation(e, t, n) {
		return this.evaluateFlag(e, t, n);
	}
	numberVariation(e, t, n) {
		return this.evaluateFlag(e, t, n);
	}
	jsonVariation(e, t, n) {
		return this.evaluateFlag(e, t, n);
	}
	variationDetail(e, t, n) {
		let r = this.store.getFlag(e);
		if (!r) return this.recordEvaluation(e, t, void 0), {
			value: n,
			reason: "FlagNotFound"
		};
		try {
			let i = d(r, t, {
				md5: (e) => this.platform.md5(e),
				getSegment: (e) => this.store.getSegment(e)
			}), a = i.value !== void 0 && i.value !== null ? i.value : n;
			return this.recordEvaluation(e, t, i.variationKey), {
				value: a,
				reason: i.reason,
				ruleId: i.ruleId
			};
		} catch {
			return this.recordEvaluation(e, t, void 0), {
				value: n,
				reason: "Error"
			};
		}
	}
	track(e, t, n) {
		let r = t.user_id == null ? void 0 : String(t.user_id);
		this.events.enqueue({
			type: "Custom",
			flagKey: e,
			userId: r,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			metadata: n
		});
	}
	identify(e) {
		let t = e.user_id == null ? void 0 : String(e.user_id), { user_id: n, ...r } = e;
		this.events.enqueue({
			type: "Identify",
			flagKey: "$identify",
			userId: t,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			metadata: Object.keys(r).length > 0 ? r : void 0
		});
	}
	async flush() {
		await this.events.flush();
	}
	async close() {
		this.closed = !0, this.eventSource?.close(), this.eventSource = null, this.streamRetryTimer &&= (clearTimeout(this.streamRetryTimer), null), this.pollTimer &&= (clearInterval(this.pollTimer), null), await this.events.close();
	}
	static forTesting(t) {
		let n = Object.entries(t).map(([e, t]) => ({
			key: e,
			version: 1,
			type: typeof t == "boolean" ? "Boolean" : typeof t == "number" ? "Number" : typeof t == "string" ? "String" : "Json",
			enabled: !0,
			variations: [{
				key: "default",
				value: t
			}],
			rules: [],
			fallthrough: {
				type: "Fixed",
				variation: "default"
			},
			offVariation: "default"
		})), r = new e({
			sdkKey: "test-key",
			baseUrl: "http://localhost"
		}, {
			md5: () => new Uint8Array(16),
			createEventSource: () => ({
				addEventListener: () => {},
				close: () => {},
				readyState: 2
			}),
			fetch: async () => new Response()
		});
		return r.store.init(n, [], 1), r.initialized = !0, r;
	}
	evaluateFlag(e, t, n) {
		return this.variationDetail(e, t, n).value;
	}
	async initialize() {
		let e, t = new Promise((t, n) => {
			e = setTimeout(() => n(/* @__PURE__ */ Error("Initialization timed out")), this.config.initTimeout);
		}), n = (async () => {
			await this.fetchFlags(), this.initialized = !0, this.events.start(), this.startDataSource();
		})();
		try {
			await Promise.race([n, t]);
		} finally {
			clearTimeout(e);
		}
	}
	async fetchFlags() {
		let e = await this.platform.fetch(`${this.config.baseUrl}/v1/sdk/flags`, { headers: this.headers() });
		if (!e.ok) throw Error(`Failed to fetch flags: ${e.status}`);
		let t = await e.json();
		this.store.init(t.flags, t.segments, t.version);
	}
	startDataSource() {
		this.closed || (this.config.streaming ? this.startStreaming() : this.startPolling());
	}
	startStreaming() {
		if (this.closed) return;
		let e = this.platform.sseSupportsHeaders ? `${this.config.baseUrl}/v1/sdk/stream` : `${this.config.baseUrl}/v1/sdk/stream?authorization=${encodeURIComponent(this.config.sdkKey)}`;
		this.eventSource = this.platform.createEventSource(e, this.headers());
		for (let e of ["flag.created", "flag.updated"]) this.eventSource.addEventListener(e, (e) => {
			try {
				let t = JSON.parse(e.data);
				t.key && this.fetchSingleFlag(t.key);
			} catch {}
		});
		this.eventSource.addEventListener("flag.deleted", (e) => {
			try {
				let t = JSON.parse(e.data);
				t.key && this.store.delete(t.key);
			} catch {}
		}), this.eventSource.addEventListener("segment.updated", () => {
			this.fetchFlags().catch(() => {});
		}), this.eventSource.addEventListener("open", () => {
			this.streamRetryCount = 0;
		}), this.eventSource.addEventListener("error", () => {
			if (this.eventSource?.close(), this.eventSource = null, this.closed) return;
			if (this.streamRetryCount >= this.config.maxStreamRetries) {
				console.warn(`[featureflip] SSE connection failed after ${this.config.maxStreamRetries} retries, falling back to polling`), this.startPolling();
				return;
			}
			let e = Math.min(1e3 * 2 ** this.streamRetryCount, 3e4);
			this.streamRetryCount++, this.streamRetryTimer = setTimeout(() => {
				this.streamRetryTimer = null, this.startStreaming();
			}, e);
		});
	}
	startPolling() {
		this.pollTimer = setInterval(() => {
			this.fetchFlags().catch(() => {});
		}, this.config.pollInterval);
	}
	async fetchSingleFlag(e) {
		try {
			let t = await this.platform.fetch(`${this.config.baseUrl}/v1/sdk/flags/${encodeURIComponent(e)}`, { headers: this.headers() });
			if (t.ok) {
				let e = await t.json();
				this.store.upsert(e);
			}
		} catch {}
	}
	recordEvaluation(e, t, n) {
		let r = t.user_id == null ? void 0 : String(t.user_id);
		this.events.enqueue({
			type: "Evaluation",
			flagKey: e,
			userId: r,
			variation: n,
			timestamp: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	headers() {
		return {
			Authorization: this.config.sdkKey,
			"Content-Type": "application/json",
			...this.platform.extraHeaders
		};
	}
};
//#endregion
export { p as t };
