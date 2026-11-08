/**
 * Report-binding verifier interface.
 *
 * The production verifier refuses every token. It does not parse, sign, or
 * invent a GeoDataTrack issuer, key, or signature. A fixture verifier is a
 * test lookup table injected by the test process. A hit in that table is
 * not evidence that a host signed the binding.
 */

export const EOV_AUDIENCE = "eia-eov-report";

export function unavailableBindingVerifier() {
  return {
    kind: "issuer_unavailable",
    async verify() {
      return { ok: false, reason: "issuer_unavailable" };
    },
  };
}

export function fixtureBindingVerifier(records) {
  const table = records instanceof Map ? records : new Map();
  return {
    kind: "test-fixture",
    gdtSignature: false,
    async verify(token) {
      if (typeof token !== "string" || !table.has(token)) {
        return { ok: false, reason: "binding_rejected" };
      }
      const claims = table.get(token);
      if (!claims || typeof claims !== "object") return { ok: false, reason: "binding_rejected" };
      return { ok: true, claims };
    },
  };
}
