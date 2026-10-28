import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type Models,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { localProviders } from "./local-providers.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import type { ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { nativeSubscriptionId, nativeSubscriptionModel } from "./subscription-bridge.ts";
import { nativeSubscriptionStream } from "./subscription-stream.ts";
import { withModelFallback } from "./model-fallback.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/pi-engine-swap.md). BYOK ALL THE WAY DOWN (owner, 2026-09-22):
 * there are no factory pins — every engine resolves from a RESOLVED SPEC
 * (the settings chain's output) and the one builder here wires it to
 * pi-ai's federated catalogs.
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Production engines resolve the model
 * from pi-ai's static catalogs and stream through the same Models
 * collection.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
	/** The fallback the streamFn falls back to (fallback wave, owner
	 *  2026-10-28) — absent when none is configured or usable. */
	fallback?: { model: Model<Api>; level: ThinkingLevel };
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;

/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
		// Local LAN fleet (llama-swap 3090 + SlopGate) — same federation as
		// the builtins: keyed providers appear in the picker, see local-providers.ts.
		for (const provider of localProviders()) collection.setProvider(provider);
	}
	return collection;
}

/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
	/** The slot's fallback (fallback wave, owner 2026-10-28). */
	fallback?: ResolvedModelSpec;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle): PiEngine {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	const model = spec.provider === "chatgpt" ? chatGPTModel(spec.id) : nativeId ? nativeSubscriptionModel(spec.provider, spec.id) : models.getModel(spec.provider, spec.id);
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	const level = resolvedLevel(model, spec.thinkingLevel);
	// bound streamSimple: the agent loop forwards state.thinkingLevel as
	// `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
	// the pin honest even when config or settings drift off the map.
	const primary: StreamFunction = (requestModel, context, options) => {
		const purpose = typeof background === "function" ? background : () => background;
		const stream = spec.provider === "chatgpt" ? chatGPTStream(purpose, lifecycle) : nativeId ? nativeSubscriptionStream(models.getProvider(nativeId)!, purpose, lifecycle) : models.streamSimple.bind(models);
		return stream(requestModel, context, { ...options, reasoning: level === "off" ? undefined : level });
	};
	// THE FALLBACK (fallback wave, owner 2026-10-28): ordinary API/local
	// routes only — a subscription primary keeps the upstream no-fallback
	// rule and a subscription is never a fallback. An unusable fallback pin
	// (gone from the catalog) leaves the primary alone instead of failing it.
	const fallbackSpec = spec.fallback;
	const fallbackModel =
		fallbackSpec && !subscriptionRoute(spec.provider) && !subscriptionRoute(fallbackSpec.provider)
			? models.getModel(fallbackSpec.provider, fallbackSpec.id)
			: undefined;
	if (fallbackSpec && !fallbackModel && !subscriptionRoute(spec.provider)) {
		console.warn(`[models] fallback ${fallbackSpec.provider}:${fallbackSpec.id} unavailable — ${spec.provider}:${spec.id} runs without one`);
	}
	if (!fallbackModel) return { model, level, streamFn: primary };
	const fallbackLevel = resolvedLevel(fallbackModel, fallbackSpec!.thinkingLevel);
	return {
		model,
		level,
		fallback: { model: fallbackModel, level: fallbackLevel },
		streamFn: withModelFallback(
			{ key: `${model.provider}:${model.id}`, stream: primary },
			{
				key: `${fallbackModel.provider}:${fallbackModel.id}`,
				model: fallbackModel,
				stream: (requestModel, context, options) =>
					models.streamSimple(requestModel, context, { ...options, reasoning: fallbackLevel === "off" ? undefined : fallbackLevel }),
			},
		),
	};
}

/** UNSET level → the baked default order (first entry the model supports);
 *  SET level → pi's native nearest-clamp (model swaps keep the user's
 *  intent and adapt honestly). */
function resolvedLevel(model: Model<Api>, level: ThinkingLevel | undefined): ThinkingLevel {
	return level ? clampThinkingLevel(model, level) : defaultThinkingLevel(model);
}

/** chatgpt + the native subscription routes (never part of a fallback). */
function subscriptionRoute(provider: string): boolean {
	return provider === "chatgpt" || !!nativeSubscriptionId(provider);
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
