/**
 * Context composition (the context panel, 2026-10-28): what fills a model
 * request, bucketed by content type, each bucket an estimate. The panel's
 * headline stays the MEASURED meter (context-usage.ts); these buckets only
 * divide it into shares.
 *
 * Adapted from OpenScience (Apache-2.0, github.com/synthetic-sciences/
 * openscience @ c971e7f): Token.estimate, MessageV2.composition and
 * toolTokens (server), contextSegments (workspace). Changed for LearnHarness:
 * runs on pi's provider wire instead of OpenScience's message parts, no
 * skills/documents buckets, images at the compaction port's fixed
 * allowance. See docs/context-panel.md.
 *
 * Runs on the PROVIDER WIRE (pi Messages, after toLlmMessages): the server
 * records it from prepareRequest's assembled request, where the leading
 * system message carries the prompt and the tool declarations. The client
 * falls back to the same function over its transcript, which never holds
 * that system message — so its system/definitions buckets stay unrecorded.
 */
import type { Message, TextContent, ImageContent } from "@earendil-works/pi-ai";
import { asAgentMessages, toLlmMessages, type LhMessage } from "./native-messages.ts";

export const CONTEXT_BUCKETS = ["system", "definitions", "text", "reasoning", "tool", "image"] as const;
export type ContextBucket = (typeof CONTEXT_BUCKETS)[number];
/** Estimated tokens per bucket for one request (persisted per call on
 *  CallUsage.context). */
export type ContextComposition = Record<ContextBucket, number>;

/** The compaction port's fixed image allowance (ESTIMATED_IMAGE_CHARS / 4). */
export const IMAGE_TOKENS = 1_200;

/** OpenScience's Token.estimate: four ASCII characters per token, every
 *  other UTF-16 unit at least one — chars/4 alone undercounts umlauts,
 *  math symbols and other multibyte text several times over. */
export function estimateTextTokens(text: string): number {
	let score = 0;
	for (const char of text) score += char.charCodeAt(0) <= 0x7f ? 0.25 : char.length;
	return Math.ceil(score);
}

/** Bucket one request's messages. Never throws: unknown shapes count
 *  nothing (the server calls this inside prepareRequest). */
export function contextComposition(messages: readonly Message[]): ContextComposition {
	const out: ContextComposition = { system: 0, definitions: 0, text: 0, reasoning: 0, tool: 0, image: 0 };
	const blocks = (bucket: "text" | "tool", content: string | readonly (TextContent | ImageContent)[] | undefined) => {
		if (typeof content === "string") {
			out[bucket] += estimateTextTokens(content);
			return;
		}
		for (const block of content ?? []) {
			if (block?.type === "text") out[bucket] += estimateTextTokens(block.text ?? "");
			else if (block?.type === "image") out.image += IMAGE_TOKENS;
		}
	};
	for (const message of messages) {
		switch (message?.role) {
			case "system": {
				const content = message.content;
				out.system += estimateTextTokens(typeof content === "string" ? content : (content ?? []).map((block) => block?.text ?? "").join(""));
				for (const section of Object.values(message.sections ?? {})) if (section) out.system += estimateTextTokens(section);
				for (const tool of message.toolsAdded ?? []) {
					out.definitions += estimateTextTokens(JSON.stringify({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? {} }));
				}
				break;
			}
			case "user":
				blocks("text", message.content);
				break;
			case "assistant":
				for (const block of message.content ?? []) {
					if (block?.type === "text") out.text += estimateTextTokens(block.text ?? "");
					// Redacted thinking travels as an opaque signature — not
					// measured, like every encrypted signature (compaction law).
					else if (block?.type === "thinking") out.reasoning += block.redacted ? 0 : estimateTextTokens(block.thinking ?? "");
					else if (block?.type === "toolCall") out.tool += estimateTextTokens(block.name + JSON.stringify(block.arguments ?? {}));
				}
				break;
			case "toolResult":
				blocks("tool", message.content);
				break;
		}
	}
	return out;
}

/** The client fallback for calls recorded before the panel existed: the
 *  transcript up to (excluding) the latest assistant message, through the
 *  same model-facing conversion the agent uses. No system message lives
 *  in the record, so system/definitions are left out (unrecorded). Null
 *  when there is no assistant reply yet. */
export function transcriptComposition(messages: readonly LhMessage[]): Partial<ContextComposition> | null {
	let end = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "assistant") {
			end = i;
			break;
		}
	}
	if (end < 0) return null;
	const { system: _system, definitions: _definitions, ...rest } = contextComposition(toLlmMessages(asAgentMessages(messages.slice(0, end))));
	return rest;
}

export interface ContextSegment {
	key: ContextBucket;
	/** undefined = not recorded for this call (legend shows it, bar skips it). */
	tokens: number | undefined;
	/** This bucket's share of what the recorded buckets add up to. */
	share: number;
}

/** Each bucket as a share of the buckets' sum, so the measured fill of the
 *  usage bar can be divided between them. */
export function contextSegments(composition: Partial<ContextComposition>): ContextSegment[] {
	const total = CONTEXT_BUCKETS.reduce((sum, key) => sum + (composition[key] ?? 0), 0);
	return CONTEXT_BUCKETS.map((key) => {
		const tokens = composition[key];
		return { key, tokens, share: total > 0 && tokens ? tokens / total : 0 };
	});
}
