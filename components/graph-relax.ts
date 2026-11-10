/**
 * The live physics, shared by the canvas and the background relax (fork,
 * owner 2026-11-10). Pure and DOM-free: the renderer builds its live sim
 * from liveSimOptions, and the relax worker runs the SAME options to rest
 * off the main thread — one force set, so what the worker computes is
 * exactly where the live sim would come to rest.
 *
 * Why the worker: before f5daebe the graph re-annealed on every open and
 * drew each of its ~100 ticks (geometry, labels, the region blur), which
 * stuttered on the iPad; f5daebe stopped the re-anneal, so nodes stayed
 * where the server's anchored settle left them. The ticks themselves are
 * cheap (~2.4 ms for ~530 nodes) — the drawing was the cost. Now the open
 * relaxes in the background and the canvas only glides to the result.
 */
import {
	createGraphSimulation,
	type ImpLink,
	type LayoutEdge,
	type LayoutNode,
	type PhysicsTuning,
	type Position,
	type SimOptions,
} from "@/src/core";

/** Snappier anneal than the server settle's 0.0228. */
export const LIVE_ALPHA_DECAY = 0.05;
/** Below this alpha the sim counts as settled. */
export const SIM_SETTLE_ALPHA = 0.005;

/** What the physics needs of the canvas data (structured-cloneable). */
export interface RelaxData {
	nodes: ReadonlyArray<{ id: string; x: number; y: number }>;
	edges: ReadonlyArray<LayoutEdge>;
	logicalEdges?: ReadonlyArray<LayoutEdge>;
	impLinks?: ReadonlyArray<ImpLink>;
	clusters: ReadonlyArray<{ members: ReadonlyArray<string> }>;
}

/** The live sim's options for this data, tuning and center. */
export function liveSimOptions(data: RelaxData, tuning: PhysicsTuning, center: { x: number; y: number }): SimOptions {
	return {
		logicalEdges: data.logicalEdges,
		impLinks: data.impLinks,
		gravity: { x: center.x, y: center.y, strength: tuning.gravity },
		alphaDecay: LIVE_ALPHA_DECAY,
		velocityDecay: tuning.velocityDecay,
		chargeStrength: tuning.chargeStrength,
		linkStrength: tuning.linkStrength,
		linkDistance: tuning.linkDistance,
		clusterPull: data.clusters.length > 0 ? { clusters: data.clusters, strength: tuning.clusterPull } : undefined,
		depthAnchor:
			tuning.depthMode === "off"
				? undefined
				: {
						mode: tuning.depthMode,
						strength: tuning.depthStrength,
						spacing: tuning.depthSpacing,
						baseRadius: tuning.depthBaseRadius,
						center,
					},
	};
}

/** The center the renderer's live sim pulls toward: the bbox middle. */
export function bboxCenter(nodes: RelaxData["nodes"]): { x: number; y: number } {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		if (n.x < minX) minX = n.x;
		if (n.y < minY) minY = n.y;
		if (n.x > maxX) maxX = n.x;
		if (n.y > maxY) maxY = n.y;
	}
	return nodes.length === 0 ? { x: 0, y: 0 } : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** Anneal from the given positions to rest (alpha 1 → SIM_SETTLE_ALPHA),
 *  exactly as the live sim's full re-anneal would, and return where every
 *  node ends up. Deterministic for equal input. */
export function relaxPositions(
	data: RelaxData,
	tuning: PhysicsTuning,
	center: { x: number; y: number },
	maxTicks = 1000,
): Record<string, Position> {
	const nodes: LayoutNode[] = data.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
	const sim = createGraphSimulation(nodes, data.edges, liveSimOptions(data, tuning, center));
	sim.alpha(1);
	for (let i = 0; i < maxTicks && sim.alpha() >= SIM_SETTLE_ALPHA; i++) sim.tick();
	const out: Record<string, Position> = {};
	for (const n of nodes) out[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
	return out;
}

/** The largest distance any node would travel, or null when the result
 *  does not cover every node (it was computed for another node set). */
export function maxDisplacement(
	nodes: ReadonlyArray<{ id: string; x: number; y: number }>,
	positions: Readonly<Record<string, Position>>,
): number | null {
	let max = 0;
	for (const n of nodes) {
		const p = positions[n.id];
		if (!p) return null;
		const d = Math.hypot(p.x - n.x, p.y - n.y);
		if (d > max) max = d;
	}
	return max;
}

/** One relax request to the worker, and its answer. */
export interface RelaxRequest {
	seq: number;
	data: RelaxData;
	tuning: PhysicsTuning;
	center: { x: number; y: number };
}
export interface RelaxResult {
	seq: number;
	positions: Record<string, Position>;
}
