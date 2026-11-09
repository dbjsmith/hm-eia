/**
 * Compare-and-swap reservation against a Blobs-shaped store.
 *
 * @netlify/blobs 11.1.4 types accept setJSON({ onlyIfMatch | onlyIfNew })
 * and getWithMetadata({ consistency: "strong" }). The docs call those
 * conditional writes atomic. Unconditional overlapping set calls are still
 * last-write-wins. This module never issues an unconditional set.
 *
 * The store is injected. Opening a live Netlify store is a separate step
 * and is unverified until a TEST deploy. A missing method fails closed.
 */

import {
  TEST_CEILING_MICRO_USD,
  TEST_MAX_CALLS,
  admitDeclaredTokens,
  worstCaseMicroUsd,
} from "./eov-tokens.js";

export const BLOBS_PACKAGE_VERSION_CHECKED = "11.1.4";
export const MAX_CAS_ATTEMPTS = 5;
export const ACCOUNT_KEY = "eov-report-v0/account";

function idemKey(id) {
  return `eov-report-v0/idem/${id}`;
}

function confirmKey(id) {
  return `eov-report-v0/confirm/${id}`;
}

function storeReady(store) {
  return Boolean(store && typeof store.getWithMetadata === "function" && typeof store.setJSON === "function");
}

async function readStrong(store, key) {
  const found = await store.getWithMetadata(key, { consistency: "strong", type: "json" });
  if (!found || found.data == null) return null;
  return { data: found.data, etag: found.etag };
}

function accountAllows(account, cost) {
  const spent = account?.spentMicroUsd || 0;
  const calls = account?.calls || 0;
  if (calls >= TEST_MAX_CALLS) return "call_cap";
  if (spent + cost > TEST_CEILING_MICRO_USD) return "budget_exhausted";
  return null;
}

export async function reserveOnConditionalStore(store, input) {
  if (!storeReady(store)) return { ok: false, reason: "reservation_store_unavailable", spentMicroUsd: 0 };
  const admitted = admitDeclaredTokens(input);
  if (!admitted.ok) return { ok: false, reason: admitted.reason, spentMicroUsd: 0 };
  const cost = worstCaseMicroUsd();
  const confirmationId = input.confirmationId;
  const idempotencyKey = input.idempotencyKey;
  if (typeof confirmationId !== "string" || typeof idempotencyKey !== "string" || confirmationId.length < 8 || idempotencyKey.length < 8) {
    return { ok: false, reason: "invalid_body", spentMicroUsd: 0 };
  }

  let idemWrite;
  try {
    idemWrite = await store.setJSON(idemKey(idempotencyKey), { confirmationId, cost }, { onlyIfNew: true });
  } catch {
    return { ok: false, reason: "reservation_store_unavailable", spentMicroUsd: 0 };
  }
  if (!idemWrite?.modified) {
    const existing = await readStrong(store, idemKey(idempotencyKey));
    if (!existing || existing.data.confirmationId !== confirmationId || existing.data.cost !== cost) {
      return { ok: false, reason: "idempotency_conflict", spentMicroUsd: 0 };
    }
  }

  let confirmWrite;
  try {
    confirmWrite = await store.setJSON(
      confirmKey(confirmationId),
      { idempotencyKey, state: "open" },
      { onlyIfNew: true },
    );
  } catch {
    return { ok: false, reason: "reservation_store_unavailable", spentMicroUsd: 0 };
  }
  if (!confirmWrite?.modified) {
    const existing = await readStrong(store, confirmKey(confirmationId));
    if (!existing || existing.data.idempotencyKey !== idempotencyKey) {
      return { ok: false, reason: "replay_rejected", spentMicroUsd: 0 };
    }
    if (existing.data.state === "charged") {
      const account = await readStrong(store, ACCOUNT_KEY);
      return { ok: true, reason: "idempotent", spentMicroUsd: account?.data?.spentMicroUsd || 0, calls: account?.data?.calls || 0 };
    }
  }

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await readStrong(store, ACCOUNT_KEY);
    const account = current?.data || { spentMicroUsd: 0, calls: 0, holds: {} };
    if (account.holds && account.holds[idempotencyKey] === confirmationId) {
      return { ok: true, reason: "idempotent", spentMicroUsd: account.spentMicroUsd, calls: account.calls };
    }
    if (account.holds && Object.values(account.holds).includes(confirmationId)) {
      return { ok: false, reason: "replay_rejected", spentMicroUsd: account.spentMicroUsd };
    }
    const blocked = accountAllows(account, cost);
    if (blocked) return { ok: false, reason: blocked, spentMicroUsd: account.spentMicroUsd, calls: account.calls };
    const next = {
      spentMicroUsd: account.spentMicroUsd + cost,
      calls: account.calls + 1,
      holds: { ...(account.holds || {}), [idempotencyKey]: confirmationId },
    };
    const wrote = current
      ? await store.setJSON(ACCOUNT_KEY, next, { onlyIfMatch: current.etag })
      : await store.setJSON(ACCOUNT_KEY, next, { onlyIfNew: true });
    if (wrote?.modified) {
      if (confirmWrite?.etag || confirmWrite?.modified) {
        const fresh = await readStrong(store, confirmKey(confirmationId));
        if (fresh?.etag) {
          await store.setJSON(
            confirmKey(confirmationId),
            { idempotencyKey, state: "charged" },
            { onlyIfMatch: fresh.etag },
          );
        }
      }
      return { ok: true, reason: "reserved", spentMicroUsd: next.spentMicroUsd, calls: next.calls, costMicroUsd: cost };
    }
  }
  return { ok: false, reason: "reservation_conflict", spentMicroUsd: 0 };
}

export function conditionalBlobsLedger(store) {
  return {
    kind: "netlify-blobs-conditional",
    atomic: true,
    distributed: false,
    liveVerified: false,
    packageVersionChecked: BLOBS_PACKAGE_VERSION_CHECKED,
    async reserve(input) {
      return reserveOnConditionalStore(store, input);
    },
  };
}
