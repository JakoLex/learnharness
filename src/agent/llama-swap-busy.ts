/**
 * IS THE GPU BUSY? (overflow wave, owner-approved 2026-10-28) — the
 * llama-swap side of the busy overflow: before a call on a llama-swap
 * model, ask llama-swap which requests are in flight and, when the GPU is
 * taken, let the slot's fallback answer instead (model-fallback.ts). The
 * rule is the owner's Open WebUI filter `gpu_overflow` (v2.2) `_busy`:
 *
 * - the in-flight list comes from GET <llama-swap>/api/events (SSE): read
 *   until the first `inflight` snapshot, then close; 2 s budget;
 * - requests on CPU models (embeddings, OCR, loaders) never count;
 * - no GPU request in flight → free;
 * - a PARALLEL model (several lanes) is free while every GPU request is on
 *   that same model;
 * - otherwise busy; unreachable or too slow counts as busy too.
 *
 * Fork-specific like local-providers.ts; the model lists come from env
 * (LH_LLAMA_SWAP_CPU_MODELS, LH_LLAMA_SWAP_PARALLEL_MODELS, comma lists).
 */

export interface InflightRequest {
	model?: string;
}

export interface BusyVerdict {
	busy: boolean;
	/** Human reason for the transcript note / the down-mark. */
	reason?: string;
	/** True when llama-swap could not be asked at all. */
	unreachable?: boolean;
}

export interface OverflowRules {
	cpuModels: ReadonlySet<string>;
	parallelModels: ReadonlySet<string>;
}

/** The owner's `_busy` over one in-flight snapshot (pure). */
export function busyFromSnapshot(requests: readonly InflightRequest[], model: string, rules: OverflowRules): BusyVerdict {
	const gpu = requests.filter((r) => !r.model || !rules.cpuModels.has(r.model));
	if (gpu.length === 0) return { busy: false };
	if (rules.parallelModels.has(model) && gpu.every((r) => r.model === model)) return { busy: false };
	const models = [...new Set(gpu.map((r) => r.model ?? "unknown"))];
	return { busy: true, reason: `GPU busy (${models.join(", ")})` };
}

/** Read llama-swap's event stream until the first in-flight snapshot. */
export async function inflightSnapshot(eventsUrl: string, timeoutMs = 2000, fetchImpl: typeof fetch = globalThis.fetch): Promise<InflightRequest[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(eventsUrl, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
		if (!res.ok || !res.body) throw new Error(`llama-swap events answered ${res.status}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) throw new Error("llama-swap events ended before the in-flight snapshot");
			buffer += decoder.decode(value, { stream: true });
			let end: number;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (!data) continue;
				let event: { type?: string; data?: unknown };
				try {
					event = JSON.parse(data) as { type?: string; data?: unknown };
				} catch {
					continue;
				}
				let payload = event.data;
				// llama-swap sends `data` as a JSON string on some versions.
				if (typeof payload === "string") {
					try {
						payload = JSON.parse(payload);
					} catch {
						continue;
					}
				}
				const p = payload as { operation?: string; requests?: unknown } | null;
				if (event.type === "inflight" && p?.operation === "snapshot") {
					void reader.cancel().catch(() => {});
					return Array.isArray(p.requests) ? (p.requests as InflightRequest[]) : [];
				}
			}
		}
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

/** The env-configured rules and the events URL for a llama-swap base URL. */
export function llamaSwapOverflowSetup(baseUrl: string, env: Record<string, string | undefined> = process.env): { eventsUrl: string; rules: OverflowRules } {
	const list = (raw: string | undefined) => new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean));
	return {
		eventsUrl: `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/events`,
		rules: { cpuModels: list(env.LH_LLAMA_SWAP_CPU_MODELS), parallelModels: list(env.LH_LLAMA_SWAP_PARALLEL_MODELS) },
	};
}

/** One busy check for `model` (unreachable → busy). */
export async function llamaSwapBusy(model: string, setup: { eventsUrl: string; rules: OverflowRules }, fetchImpl?: typeof fetch): Promise<BusyVerdict> {
	try {
		return busyFromSnapshot(await inflightSnapshot(setup.eventsUrl, 2000, fetchImpl), model, setup.rules);
	} catch {
		return { busy: true, unreachable: true, reason: "GPU host unreachable" };
	}
}
