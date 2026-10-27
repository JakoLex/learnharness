/**
 * LOCAL OpenAI-compatible providers (Jakob's LAN fleet): llama-swap on the
 * RTX 3090 (jakolexpc) and SlopGate (jbkp). Registered next to pi-ai's
 * builtins so the picker federates them exactly like any keyed provider —
 * presence of the env key gates visibility (see server/model-catalog.ts).
 *
 * Keys ride the environment (the keys seam reflects file-saved keys into
 * env too): LLAMA_SWAP_KEY may be any non-empty value (llama-swap
 * validates nothing); SLOPGATE_KEY is a real credential.
 *
 * Catalogs are static baselines synced from the servers' live /v1/models
 * (2026-10-26) — refresh this file when the llama-swap model set shifts.
 * Embeddings/rerankers/image-gen are excluded: not chat models.
 */
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Model } from "@earendil-works/pi-ai";

interface LocalCatalogEntry {
	id: string;
	name: string;
	contextWindow: number;
	vision: boolean;
	reasoning: boolean;
	/** Output budget incl. thinking — same values as the dsh profiles (2026-10-26). */
	maxTokens: number;
}

function localModel(provider: string, baseUrl: string, e: LocalCatalogEntry): Model<"openai-completions"> {
	return {
		id: e.id,
		name: e.name,
		api: "openai-completions",
		provider,
		baseUrl,
		input: e.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: e.reasoning,
		contextWindow: e.contextWindow,
		// Was min(8192, ctx/2): Qwen3.8 at thinking "high" burns past 8192 on thinking alone
		// and stops with finish_reason "length" before calling the tool (notes extractor, 2026-10-26).
		maxTokens: e.maxTokens,
		type: "chat",
	};
}

/** Ambient api-key auth: a stored credential wins, else the env var. */
function envKeyAuth(name: string, envVar: string) {
	return {
		name,
		resolve: async ({ credential }: { credential?: { key?: string } }) => {
			const key = credential?.key ?? process.env[envVar];
			return key ? { auth: { apiKey: key }, source: credential?.key ? "stored credential" : envVar } : undefined;
		},
	};
}

function localProvider(id: string, label: string, baseUrl: string, envVar: string, entries: LocalCatalogEntry[]) {
	return createProvider({
		id,
		name: label,
		baseUrl,
		auth: { apiKey: envKeyAuth(`${label} API key`, envVar) },
		models: entries.map((e) => localModel(id, baseUrl, e)),
		api: openAICompletionsApi(),
	});
}

const LLAMA_SWAP_URL = process.env.LH_LLAMA_SWAP_URL ?? "http://jakolexpc.fritz.box:8080/v1";
const SLOPGATE_URL = process.env.LH_SLOPGATE_URL ?? "http://jbkp.fritz.box:8081/v1";

export function localProviders() {
	return [
		localProvider("llama-swap", "llama-swap · RTX 3090", LLAMA_SWAP_URL, "LLAMA_SWAP_KEY", [
			{ id: "ninfer/qwen3.8:27b-3090-rk8v4@256k", name: "Qwen3.8 27b NInfer (256k)", contextWindow: 262144, vision: true, reasoning: true, maxTokens: 65536 },
			{ id: "strata/qwen3.8-flash-next:125b-iq3_s@128k", name: "Qwen3.8 Flash 125b Strata (128k)", contextWindow: 131072, vision: true, reasoning: true, maxTokens: 65536 },
			{ id: "unsloth/qwen3.8:27b-ud-q5_k_s@131k", name: "Qwen3.8 27b UD q5_k_s (131k)", contextWindow: 131072, vision: true, reasoning: true, maxTokens: 65536 },
			{ id: "unsloth/qwen3.8:27b-ud-q5_k_s@64k", name: "Qwen3.8 27b UD q5_k_s (64k)", contextWindow: 64000, vision: true, reasoning: true, maxTokens: 40000 },
			{ id: "unsloth/muse-glimmer:30b-ud-q5_k_m@131k", name: "Muse Glimmer 30b UD (131k)", contextWindow: 131072, vision: true, reasoning: false, maxTokens: 65536 },
			{ id: "unsloth/gemma4:31b-it-ud-q4_k_xl@64k", name: "Gemma4 31b UD (64k)", contextWindow: 65536, vision: true, reasoning: false, maxTokens: 32768 },
		]),
		localProvider("slopgate", "SlopGate", SLOPGATE_URL, "SLOPGATE_KEY", [
			{ id: "jundot/qwen3.8:125b-flash-next-oq4e-mtp@256k", name: "Qwen3.8 Flash 125b SlopGate (256k)", contextWindow: 262144, vision: true, reasoning: true, maxTokens: 49152 },
		]),
	];
}
