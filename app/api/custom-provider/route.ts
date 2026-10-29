/** PR #62's single custom endpoint: discover/manual connect, offline pins,
 * and disconnect. Host boundaries and mutations live behind the server barrel.
 * This fork keeps it off, and never with accounts (src/server/fork-features.ts). */
import { customEndpointFeature, customProviderGet, customProviderMutation } from "@/src/server";

export const dynamic = "force-dynamic";

const turnedOff = () => Response.json({ error: "The custom endpoint is turned off in this LearnHarness." }, { status: 404 });
const gatedGet = (request: Request): Response => (customEndpointFeature() ? customProviderGet(request) : turnedOff());
const gatedMutation = async (request: Request): Promise<Response> => (customEndpointFeature() ? customProviderMutation(request) : turnedOff());

export const GET = gatedGet;
export const POST = gatedMutation;
export const PATCH = gatedMutation;
export const DELETE = gatedMutation;
