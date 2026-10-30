/**
 * Phone and iPad pins (fork, owner 2026-10-30): the touch long press that
 * stands in for the right click, the phone drawer's visibility rule, the
 * icon-only graph bar, and the graph's quiet-open and label-culling rules.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLongPress, LONG_PRESS_MS, LONG_PRESS_SLOP } from "../components/long-press.ts";
import { SessionRow, sidebarShown } from "../components/sidebar.tsx";
import { GraphChromeRow } from "../components/graph-view.tsx";
import { labelInView, samePhysicsTuning, worldView, type GraphRenderSettings } from "../components/graph-canvas.ts";
import { DEFAULT_PHYSICS_TUNING } from "../src/core/index.ts";

/** A fake clock: timers run only when the test advances it. */
function fakeTimers() {
	let now = 0;
	const pending = new Map<number, { at: number; fn: () => void }>();
	let next = 1;
	return {
		timers: {
			set: (fn: () => void, ms: number) => {
				const id = next++;
				pending.set(id, { at: now + ms, fn });
				return id;
			},
			clear: (id: unknown) => void pending.delete(id as number),
		},
		advance(ms: number) {
			now += ms;
			for (const [id, t] of [...pending]) {
				if (t.at <= now) {
					pending.delete(id);
					t.fn();
				}
			}
		},
	};
}

describe("createLongPress — the touch stand-in for the right click", () => {
	it("fires once the touch stays down for LONG_PRESS_MS, at the press point", () => {
		const clock = fakeTimers();
		const fired: { x: number; y: number }[] = [];
		const press = createLongPress((at) => fired.push(at), clock.timers);
		press.down(1, { x: 10, y: 20 });
		clock.advance(LONG_PRESS_MS - 1);
		assert.equal(fired.length, 0);
		clock.advance(1);
		assert.deepEqual(fired, [{ x: 10, y: 20 }]);
		assert.equal(press.consumeFired(), true, "the lift's click is swallowed");
		assert.equal(press.consumeFired(), false, "…only once");
	});

	it("a wobble inside the slop keeps waiting; travel past it is a pan", () => {
		const clock = fakeTimers();
		let fired = 0;
		const press = createLongPress(() => fired++, clock.timers);
		press.down(1, { x: 0, y: 0 });
		press.move(1, { x: LONG_PRESS_SLOP - 1, y: 0 });
		clock.advance(LONG_PRESS_MS);
		assert.equal(fired, 1);
		press.down(1, { x: 0, y: 0 });
		press.move(1, { x: LONG_PRESS_SLOP + 1, y: 0 });
		clock.advance(LONG_PRESS_MS);
		assert.equal(fired, 1, "the pan cancelled it");
		assert.equal(press.consumeFired(), false, "a new press clears the old fire");
	});

	it("another finger's move is ignored; cancel stops the timer", () => {
		const clock = fakeTimers();
		let fired = 0;
		const press = createLongPress(() => fired++, clock.timers);
		press.down(1, { x: 0, y: 0 });
		press.move(2, { x: 100, y: 100 });
		press.cancel();
		clock.advance(LONG_PRESS_MS * 2);
		assert.equal(fired, 0);
	});
});

describe("sidebarShown — the phone drawer (below 48rem)", () => {
	it("on a phone only the drawer's own state counts", () => {
		assert.equal(sidebarShown({ drawer: true, drawerOpen: false, pref: true, narrow: false }), false, "closed on load despite the desktop pref");
		assert.equal(sidebarShown({ drawer: true, drawerOpen: true, pref: false, narrow: false }), true);
	});
	it("elsewhere the pref, minus the narrow Electron window", () => {
		assert.equal(sidebarShown({ drawer: false, drawerOpen: true, pref: true, narrow: false }), true);
		assert.equal(sidebarShown({ drawer: false, drawerOpen: true, pref: true, narrow: true }), false);
		assert.equal(sidebarShown({ drawer: false, drawerOpen: true, pref: false, narrow: false }), false);
	});
});

describe("SessionRow — long-press ready", () => {
	it("the row blocks text selection and the iOS callout", () => {
		const html = renderToStaticMarkup(
			<SessionRow
				chat={{ id: "c1", title: "T", kind: "teach", phase: "teaching", messageCount: 1, updatedAt: "2026-10-30T00:00:00Z" } as never}
				active={false}
				onOpen={() => {}}
				onLongPress={() => {}}
			/>,
		);
		assert.ok(html.includes("select-none"));
		assert.ok(html.includes("[-webkit-touch-callout:none]"));
	});
});

describe("GraphChromeRow — icon-only below md", () => {
	const PROPS = {
		isEmpty: false,
		query: "",
		onQuery: () => {},
		noMatch: false,
		importing: false,
		searchInputRef: { current: null },
		fileInputRef: { current: null },
		onImportFiles: () => {},
		settings: {} as GraphRenderSettings,
		changeSettings: () => {},
		onOpenChains: () => {},
	};
	it("the labels stay for screen readers, hidden on a phone", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, PROPS));
		assert.ok(html.includes('<span class="max-md:sr-only">Chains</span>'));
		assert.ok(html.includes('<span class="max-md:sr-only">Import notes…</span>'));
	});
	it("the search is magnifier-sized until it holds a query", () => {
		assert.ok(renderToStaticMarkup(createElement(GraphChromeRow, PROPS)).includes("max-md:w-9"));
		assert.ok(!renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, query: "x" })).includes("max-md:w-9"));
	});
});

describe("graph canvas — quiet open and label culling", () => {
	it("equal physics values are no change; any field differing is", () => {
		assert.equal(samePhysicsTuning(DEFAULT_PHYSICS_TUNING, { ...DEFAULT_PHYSICS_TUNING }), true);
		assert.equal(samePhysicsTuning(DEFAULT_PHYSICS_TUNING, { ...DEFAULT_PHYSICS_TUNING, gravity: DEFAULT_PHYSICS_TUNING.gravity + 0.01 }), false);
		assert.equal(samePhysicsTuning(DEFAULT_PHYSICS_TUNING, { ...DEFAULT_PHYSICS_TUNING, depthMode: "radial" }), DEFAULT_PHYSICS_TUNING.depthMode === "radial");
	});

	it("a name block counts while any part of it can reach the view", () => {
		const view = worldView({ x: 0, y: 0, k: 1 }, 100, 100); // world 0..100 square
		const world = { nodeR: 5, labelGap: 2, labelSize: 10 };
		assert.equal(labelInView(50, 50, 1, view, world, 40), true, "centered");
		assert.equal(labelInView(-30, 50, 1, view, world, 40), true, "left of the view, its text reaches in");
		assert.equal(labelInView(-50, 50, 1, view, world, 40), false, "too far left");
		assert.equal(labelInView(50, -15, 1, view, world, 40), true, "above the view, the block hangs into it");
		assert.equal(labelInView(50, -40, 1, view, world, 40), false, "too far up");
		assert.equal(labelInView(50, 104, 1, view, world, 40), true, "the disc's top still on screen");
		assert.equal(labelInView(50, 110, 1, view, world, 40), false, "below the view");
	});
});
