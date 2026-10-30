/**
 * LONG PRESS = RIGHT CLICK on touch (fork, owner 2026-10-30): iOS Safari
 * never fires `contextmenu`, so the session rows' and graph nodes' menus
 * were out of reach on the iPad and the phone. A touch held still for
 * LONG_PRESS_MS opens the same menu the right click opens. Android fires
 * `contextmenu` itself — the callers cancel the timer on it, so the menu
 * never opens twice. Mouse and pen keep the plain right click.
 *
 * The tracker is plain logic (no React, no DOM) so the graph canvas, which
 * is imperative, and the React hook below share one rule — and the tests
 * drive it with a fake clock.
 */
import { useCallback, useEffect, useRef } from "react";

/** How long a touch must stay down before it counts as a long press. */
export const LONG_PRESS_MS = 500;
/** Finger travel (CSS px) that turns the press into a pan or scroll. */
export const LONG_PRESS_SLOP = 10;

export interface LongPressPoint {
	x: number;
	y: number;
}

export interface LongPressTracker {
	/** A touch went down at (x, y). Restarts the timer. */
	down(pointerId: number, at: LongPressPoint): void;
	/** The touch moved; cancels once it travels past the slop. */
	move(pointerId: number, at: LongPressPoint): void;
	/** Lift, cancel, a second finger, a native contextmenu — stop waiting. */
	cancel(): void;
	/** True once if a long press fired since the last down — the click that
	 *  the lift may still produce is swallowed by the caller. */
	consumeFired(): boolean;
}

export function createLongPress(
	onFire: (at: LongPressPoint) => void,
	timers: {
		set: (fn: () => void, ms: number) => unknown;
		clear: (handle: unknown) => void;
	} = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
): LongPressTracker {
	let pending: { id: number; at: LongPressPoint; handle: unknown } | null = null;
	let fired = false;
	const cancel = () => {
		if (!pending) return;
		timers.clear(pending.handle);
		pending = null;
	};
	return {
		down(pointerId, at) {
			cancel();
			fired = false;
			const handle = timers.set(() => {
				pending = null;
				fired = true;
				onFire(at);
			}, LONG_PRESS_MS);
			pending = { id: pointerId, at, handle };
		},
		move(pointerId, at) {
			if (!pending || pending.id !== pointerId) return;
			if (Math.hypot(at.x - pending.at.x, at.y - pending.at.y) > LONG_PRESS_SLOP) cancel();
		},
		cancel,
		consumeFired() {
			const was = fired;
			fired = false;
			return was;
		},
	};
}

/**
 * The React side: pointer handlers for one element. `onLongPress` gets the
 * element (the menu anchor) — undefined turns the whole thing off. Spread
 * the result on the element; call `cancel` from its onContextMenu so a
 * native (Android) long-press menu is the only one.
 */
export function useLongPress<T extends HTMLElement>(onLongPress: ((el: T) => void) | undefined) {
	const callback = useRef(onLongPress);
	callback.current = onLongPress;
	const target = useRef<T | null>(null);
	const tracker = useRef<LongPressTracker | null>(null);
	tracker.current ??= createLongPress(() => {
		if (target.current) callback.current?.(target.current);
	});
	useEffect(() => () => tracker.current?.cancel(), []);
	const cancel = useCallback(() => tracker.current?.cancel(), []);
	if (!onLongPress) return { cancel, handlers: {} };
	return {
		cancel,
		handlers: {
			onPointerDown: (e: React.PointerEvent<T>) => {
				if (e.pointerType !== "touch" || !e.isPrimary) {
					tracker.current?.cancel();
					return;
				}
				target.current = e.currentTarget;
				tracker.current?.down(e.pointerId, { x: e.clientX, y: e.clientY });
			},
			onPointerMove: (e: React.PointerEvent<T>) => tracker.current?.move(e.pointerId, { x: e.clientX, y: e.clientY }),
			onPointerUp: cancel,
			onPointerCancel: cancel,
			onPointerLeave: cancel,
			onClickCapture: (e: React.MouseEvent<T>) => {
				if (!tracker.current?.consumeFired()) return;
				e.preventDefault();
				e.stopPropagation();
			},
		},
	};
}
