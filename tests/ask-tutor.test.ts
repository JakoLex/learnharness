import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { ChatInputError, inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { compactAnswerForModel, deferredAnswer, dismissedAnswer } from "../src/core/question-core.ts";
import { asAgentMessages, danglingQuestionOf, nativeInputCause, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";

// Ask the tutor first (owner, 2026-10-28): the pending teach-phase check
// parks as a deferral result and the learner's message follows it in the
// SAME turn — the call/result adjacency holds, the tutor re-poses later.

const CHECK = { question: "Which planet is closest to the sun?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "Innermost.", type: "check", nodeId: "planet-order" };
const user = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: 1 }) as LhMessage;
const teach = (calls: ReturnType<typeof fauxToolCall>[]): LhMessage =>
	({ ...fauxAssistantMessage([fauxText("Mercury orbits closest."), ...calls], { stopReason: "toolUse" }), id: "a1" }) as LhMessage;
const record = (calls = [fauxToolCall("quiz", CHECK, { id: "call-1" })]) => ({ messages: [user("u1", "teach me"), teach(calls)] });
const defer = (over: Record<string, unknown> = {}) =>
	parseChatInput({ type: "defer", toolCallId: "call-1", answer: deferredAnswer("quiz", CHECK.question, false), text: "Why is Venus hotter?", ...over });

describe("defer input: parsing", () => {
	it("accepts a deferral answer with the learner's message", () => {
		const input = defer();
		assert.equal(input.type, "defer");
	});

	it("refuses anything that is not a real deferral, or has no message", () => {
		assert.throws(() => defer({ answer: dismissedAnswer("quiz", CHECK.question) }), ChatInputError);
		assert.throws(() => defer({ answer: null }), ChatInputError);
		assert.throws(() => defer({ text: "   " }), ChatInputError);
		assert.throws(() => defer({ toolCallId: "" }), ChatInputError);
	});
});

describe("defer input: appends", () => {
	it("parks the check, then the learner's message — one turn, provider-legal order", () => {
		const r = record();
		const appends = inputAppends(r, defer());
		assert.equal(appends.length, 2);
		const [result, message] = appends as [LhMessage & ToolResultMessage, LhMessage];
		assert.equal(result.role, "toolResult");
		assert.equal(result.toolCallId, "call-1");
		assert.equal((result.details as { deferred?: boolean }).deferred, true);
		assert.equal(message.role, "user");
		assert.equal((message as { content: unknown }).content, "Why is Venus hotter?");
		const after = [...r.messages, ...appends];
		assert.equal(danglingQuestionOf(after), null, "nothing dangles after the deferral");
		const wire = toLlmMessages(asAgentMessages(after));
		assert.deepEqual(wire.map((m) => m.role), ["user", "assistant", "toolResult", "user"]);
	});

	it("the tutor reads a bare deferral — no verdict, no solution; opened when he had seen the question", () => {
		assert.deepEqual(compactAnswerForModel(deferredAnswer("quiz", "Q?", false)), { kind: "quiz", deferred: true });
		assert.deepEqual(compactAnswerForModel(deferredAnswer("explain", "Q?", true)), { kind: "explain", deferred: true, opened: true });
		const [result] = inputAppends(record(), defer()) as unknown as [ToolResultMessage];
		assert.equal((result.content[0] as { text: string }).text, JSON.stringify({ kind: "quiz", deferred: true }));
	});

	it("refuses a call that is not the pending question, or a kind mismatch", () => {
		assert.throws(() => inputAppends(record(), defer({ toolCallId: "call-x" })), ChatInputError);
		assert.throws(() => inputAppends(record(), defer({ answer: deferredAnswer("explain", CHECK.question, false) })), ChatInputError);
		assert.throws(() => inputAppends({ messages: [user("u1", "hi")] }, defer()), ChatInputError);
	});

	it("refuses while a sibling question would be left dangling (its result must stay adjacent)", () => {
		const twin = record([fauxToolCall("quiz", CHECK, { id: "call-1" }), fauxToolCall("quiz", CHECK, { id: "call-2" })]);
		assert.throws(() => inputAppends(twin, defer()), /another question dangling/);
	});
});

describe("deferral downstream", () => {
	it("counts as the learner's own input", () => {
		const r = record();
		const [result] = inputAppends(r, defer());
		assert.equal(nativeInputCause(result!, r.messages), "learner");
	});

	it("the markdown export says he asked first — never a verdict", () => {
		const r = record();
		const md = sessionMarkdown([...r.messages, ...inputAppends(r, defer())]);
		assert.match(md, /The learner asked the tutor first instead of answering this check\./);
		assert.match(md, /Why is Venus hotter\?/);
		assert.doesNotMatch(md, /answered (in)?correctly/);
	});
});
