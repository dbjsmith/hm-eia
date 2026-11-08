/**
 * Monetary reservation and replay for one EOV test account.
 *
 * The memory ledger serialises updates on one event loop. That is fixture
 * safety only. It is not distributed safety and it is not a Netlify Blobs
 * guarantee. Blobs documents get, set, and an etag on read. set does not
 * take that etag as a condition, so the Blobs adapter refuses to reserve.
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
    limitation: "Netlify Blobs get/set is not a compare-and-swap. A read etag is not accepted by set as a condition.",
    async mutate() {
      void store;
      return { ok: false, reason: "reservation_store_unavailable", spentMinor: 0 };
    },
  };
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
