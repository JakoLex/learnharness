/**
 * Fork (2026-10-27): crypto.randomUUID exists only in SECURE contexts
 * (https or localhost). Opened over plain http on the LAN (the Pi at
 * http://192.168.178.68:3000), the browser leaves it undefined and sending
 * a chat message threw "crypto.randomUUID is not a function" inside the
 * chat client — the message never reached the server.
 *
 * This inline script runs in <head> before any bundle and adds an RFC 4122
 * v4 randomUUID built on crypto.getRandomValues (available in insecure
 * contexts too). It never replaces a native implementation.
 */
export const RANDOM_UUID_POLYFILL = `(function () {
	var c = globalThis.crypto;
	if (!c || typeof c.randomUUID === "function" || typeof c.getRandomValues !== "function") return;
	c.randomUUID = function () {
		var b = c.getRandomValues(new Uint8Array(16));
		b[6] = (b[6] & 15) | 64;
		b[8] = (b[8] & 63) | 128;
		var h = Array.from(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
		return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
	};
})();`;
