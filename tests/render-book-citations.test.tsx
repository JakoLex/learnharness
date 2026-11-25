/**
 * Book citations in chat markdown (fork, owner 2026-11-24): a link to a
 * book page on the shelf renders as the citation link (opens the page
 * viewer), marked when no book tool result in the chat showed that page;
 * every other link keeps Streamdown's own handling.
 */
import React from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { BookCitationContext } from "../components/book-citations.tsx";

const SOURCE = "See [Analysis, p. 123](/p/prj_1/books?book=bk_0123456789ab&page=141) and [the web](https://example.com/x).";

function render(consulted: ReadonlySet<string> | null) {
	const html = renderToStaticMarkup(
		<BookCitationContext.Provider value={consulted}>
			<MessageResponse>{SOURCE}</MessageResponse>
		</BookCitationContext.Provider>,
	);
	return parseHTML(`<html><body>${html}</body></html>`).document;
}

describe("book citations in messages", () => {
	it("renders the shelf link as a citation and leaves other links alone", () => {
		const document = render(null);
		const citations = [...document.querySelectorAll('[data-testid="book-citation"]')];
		assert.equal(citations.length, 1);
		assert.equal(citations[0]!.getAttribute("href"), "/p/prj_1/books?book=bk_0123456789ab&page=141");
		assert.ok(citations[0]!.textContent.includes("Analysis, p. 123"));
		assert.equal(citations[0]!.getAttribute("data-verified"), "true", "no chat context: no marks");
		assert.ok(document.body.textContent.includes("the web"));
		assert.equal(document.querySelectorAll("book-citation").length, 0, "the custom tag never reaches the DOM");
	});

	it("marks a page the chat never looked up", () => {
		const unverified = render(new Set(["bk_0123456789ab:140"]));
		const citation = unverified.querySelector('[data-testid="book-citation"]')!;
		assert.equal(citation.getAttribute("data-verified"), "false");
		assert.ok(citation.textContent.includes("not looked up"));

		const verified = render(new Set(["bk_0123456789ab:141"]));
		assert.equal(verified.querySelector('[data-testid="book-citation"]')!.getAttribute("data-verified"), "true");
		assert.ok(!verified.body.textContent.includes("not looked up"));
	});
});
