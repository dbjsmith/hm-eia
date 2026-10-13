import { createHash } from "node:crypto";
import { PROMPT_VERSION } from "./eia-prompt.js";

const PROCESS_KEYS = ["water_cycle", "mineral_cycle", "energy_flow", "community_dynamics"];
const ITEM_KINDS = ["observations", "questions", "divergence", "gaps"];
const MARKS = ["grounded", "new", "useful", "overreach"];

export function inputHash(text) {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 20);
}

export function propertySlug(name) {
  const slug = String(name || "unspecified")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "unspecified";
}

export function comparisonKey({ property, runAt, hash }) {
  const stamp = String(runAt).replace(/[:.]/g, "-");
  return `runs/${propertySlug(property)}/${stamp}-${hash}`;
}

export function surveyIdsFrom(surveys) {
  const ids = new Set();
  for (const survey of surveys || []) {
    if (!survey || typeof survey !== "object") continue;
    for (const key of ["_apikey", "apikey", "id", "survey_apikey"]) {
      if (survey[key]) ids.add(String(survey[key]));
    }
  }
  return ids;
}

export function readingSchemaValid(parsed, mode) {
  if (!parsed || typeof parsed !== "object") return false;
  if (mode === "answer" || mode === "chat") {
    const text = mode === "chat" ? parsed.response || parsed.answer : parsed.answer;
    return typeof text === "string" && text.trim().length > 0;
  }
  const processes = parsed.processes;
  if (!processes || typeof processes !== "object") return false;
  return PROCESS_KEYS.every((key) => {
    const block = processes[key];
    if (!block || typeof block !== "object") return false;
    return ITEM_KINDS.every((kind) => block[kind] == null || Array.isArray(block[kind]));
  });
}

export function citationReport(sanitised, surveyIds, mode) {
  const items = [];
  if (mode === "answer" || mode === "chat") {
    for (const cite of sanitised?.citations || []) {
      items.push(cite?.survey_id || null);
    }
  }
  const processes = sanitised?.processes || {};
  for (const block of Object.values(processes)) {
    if (!block || typeof block !== "object") continue;
    for (const observation of block.observations || []) {
      items.push(observation?.citation?.survey_id || null);
    }
  }
  if (!items.length) {
    return { items: 0, valid: 0, valid_citation_percent: null };
  }
  const valid = items.filter((id) => id && surveyIds.has(String(id))).length;
  return {
    items: items.length,
    valid,
    valid_citation_percent: Math.round((100 * valid) / items.length),
  };
}

export function checksFrom({ parsed, sanitised, tally, surveyIds, mode, schemaValid }) {
  const citations = citationReport(sanitised, surveyIds, mode);
  return {
    valid_citation_percent: citations.valid_citation_percent,
    cited_items: citations.items,
    valid_citations: citations.valid,
    grade_strips: (tally?.grade || 0) + (tally?.ehi || 0),
    prescription_strips: tally?.prescription || 0,
    stm_strips: tally?.stm_as_fact || 0,
    schema_valid: schemaValid == null ? readingSchemaValid(parsed, mode) : schemaValid,
  };
}

export function sideRecord({ result, parsed, sanitised, tally, surveyIds, mode, schemaValid }) {
  return {
    model: result?.model || "",
    ok: Boolean(result?.ok),
    error: result?.ok ? "" : result?.error || "",
    latency_ms: result?.latencyMs ?? null,
    usage: result?.usage || { input_tokens: null, output_tokens: null },
    raw: result?.text || "",
    sanitised: sanitised || null,
    strip_counts: tally || null,
    checks: checksFrom({ parsed, sanitised, tally, surveyIds, mode, schemaValid }),
  };
}

export function buildComparisonRecord({
  property,
  runAt,
  hash,
  mode,
  primary,
  shadow,
}) {
  const key = comparisonKey({ property, runAt, hash });
  return {
    key,
    property: property || "unspecified",
    run_at: runAt,
    input_hash: hash,
    prompt_version: PROMPT_VERSION,
    mode,
    primary,
    shadow,
    marks: {},
  };
}

export function listItems(sanitised, role) {
  const items = [];
  const processes = sanitised?.processes || {};
  for (const process of PROCESS_KEYS) {
    const block = processes[process];
    if (!block) continue;
    for (const kind of ITEM_KINDS) {
      (block[kind] || []).forEach((item, index) => {
        const text = item?.text || item?.question || "";
        if (!text) return;
        items.push({
          id: `${role}:${process}:${kind}:${index}`,
          role,
          process,
          kind,
          index,
          text,
          citation: item.citation || null,
          confidence: item.confidence || "",
          falsifier: item.falsifier || "",
        });
      });
    }
  }
  if (sanitised?.answer) {
    items.push({
      id: `${role}:answer:answer:0`,
      role,
      process: "answer",
      kind: "answer",
      index: 0,
      text: sanitised.answer,
      citation: null,
      confidence: "",
      falsifier: "",
    });
  }
  if (sanitised?.response) {
    items.push({
      id: `${role}:chat:response:0`,
      role,
      process: "chat",
      kind: "response",
      index: 0,
      text: sanitised.response,
      citation: null,
      confidence: "",
      falsifier: "",
    });
  }
  return items;
}

export function cleanMarks(marks) {
  const out = {};
  if (!marks || typeof marks !== "object") return out;
  for (const [id, value] of Object.entries(marks)) {
    if (!/^(primary|shadow):[\w-]+:[\w-]+:\d+$/.test(id)) continue;
    if (!value || typeof value !== "object") continue;
    const cleaned = {};
    for (const mark of MARKS) {
      if (mark in value) cleaned[mark] = Boolean(value[mark]);
    }
    if (Object.keys(cleaned).length) out[id] = cleaned;
  }
  return out;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function comparisonsToCsv(records) {
  const headers = [
    "key",
    "property",
    "run_at",
    "mode",
    "prompt_version",
    "input_hash",
    "role",
    "model",
    "ok",
    "error",
    "latency_ms",
    "input_tokens",
    "output_tokens",
    "valid_citation_percent",
    "grade_strips",
    "prescription_strips",
    "stm_strips",
    "schema_valid",
    "item_id",
    "process",
    "kind",
    "item_text",
    "citation_survey_id",
    "grounded",
    "new",
    "useful",
    "overreach",
  ];
  const rows = [headers.join(",")];
  for (const record of records) {
    for (const role of ["primary", "shadow"]) {
      const side = record[role];
      if (!side) continue;
      const items = listItems(side.sanitised, role);
      const lines = items.length ? items : [{ id: "", process: "", kind: "", text: "", citation: null }];
      for (const item of lines) {
        const mark = (record.marks && record.marks[item.id]) || {};
        const checks = side.checks || {};
        rows.push(
          [
            record.key,
            record.property,
            record.run_at,
            record.mode,
            record.prompt_version,
            record.input_hash,
            role,
            side.model,
            side.ok,
            side.error,
            side.latency_ms,
            side.usage?.input_tokens,
            side.usage?.output_tokens,
            checks.valid_citation_percent,
            checks.grade_strips,
            checks.prescription_strips,
            checks.stm_strips,
            checks.schema_valid,
            item.id,
            item.process,
            item.kind,
            item.text,
            item.citation?.survey_id || "",
            mark.grounded ?? "",
            mark.new ?? "",
            mark.useful ?? "",
            mark.overreach ?? "",
          ]
            .map(csvCell)
            .join(","),
        );
      }
    }
  }
  return `${rows.join("\n")}\n`;
}

export function summariseRecord(record) {
  return {
    key: record.key,
    property: record.property,
    run_at: record.run_at,
    mode: record.mode,
    prompt_version: record.prompt_version,
    input_hash: record.input_hash,
    primary_model: record.primary?.model || "",
    shadow_model: record.shadow?.model || "",
    shadow_error: record.shadow?.ok ? "" : record.shadow?.error || "",
    primary_checks: record.primary?.checks || null,
    shadow_checks: record.shadow?.checks || null,
    mark_count: Object.keys(record.marks || {}).length,
  };
}
