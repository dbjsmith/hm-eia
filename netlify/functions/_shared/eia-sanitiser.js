/**
 * EIA response sanitiser v0.
 *
 * Normative source: eia-response-sanitiser-v0 (12 Sep 2026).
 * Strips or flags, before anything reaches a steward:
 *   EHI or grade fields, STM state labels stated as fact,
 *   foreign property names, prescriptions without a falsifier,
 *   HM checks claimed without holistic context.
 *
 * Coupled-process absence is a soft warning in v0.
 * This module does not compute a substitute score.
 */

const GRADE_KEYS = new Set([
  "ehi",
  "journey_stage",
  "journeystage",
  "journey_label",
  "journeylabel",
  "limiting_process",
  "limitingprocess",
  "priority_lever",
  "prioritylever",
]);

const FOREIGN_NAMES = ["Knepp", "Carrifran", "Brown's Ranch", "Browns Ranch", "White Oak Pastures"];

const USE_RANK = { scaffold_only: 0, questions_only: 1, scoring_allowed: 2 };

const SKIP_STRING_KEYS = new Set([
  "uncertainty",
  "never_include",
  "prompt_version",
  "disclaimer",
  "reason_if_skipped",
  "ecoregion_id",
  "status",
  "use",
  "confidence",
  "process",
  "level",
  "survey_id",
  "date",
  "falsifier",
  "field_method",
]);

const PRESCRIBE =
  /\b(you should|you must|increase stocking|reduce stocking|destock|rest the paddock|apply herbicide|graze harder|move the (stock|animals|herd)|most important management action)\b/i;

const HM_PROSE =
  /\b(cause\s*&\s*effect check|cause and effect check|weak link check|marginal reaction check|gross profit analysis|seven (context |hm )?checks (confirm|show|say))\b/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function pushUnique(list, code) {
  if (!list.includes(code)) list.push(code);
}

export function allowedUseForStatus(status) {
  if (status === "present_human_vetted") return "scoring_allowed";
  if (status === "ai_draft_not_vetted") return "questions_only";
  return "scaffold_only";
}

function minUse(requested, allowed) {
  const a = USE_RANK[requested] ?? 0;
  const b = USE_RANK[allowed] ?? 0;
  const rank = Math.min(a, b);
  return Object.keys(USE_RANK).find((key) => USE_RANK[key] === rank) || "scaffold_only";
}

export function emptyStripTally() {
  return {
    grade: 0,
    prescription: 0,
    stm_as_fact: 0,
    ehi: 0,
    foreign_name: 0,
    peer_language: 0,
    hm_checks: 0,
  };
}

function bump(tally, key, amount = 1) {
  if (!tally || !amount) return;
  tally[key] = (tally[key] || 0) + amount;
}

export function stripGradeKeys(node, uncertainty, tally) {
  if (Array.isArray(node)) {
    node.forEach((item) => stripGradeKeys(item, uncertainty, tally));
    return node;
  }
  if (!node || typeof node !== "object") return node;
  for (const key of Object.keys(node)) {
    if (GRADE_KEYS.has(key.toLowerCase())) {
      delete node[key];
      if (uncertainty) pushUnique(uncertainty, "grade_fields_removed");
      bump(tally, "grade");
      continue;
    }
    stripGradeKeys(node[key], uncertainty, tally);
  }
  return node;
}

function walkStrings(node, fn) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      if (typeof node[i] === "string") node[i] = fn(node[i]);
      else if (node[i] && typeof node[i] === "object") walkStrings(node[i], fn);
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    if (SKIP_STRING_KEYS.has(key)) continue;
    if (typeof node[key] === "string") node[key] = fn(node[key], key);
    else if (node[key] && typeof node[key] === "object") walkStrings(node[key], fn);
  }
}

function walkObjects(node, fn) {
  if (Array.isArray(node)) {
    node.forEach((item) => walkObjects(item, fn));
    return;
  }
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walkObjects(value, fn);
  }
}

export function stripEhiText(text) {
  const next = String(text)
    .replace(/\bEHI\b(?:\s*(?:score|index|is|:|=))?\s*-?\d+(?:\.\d+)?(?:\s*\/\s*100)?/gi, "")
    .replace(/\bEHI\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/^[\s.,;:]+/, "")
    .trim();
  return next;
}

function stripPeerLanguage(text) {
  const patterns = [
    /\b\d+(?:st|nd|rd|th)\s+percentile\b/gi,
    /\bpercentiles?\b/gi,
    /\bquartiles?\b/gi,
    /\btop\s+\d+\s*%/gi,
    /\bbottom\s+third\b/gi,
    /\branked\b/gi,
    /\bcompared to other properties\b/gi,
    /\baverage for this ecoregion\b/gi,
    /\boutperforming\b/gi,
    /\bunderperforming\b/gi,
  ];
  let next = String(text);
  let hit = false;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(next)) {
      hit = true;
      pattern.lastIndex = 0;
      next = next.replace(pattern, "");
    }
  }
  if (!hit) return String(text);
  return next.replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").replace(/,\s*\./g, ".").trim();
}

function stripForeignNames(text, allowedNames) {
  let next = String(text);
  let removed = false;
  const allowed = allowedNames.map((name) => name.toLowerCase());
  for (const name of FOREIGN_NAMES) {
    if (allowed.includes(name.toLowerCase())) continue;
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    if (pattern.test(next)) {
      removed = true;
      next = next.replace(pattern, "a reference site");
    }
  }
  return { text: next, removed };
}

export function softenStateFacts(text) {
  let next = String(text);
  next = next.replace(
    /\b(?:your\s+)?(?:water|mineral|energy|community)(?:\s+cycle|\s+flow|\s+dynamics)?\s+is\s+(?:severely\s+|slightly\s+)?[A-Za-z][A-Za-z\- ]{0,40}/gi,
    "a catalogue draft might flag a concern here — does what you see on this ground match that?",
  );
  next = next.replace(
    /\b(?:is|are|was|were)\s+(?:severely\s+|slightly\s+)?(?:degraded|desertified)\b/gi,
    "might be read as under stress — worth checking on the ground",
  );
  next = next.replace(/\bclassified\s+as\b/gi, "a draft label might say");
  next = next.replace(/\bstate\s+[A-D]\b/gi, "a catalogue state label (not used as a fact)");
  next = next.replace(/\s+,/g, ",").replace(/,\s*\./g, ".").replace(/\s{2,}/g, " ").trim();
  return next;
}

function rewritePrescription(text) {
  return String(text).replace(
    new RegExp(PRESCRIBE.source, "gi"),
    "Hypothesis to test, not an instruction — what would you watch on this ground first",
  );
}

function allowedPlaceNames(req) {
  const names = [];
  const ground = req?.ground || {};
  for (const key of ["property_name", "area_name", "label"]) {
    if (ground[key]) names.push(String(ground[key]));
  }
  if (Array.isArray(ground.allowed_place_names)) {
    for (const name of ground.allowed_place_names) {
      if (name) names.push(String(name));
    }
  }
  const nav = req?.navigation_context || {};
  if (nav.label) names.push(String(nav.label));
  return names;
}

function forceHmChecksSkipped(out) {
  out.hm_checks = {
    ran: false,
    reason_if_skipped: "holistic_context_absent",
    visible_reasoning: null,
  };
}

function ensureHmQuestion(out) {
  const ask =
    "Holistic context was not shared, so the seven checks did not run. What are the quality of life, forms of production, and future resource base for this place?";
  const item = {
    level: "root_cause",
    ask,
    confidence: "low",
    falsifier: "A holistic context written by the steward would change whether these checks can run.",
  };
  if (!Array.isArray(out.questions_for_steward)) out.questions_for_steward = [];
  if (!out.questions_for_steward.some((q) => q && q.ask === ask)) {
    out.questions_for_steward.push(item);
  }
}

function dropGuttedSignals(out, uncertainty) {
  if (Array.isArray(out.signals)) {
    const before = out.signals.length;
    out.signals = out.signals.filter((signal) => {
      const text = String(signal?.observation || "").trim();
      return text && text !== "a reference site";
    });
    if (out.signals.length < before) pushUnique(uncertainty, "removed_foreign_reference");
  }
}

function enforceFalsifiers(out, uncertainty) {
  walkObjects(out, (obj) => {
    const textual = obj.observation || obj.text || obj.ask || obj.question;
    if (!textual) return;
    if (!("confidence" in obj) && !("falsifier" in obj) && !("observation" in obj)) return;
    if (obj.confidence === "high" && !String(obj.falsifier || "").trim()) {
      obj.confidence = "low";
      pushUnique(uncertainty, "falsifier_missing");
    }
  });
}

function softenPrescriptions(out, uncertainty, tally) {
  walkObjects(out, (obj) => {
    for (const field of ["text", "observation", "ask", "narrative", "answer", "question"]) {
      if (typeof obj[field] !== "string" || !PRESCRIBE.test(obj[field])) continue;
      if (String(obj.falsifier || "").trim()) continue;
      const hits = obj[field].match(new RegExp(PRESCRIBE.source, "gi"));
      obj[field] = rewritePrescription(obj[field]);
      if ((field === "text" || field === "observation") && !String(obj.falsifier || "").trim()) {
        obj.falsifier = "What you see on the next walk on this ground would overturn this.";
      }
      pushUnique(uncertainty, "prescription_without_falsifier");
      bump(tally, "prescription", hits ? hits.length : 1);
    }
  });
}

function warnCoupled(out, uncertainty) {
  let processCount = 0;
  let hasCoupled = false;
  const processKeys = ["water_cycle", "mineral_cycle", "energy_flow", "community_dynamics", "water", "mineral", "energy", "community"];
  if (out.processes && typeof out.processes === "object") {
    if (out.processes.coupled?.observations?.length) hasCoupled = true;
    for (const key of ["water_cycle", "mineral_cycle", "energy_flow", "community_dynamics"]) {
      if (out.processes[key]?.observations?.length) processCount += 1;
    }
  }
  if (Array.isArray(out.signals)) {
    const seen = new Set();
    for (const signal of out.signals) {
      if (signal?.process === "coupled") hasCoupled = true;
      if (processKeys.includes(signal?.process) && signal.process !== "coupled") seen.add(signal.process);
    }
    processCount = Math.max(processCount, seen.size);
  }
  if (hasCoupled || processCount < 2) return;
  pushUnique(uncertainty, "no_coupled_process_signal");
  const ask = "Which two processes are moving together on this ground?";
  if (out.processes?.water_cycle && Array.isArray(out.processes.water_cycle.questions)) {
    if (!out.processes.water_cycle.questions.some((q) => q && q.text === ask)) {
      out.processes.water_cycle.questions.push({
        text: ask,
        confidence: "low",
        falsifier: "A walk that shows the processes moving separately would overturn the coupling.",
      });
    }
  }
}

function flagUncited(out, uncertainty) {
  const lists = [];
  if (out.processes) {
    for (const block of Object.values(out.processes)) {
      if (block?.observations) lists.push(block.observations);
    }
  }
  for (const list of lists) {
    for (const item of list) {
      const cited = item?.citation && (item.citation.survey_id || item.citation.date);
      if (!cited) {
        if (item.confidence === "high") item.confidence = "low";
        pushUnique(uncertainty, "uncited_observation");
      }
    }
  }
}

const STM_COUNT_PATTERNS = [
  /\b(?:your\s+)?(?:water|mineral|energy|community)(?:\s+cycle|\s+flow|\s+dynamics)?\s+is\s+(?:severely\s+|slightly\s+)?[A-Za-z][A-Za-z\- ]{0,40}/gi,
  /\b(?:is|are|was|were)\s+(?:severely\s+|slightly\s+)?(?:degraded|desertified)\b/gi,
  /\bclassified\s+as\b/gi,
  /\bstate\s+[A-D]\b/gi,
];

function countPatternHits(text, patterns) {
  let count = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const hits = String(text).match(pattern);
    if (hits) count += hits.length;
  }
  return count;
}

export function sanitiseEiaReturn(req = {}, raw = {}, tally = null) {
  const uncertainty = [];
  const out = clone(raw);
  if (!Array.isArray(out.uncertainty)) out.uncertainty = [];

  const statusIn = out.catalogue?.status || req.catalogue?.status || "missing";
  const status = ["present_human_vetted", "ai_draft_not_vetted", "missing"].includes(statusIn)
    ? statusIn
    : "missing";
  const requestedUse = out.catalogue?.use || "scaffold_only";
  const allowed = allowedUseForStatus(status);
  const use = minUse(requestedUse, allowed);
  out.catalogue = {
    ...(out.catalogue && typeof out.catalogue === "object" ? out.catalogue : {}),
    status,
    use,
  };
  if (use !== requestedUse) pushUnique(uncertainty, "catalogue_use_downgraded");

  stripGradeKeys(out, uncertainty, tally);

  const holisticPresent = req.holistic_context?.present === true || req.consent?.holistic_context_shared === true;
  if (!holisticPresent) {
    const claimed = out.hm_checks?.ran === true || (out.hm_checks && out.hm_checks.visible_reasoning);
    forceHmChecksSkipped(out);
    if (claimed) {
      pushUnique(uncertainty, "holistic_context_absent");
      bump(tally, "hm_checks");
      ensureHmQuestion(out);
    }
  }

  const noForeign = req.constraints?.no_foreign_property_names !== false;
  const noStm = req.constraints?.no_stm_state_as_fact !== false || use !== "scoring_allowed";
  const aggregateOk = req.consent?.aggregate_ok === true;
  const ehiPresent = req.ground?.ehi_if_present != null;
  const names = allowedPlaceNames(req);
  let hmProse = false;

  walkStrings(out, (value) => {
    let text = value;
    if (!ehiPresent) {
      const next = stripEhiText(text);
      if (next !== text) {
        text = next;
        pushUnique(uncertainty, "ehi_absent");
        bump(tally, "ehi");
      }
    }
    if (!aggregateOk) {
      const next = stripPeerLanguage(text);
      if (next !== text) {
        text = next;
        pushUnique(uncertainty, "peer_language_removed");
        bump(tally, "peer_language");
      }
    }
    if (noForeign) {
      const next = stripForeignNames(text, names);
      if (next.removed) {
        pushUnique(uncertainty, "removed_foreign_reference");
        bump(tally, "foreign_name");
      }
      text = next.text;
    }
    if (noStm) {
      const hits = countPatternHits(text, STM_COUNT_PATTERNS);
      const next = softenStateFacts(text);
      if (next !== text) {
        text = next;
        pushUnique(uncertainty, "stm_state_as_fact_removed");
        bump(tally, "stm_as_fact", hits || 1);
      }
    }
    if (!holisticPresent && HM_PROSE.test(text)) {
      hmProse = true;
      bump(tally, "hm_checks");
      text = text.replace(HM_PROSE, "holistic context was not shared, so that check was not run");
    }
    return text;
  });

  if (hmProse) {
    pushUnique(uncertainty, "holistic_context_absent");
    ensureHmQuestion(out);
  }

  dropGuttedSignals(out, uncertainty);
  enforceFalsifiers(out, uncertainty);
  softenPrescriptions(out, uncertainty, tally);
  warnCoupled(out, uncertainty);
  flagUncited(out, uncertainty);

  for (const code of uncertainty) pushUnique(out.uncertainty, code);
  out.never_include = [
    "foreign_property_names",
    "peer_percentiles_without_aggregate_ok",
    "ehi",
    "journey_stage",
    "limiting_process",
    "priority_lever",
  ];
  stripGradeKeys(out);
  return out;
}

export function sanitiseFreeText(text, req = {}, tally = null) {
  const wrapped = sanitiseEiaReturn(req, { answer: String(text ?? "") }, tally);
  return {
    text: wrapped.answer || "",
    uncertainty: wrapped.uncertainty || [],
    hm_checks: wrapped.hm_checks,
  };
}
