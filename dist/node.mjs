import { t as e } from "./client-ChXPtrh5.js";
import { createHash as t } from "crypto";
import { createRequire as n } from "module";
//#region src/platform/node.ts
var r = n(import.meta.url);
function i() {
	return {
		md5(e) {
			return t("md5").update(e, "utf8").digest();
		},
		createEventSource(e, t) {
			let { EventSource: n } = r("eventsource"), i = new n(e, { fetch: (e, n) => globalThis.fetch(e, {
				...n,
				headers: {
					...n?.headers,
					...t
				}
			}) });
			return {
				addEventListener: (e, t) => {
					i.addEventListener(e, t);
				},
				close: () => i.close(),
				get readyState() {
					return i.readyState;
				}
			};
		},
		async fetch(e, t) {
			return globalThis.fetch(e, t);
		},
		extraHeaders: { "User-Agent": "featureflip-js/0.1.0" },
		sseSupportsHeaders: !0
	};
}
//#endregion
export { e as FeatureflipClient, i as createNodePlatform };
