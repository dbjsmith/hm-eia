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
  "score",
  "grade",
  "health_index",
  "ecological_health_index",
  "ecosystem_health_index",
  "stage",
  "rank",
  "rating",
  "scoring_allowed",
]);

const FOREIGN_NAMES = [
  "Knepp",
  "Carrifran",
  "Brown's Ranch",
  "Browns Ranch",
  "White Oak Pastures",
  "Yellowstone",
  "Serengeti",
];

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
  "field_method",
  "generated_at",
  "label",
]);

const PRESCRIBE =
  /\b(you should|you must|you need to|i recommend|the best action is|increase stocking|reduce stocking|destock(?:\s+by\s+half)?|rest the paddock|rest it|apply herbicide|graze harder|move the (stock|animals|herd|cattle)|most important management action)\b/i;

const HARD_GRADE =
  /\blimiting\s+(?:process|factor)\b|\bjourney\s+stage\b|\bgrade[ds]?\b|\bscored\b|\bscore\s+of\b|\bpriority\s+(?:lever|action)\b/i;

const EHI_LIKE =
  /\bEHI\b|\b(?:ecological|ecosystem)\s+health\s+index\b|\b\d+\s*\/\s*100\b|\bout\s+of\s+100\b/i;

const SEEK_INSTEAD = "What would you look at on this ground, and what would change your mind?";
const WATCH_INSTEAD = "What would you watch on this ground first, and what would show this guess was wrong?";

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
    /\bbottom\s+half\b/gi,
    /\bbottom\s+quartile\b/gi,
    /\bbottom\s+\d+\s*%/gi,
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function quotesRecordedEhi(text, recorded) {
  if (!recorded || recorded.value == null || recorded.value === "") return false;
  const value = String(recorded.value);
  if (!new RegExp(`\\b${escapeRegExp(value)}\\b`).test(String(text))) return false;
  return /\brecorded\b/i.test(String(text));
}

function splitSentences(text) {
  return String(text).split(/(?<=[.!?])\s+|\n+/);
}

export function rewriteStewardText(text, recorded = null, uncertainty = null, tally = null) {
  let gradeHits = 0;
  let ehiHits = 0;
  let prescribeHits = 0;
  const next = splitSentences(text).map((sentence) => {
    const hard = HARD_GRADE.test(sentence);
    const ehi = EHI_LIKE.test(sentence);
    const prescribe = PRESCRIBE.test(sentence);
    const quoted = quotesRecordedEhi(sentence, recorded);
    if ((hard || (ehi && !quoted)) && !(quoted && !hard && !prescribe)) {
      gradeHits += 1;
      if (ehi && !quoted) ehiHits += 1;
      return SEEK_INSTEAD;
    }
    if (prescribe) {
      prescribeHits += 1;
      return WATCH_INSTEAD;
    }
    return sentence;
  });
  if (gradeHits) {
    if (uncertainty) pushUnique(uncertainty, "grade_language_removed");
    bump(tally, "grade", gradeHits);
  }
  if (ehiHits) {
    if (uncertainty) pushUnique(uncertainty, "ehi_absent");
    bump(tally, "ehi", ehiHits);
  }
  if (prescribeHits) {
    if (uncertainty) pushUnique(uncertainty, "prescription_removed");
    bump(tally, "prescription", prescribeHits);
  }
  const collapsed = next
    .join(" ")
    .replace(new RegExp(`(?:${escapeRegExp(SEEK_INSTEAD)}\\s*){2,}`, "g"), `${SEEK_INSTEAD} `)
    .replace(/\s{2,}/g, " ")
    .trim();
  return collapsed;
}

function normaliseStatus(status) {
  return ["present_human_vetted", "ai_draft_not_vetted", "missing"].includes(status) ? status : "missing";
}

export function recordedEhiFromEvidence(surveys, answersBySurvey) {
  const question = /\b(ehi|ecosystem health index|ecological health index)\b/i;
  for (const survey of Array.isArray(surveys) ? surveys : []) {
    if (!survey || typeof survey !== "object") continue;
    const id = survey._apikey || survey.apikey || survey.id;
    if (!id) continue;
    const answers = (answersBySurvey && (answersBySurvey[id] || answersBySurvey[survey._apikey])) || [];
    for (const answer of answers) {
      if (!question.test(String(answer?.question || ""))) continue;
      const match = String(answer?.answer ?? "").match(/-?\d+(?:\.\d+)?/);
      if (!match) continue;
      return {
        value: match[0],
        survey_id: String(id),
        date: String(survey._date || survey.date || survey.survey_date || ""),
      };
    }
  }
  return null;
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

function knownSurveyIdSet(req) {
  const raw = req?.known_survey_ids;
  if (raw == null) return null;
  if (raw instanceof Set) return new Set([...raw].map((id) => String(id)));
  if (!Array.isArray(raw)) return null;
  return new Set(raw.map((id) => String(id)));
}

function relocateBadCitations(out, ids, uncertainty) {
  if (!ids) return [];
  const rejected = [];
  let moved = false;
  const remember = (id) => {
    moved = true;
    if (id) rejected.push(String(id));
  };
  if (out.processes && typeof out.processes === "object") {
    for (const block of Object.values(out.processes)) {
      if (!block || typeof block !== "object" || !Array.isArray(block.observations)) continue;
      const keep = [];
      const gaps = Array.isArray(block.gaps) ? block.gaps.slice() : [];
      for (const item of block.observations) {
        const id = item?.citation?.survey_id ? String(item.citation.survey_id) : "";
        if (id && ids.has(id)) {
          keep.push(item);
          continue;
        }
        remember(id);
        const gap = { ...(item && typeof item === "object" ? item : { text: String(item || "") }) };
        gap.confidence = "low";
        gap.citation = null;
        if (!String(gap.falsifier || "").trim()) {
          gap.falsifier = "A survey id from this record would be needed before this can be read as an observation.";
        }
        gaps.push(gap);
      }
      block.observations = keep;
      block.gaps = gaps;
    }
  }
  if (Array.isArray(out.signals)) {
    const keep = [];
    for (const signal of out.signals) {
      const id = signal?.citation?.survey_id ? String(signal.citation.survey_id) : "";
      if (!id || ids.has(id)) {
        keep.push(signal);
        continue;
      }
      remember(id);
    }
    out.signals = keep;
  }
  if (Array.isArray(out.citations)) {
    out.citations = out.citations.filter((cite) => {
      const id = cite?.survey_id ? String(cite.survey_id) : "";
      if (id && ids.has(id)) return true;
      remember(id);
      return false;
    });
  }
  if (moved) pushUnique(uncertainty, "citation_not_in_record");
  return rejected;
}

function redactRejectedIds(text, rejected) {
  let next = String(text);
  for (const id of rejected) {
    if (!id) continue;
    next = next.split(id).join("a survey id that is not in this record");
  }
  return next;
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

export function statusFromPackage(pkg) {
  if (!pkg || typeof pkg !== "object") {
    return { status: "missing", use: "scaffold_only", ecoregion_id: null, scoring_allowed: false };
  }
  const cat = pkg.catalogue && typeof pkg.catalogue === "object" ? pkg.catalogue : {};
  const status = normaliseStatus(cat.status);
  let use = allowedUseForStatus(status);
  if (typeof cat.use === "string" && USE_RANK[cat.use] != null) use = minUse(cat.use, use);
  if (cat.scoring_allowed !== true && use === "scoring_allowed") use = "questions_only";
  return {
    status,
    use,
    ecoregion_id: pkg.eco_id || pkg.ecoregion_id || cat.ecoregion_id || null,
    scoring_allowed: use === "scoring_allowed" && cat.scoring_allowed === true && status === "present_human_vetted",
  };
}

export function sanitiseEiaReturn(req = {}, raw = {}, tally = null) {
  const uncertainty = [];
  const out = clone(raw);
  if (!Array.isArray(out.uncertainty)) out.uncertainty = [];

  const serverStatus = normaliseStatus(req.catalogue?.status);
  const modelStatus = out.catalogue && typeof out.catalogue === "object" ? normaliseStatus(out.catalogue.status) : null;
  const modelUse = out.catalogue && typeof out.catalogue === "object" ? out.catalogue.use : null;
  if (out.catalogue && typeof out.catalogue === "object" && modelStatus !== serverStatus) {
    pushUnique(uncertainty, "catalogue_status_overridden");
  }
  const allowed = allowedUseForStatus(serverStatus);
  let use = allowed;
  if (req.catalogue?.use && USE_RANK[req.catalogue.use] != null) use = minUse(req.catalogue.use, allowed);
  if (req.catalogue?.scoring_allowed !== true && use === "scoring_allowed") use = "questions_only";
  if (modelUse && USE_RANK[modelUse] != null && modelUse !== use) {
    pushUnique(uncertainty, "catalogue_use_downgraded");
  }
  out.catalogue = {
    ecoregion_id: req.catalogue?.ecoregion_id || null,
    status: serverStatus,
    use,
    source: req.catalogue?.source || "server",
  };

  stripGradeKeys(out, uncertainty, tally);

  const surveyIds = knownSurveyIdSet(req);
  const rejectedIds = relocateBadCitations(out, surveyIds, uncertainty);
  const recorded = req.recorded_ehi || null;

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
  const names = allowedPlaceNames(req);
  let hmProse = false;

  walkStrings(out, (value) => {
    let text = redactRejectedIds(value, rejectedIds);
    text = rewriteStewardText(text, recorded, uncertainty, tally);
    if (!recorded) {
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
