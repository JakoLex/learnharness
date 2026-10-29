import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import { renderToStaticMarkup } from "react-dom/server";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { deferredAnswer } from "../src/core/question-core.ts";

describe("the reading-thinking field (owner round, 2026-10-07)", () => {
	it("carries vertical padding — the 1px-scrollbar absorption", () => {
		const html = renderToStaticMarkup(
			<ReadingThinkingField value="" onChange={() => {}} claim={false} />,
		);
		// The fix (empirically diagnosed): Source Sans 3's font box (22px at
		// 16px) exceeds lh-input's 20px line box by 1px; Chromium counts that
		// in scrollHeight and a zero-padding field-sizing textarea becomes a
		// permanent 1px scroll (a bar shown empty AND at every expansion below
		// max-h). py-0.5 absorbs it — the composer/dock fields get the same
		// absorption implicitly from py-2. Line-height stays 1.25 (caret law).
		assert.ok(html.includes("py-0.5"), "the vertical padding is on the textarea");
		// The cap survives: growth past max-h-40 still scrolls honestly.
		assert.ok(html.includes("max-h-40"), "the 160px growth cap stays");
	});
});

describe("the ask-the-tutor field (owner, 2026-10-28)", () => {
	it("reads as the tutor channel; the send arrow is live only with text and asking possible", () => {
		const empty = renderToStaticMarkup(<ReadingThinkingField value="" onChange={() => {}} onAsk={() => {}} claim={false} />);
		assert.match(empty, />Ask the tutor</);
		assert.match(empty, /placeholder="Ask anything before the check…"/);
		assert.match(empty, /<button[^>]*data-testid="ask-tutor-send"[^>]*disabled=""/);
		const text = renderToStaticMarkup(<ReadingThinkingField value="Why?" onChange={() => {}} onAsk={() => {}} claim={false} />);
		assert.doesNotMatch(text, /<button[^>]*data-testid="ask-tutor-send"[^>]*disabled=""/);
		const unavailable = renderToStaticMarkup(<ReadingThinkingField value="Why?" onChange={() => {}} claim={false} />);
		assert.match(unavailable, /<button[^>]*data-testid="ask-tutor-send"[^>]*disabled=""/, "busy/compacting/sibling: no asking");
	});

	const dom = parseHTML("<html><body></body></html>");
	// React picks its input-event polyfill when the document lacks oninput
	// (linkedom) — the dictation-picker fixture's same fix.
	Object.assign(dom.document, { oninput: null });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({ window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	after(() => {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	});

	async function press(props: { value: string; ask?: boolean; open?: boolean }, key: { shiftKey?: boolean } = {}) {
		const calls = { ask: 0, open: 0 };
		const { createRoot } = await import("react-dom/client");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const root = createRoot(host);
		await act(async () => root.render(
			<ReadingThinkingField
				value={props.value}
				onChange={() => {}}
				onAsk={props.ask ? () => calls.ask++ : undefined}
				onOpen={props.open ? () => calls.open++ : undefined}
				claim={false}
			/>,
		));
		await act(async () => {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key: "Enter", shiftKey: key.shiftKey ?? false, metaKey: false, ctrlKey: false });
			host.querySelector("[data-file-path-input]")!.dispatchEvent(event);
		});
		await act(async () => root.unmount());
		host.remove();
		return calls;
	}

	it("Enter with text asks the tutor — the check open or closed alike", async () => {
		assert.deepEqual(await press({ value: "Why?", ask: true, open: true }), { ask: 1, open: 0 });
		assert.deepEqual(await press({ value: "Why?", ask: true }), { ask: 1, open: 0 });
	});

	it("Enter on an empty field opens the waiting check (keyboard round 2026-10-06)", async () => {
		assert.deepEqual(await press({ value: "  ", ask: true, open: true }), { ask: 0, open: 1 });
	});

	it("asking unavailable: Enter falls back to opening the check, the text rides along", async () => {
		assert.deepEqual(await press({ value: "Why?", open: true }), { ask: 0, open: 1 });
	});

	it("Shift+Enter is a newline — neither asks nor opens", async () => {
		assert.deepEqual(await press({ value: "Why?", ask: true, open: true }, { shiftKey: true }), { ask: 0, open: 0 });
	});
});

describe("the parked check's card", () => {
	it("shows the question and that he asked first — no verdict, no solution", () => {
		const html = renderToStaticMarkup(<AnsweredCard answer={deferredAnswer("quiz", "Which planet is closest?", false)} input={{ question: "Which planet is closest?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "Innermost." }} />);
		assert.match(html, /data-testid="deferred-card"/);
		assert.match(html, /Which planet is closest\?<\/span> — asked the tutor first/);
		assert.doesNotMatch(html, /Innermost|✓|✗/);
	});
});
