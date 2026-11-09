/**
 * Monetary reservation and replay for one EOV test account.
 *
 * The memory ledger serialises updates on one event loop. That is fixture
 * safety only. It is not distributed safety.
 *
 * @netlify/blobs 11.1.4 accepts onlyIfMatch and onlyIfNew. Unconditional
 * overlapping set calls are still last-write-wins. casBlobsLedger opens a
 * live store and mutates only through those conditional writes. The older
 * blobsGetSetLedger helper stays fail-closed for tests that assert the
 * store is never written when reservation is unavailable.
 *
 * A second conditional path with declared-token micro-USD accounting lives
 * in eov-blobs-ledger.js.
 */

export const EOV_ACCOUNT = "eov-report-v0";

function emptyAccount() {
  return { spentMinor: 0, holds: {}, confirmations: {} };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function memoryLedger() {
  const rows = new Map();
  let tail = Promise.resolve();
  function exclusive(work) {
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }
  function row(key) {
    return rows.get(key) || { version: 0, value: emptyAccount() };
  }
  return {
    atomic: true,
    distributed: false,
    safety: "single_process_queue",
    async read(key = EOV_ACCOUNT) {
      return exclusive(() => clone(row(key).value));
    },
    async mutate(key, recipe) {
      return exclusive(() => {
        const current = row(key);
        const outcome = recipe(clone(current.value));
        if (!outcome.write) {
          return {
            ok: outcome.ok,
            reason: outcome.reason,
            spentMinor: current.value.spentMinor,
          };
        }
        rows.set(key, { version: current.version + 1, value: clone(outcome.value) });
        return { ok: true, reason: outcome.reason, spentMinor: outcome.value.spentMinor };
      });
    },
  };
}

export function blobsGetSetLedger(store) {
  return {
    atomic: false,
    distributed: false,
    platform: "netlify-blobs",
    safety: "none",
    limitation: "Fail-closed stub. Use casBlobsLedger(store) or openEovBlobsLedger() for live conditional writes.",
    async mutate() {
      void store;
      return { ok: false, reason: "reservation_store_unavailable", spentMinor: 0 };
    },
  };
}

/** Existing site Blobs store also used by spend-guard. EOV keys are prefixed. */
export const EOV_BLOBS_STORE_NAME = "eia-spend";
export const MAX_LEDGER_CAS_ATTEMPTS = 5;

function storeReady(store) {
  return Boolean(store && typeof store.getWithMetadata === "function" && typeof store.setJSON === "function");
}

async function readStrongAccount(store, key) {
  const found = await store.getWithMetadata(key, { consistency: "strong", type: "json" });
  if (!found || found.data == null) return null;
  return { data: found.data, etag: found.etag };
}

/**
 * Compare-and-swap ledger over an injected Blobs-shaped store.
 * Mutate uses onlyIfMatch / onlyIfNew only. Missing methods fail closed.
 */
export function casBlobsLedger(store) {
  return {
    atomic: true,
    distributed: true,
    platform: "netlify-blobs",
    safety: "onlyIfMatch_cas",
    liveVerified: false,
    async read(key = EOV_ACCOUNT) {
      if (!storeReady(store)) return emptyAccount();
      try {
        const current = await readStrongAccount(store, key);
        return current ? clone(current.data) : emptyAccount();
      } catch {
        return emptyAccount();
      }
    },
    async mutate(key, recipe) {
      if (!storeReady(store)) {
        return { ok: false, reason: "reservation_store_unavailable", spentMinor: 0 };
      }
      for (let attempt = 0; attempt < MAX_LEDGER_CAS_ATTEMPTS; attempt += 1) {
        let current;
        try {
          current = await readStrongAccount(store, key);
        } catch {
          return { ok: false, reason: "reservation_store_unavailable", spentMinor: 0 };
        }
        const account = current ? clone(current.data) : emptyAccount();
        const outcome = recipe(clone(account));
        if (!outcome.write) {
          return {
            ok: outcome.ok,
            reason: outcome.reason,
            spentMinor: account.spentMinor || 0,
          };
        }
        let wrote;
        try {
          wrote = current
            ? await store.setJSON(key, outcome.value, { onlyIfMatch: current.etag })
            : await store.setJSON(key, outcome.value, { onlyIfNew: true });
        } catch {
          return { ok: false, reason: "reservation_store_unavailable", spentMinor: account.spentMinor || 0 };
        }
        if (wrote?.modified) {
          return { ok: true, reason: outcome.reason, spentMinor: outcome.value.spentMinor };
        }
      }
      return { ok: false, reason: "reservation_conflict", spentMinor: 0 };
    },
  };
}

/**
 * Open the live Netlify Blobs store for EOV reservation and replay.
 * Returns { store, ledger } or null when the platform store cannot open.
 */
export async function openEovBlobsLedger() {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: EOV_BLOBS_STORE_NAME, consistency: "strong" });
    if (!storeReady(store)) return null;
    return { store, ledger: casBlobsLedger(store) };
  } catch (err) {
    console.error("[eov-ledger]", err?.message || err);
    return null;
  }
}

export function unsafeLostUpdateLedger() {
  let spent = 0;
  return {
    atomic: false,
    distributed: false,
    safety: "unsynchronised_get_set",
    async add(minor) {
      const seen = spent;
      await Promise.resolve();
      spent = seen + minor;
      return spent;
    },
    spent() {
      return spent;
    },
  };
}

function requireCharge(input) {
  const { minor, ceilingMinor, confirmationId, idempotencyKey, inputTokens, outputTokens, maxInputTokens, maxOutputTokens } = input;
  if (!Number.isInteger(ceilingMinor) || ceilingMinor < 1 || !Number.isInteger(minor) || minor < 1 || minor > ceilingMinor) {
    return "budget_unconfigured";
  }
  if (!Number.isInteger(maxInputTokens) || !Number.isInteger(maxOutputTokens) || maxInputTokens < 1 || maxOutputTokens < 1) {
    return "token_policy_unapproved";
  }
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens) || inputTokens < 1 || outputTokens < 1) {
    return "token_undeclared";
  }
  if (inputTokens > maxInputTokens || outputTokens > maxOutputTokens) return "token_limit_rejected";
  if (typeof confirmationId !== "string" || typeof idempotencyKey !== "string" || !confirmationId || !idempotencyKey) {
    return "invalid_body";
  }
  return null;
}

export async function reserveEovSpend(ledger, input) {
  if (!ledger || ledger.atomic !== true || typeof ledger.mutate !== "function") {
    return { ok: false, reason: "reservation_store_unavailable", spentMinor: 0 };
  }
  const gap = requireCharge(input);
  if (gap) return { ok: false, reason: gap, spentMinor: 0 };
  return ledger.mutate(EOV_ACCOUNT, (account) => {
    const existing = account.holds[input.idempotencyKey];
    if (existing) {
      if (existing.confirmationId !== input.confirmationId || existing.minor !== input.minor) {
        return { ok: false, write: false, reason: "idempotency_conflict" };
      }
      return { ok: true, write: false, reason: existing.state === "released" ? "idempotent_released" : "idempotent" };
    }
    if (account.confirmations[input.confirmationId]) {
      return { ok: false, write: false, reason: "replay_rejected" };
    }
    if (account.spentMinor + input.minor > input.ceilingMinor) {
      return { ok: false, write: false, reason: "budget_exhausted" };
    }
    account.spentMinor += input.minor;
    account.holds[input.idempotencyKey] = {
      minor: input.minor,
      confirmationId: input.confirmationId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      state: "held",
    };
    account.confirmations[input.confirmationId] = input.idempotencyKey;
    return { ok: true, write: true, reason: "reserved", value: account };
  });
}

export async function releaseUninvokedHold(ledger, input) {
  if (!ledger || ledger.atomic !== true || typeof ledger.mutate !== "function") {
    return { ok: false, reason: "reservation_store_unavailable", spentMinor: 0 };
  }
  return ledger.mutate(EOV_ACCOUNT, (account) => {
    const existing = account.holds[input.idempotencyKey];
    if (!existing) return { ok: false, write: false, reason: "reservation_release_failed" };
    if (existing.state === "released") return { ok: true, write: false, reason: "released" };
    if (existing.confirmationId !== input.confirmationId) {
      return { ok: false, write: false, reason: "reservation_release_failed" };
    }
    account.spentMinor = Math.max(0, account.spentMinor - existing.minor);
    existing.state = "released";
    if (account.confirmations[input.confirmationId] === input.idempotencyKey) {
      delete account.confirmations[input.confirmationId];
    }
    return { ok: true, write: true, reason: "released", value: account };
  });
}
