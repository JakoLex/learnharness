/// <reference lib="webworker" />
/**
 * The background relax (fork, owner 2026-11-10): runs the live physics to
 * rest off the main thread, so opening the graph never draws the ~100
 * anneal frames that stuttered on the iPad. See graph-relax.ts.
 */
import { relaxPositions, type RelaxRequest, type RelaxResult } from "./graph-relax.ts";

self.onmessage = (event: MessageEvent<RelaxRequest>) => {
	const { seq, data, tuning, center } = event.data;
	const result: RelaxResult = { seq, positions: relaxPositions(data, tuning, center) };
	self.postMessage(result);
};
