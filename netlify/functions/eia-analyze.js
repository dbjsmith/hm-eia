/**
 * eia-analyze.js  —  EIA three-perspective question engine
 *
 * Self-contained. No imports. Drop-in replacement for the existing function.
 *
 * Modes:
 *   overview (default) — ecological narrative + five targeted questions
 *   answer             — answer one follow-up question; returns { answer }
 *
 * Reasoning before Claude is called (overview):
 *   1. Identify limiting EOV process (lowest score; water cycle breaks ties)
 *   2. Classify journey stage from EHI band
 *   3. Detect data quality and anomalies
 *   4. Build a pre-reasoned brief so Claude generates targeted questions
 *
 * Each generated question serves three perspectives:
 *   FARMER   — observable, decision-relevant, answerable in the field
 *   MONITOR  — produces a defensible, recordable indicator
 *   EI       — probes a specific ecosystem process function
 */

// ─── PROCESS TAXONOMY ────────────────────────────────────────────────────────

const PROCESSES = {
  water_cycle: {
    label: 'Water Cycle',
    emoji: '💧',
    master: true,
    ei_question: 'Where is water going that should be staying?',
    indicators: ['bare ground %', 'soil surface condition', 'infiltration vs runoff after rain', 'plant root depth'],
    metrics: ['bare ground score (0–5)', 'water infiltration rate', 'soil surface capping presence'],
    signals: ['bare ground > 30%', 'water sheets off after rain', 'soil surface is sealed or crusted', 'plants widely spaced with exposed soil between']
  },
  mineral_cycle: {
    label: 'Mineral Cycle',
    emoji: '🍂',
    ei_question: 'Is organic matter accumulating or disappearing?',
    indicators: ['litter cover and depth', 'decomposition rate', 'dung beetle activity', 'soil invertebrate presence'],
    metrics: ['litter cover score (0–5)', 'decomposition index', 'dung beetle burrow count per m²'],
    signals: ['plant material standing dead and not decomposing', 'dung dry and intact after weeks', 'litter layer absent or very thin']
  },
  energy_flow: {
    label: 'Energy Flow',
    emoji: '☀️',
    ei_question: 'Is the solar panel big enough, and is energy moving through all trophic levels?',
    indicators: ['canopy cover and leaf area', 'plant density', 'recovery period adequacy', 'animal impact distribution'],
    metrics: ['canopy cover score (0–5)', 'plant density per m²', 'recovery adequacy score'],
    signals: ['plants grazed before fully recovering', 'large areas underused or ungrazed', 'monocultures dominating', 'excess standing biomass OR bare soil']
  },
  community_dynamics: {
    label: 'Community Dynamics',
    emoji: '🌿',
    ei_question: 'Is this ecosystem moving towards or away from its ecological potential?',
    indicators: ['species diversity trend', 'desired vs undesired species ratio', 'succession direction', 'functional guild composition'],
    metrics: ['species richness per survey point', 'desired species %', 'functional guild count', 'weed pressure score (0–5)'],
    signals: ['species diversity declining', 'annual weeds or invasives increasing', 'perennial grasses replaced by annuals', 'key functional guilds absent']
  }
};

// ─── QUESTION LENSES ─────────────────────────────────────────────────────────

const LENSES = {
  diagnostic:        { emoji: '🔎', label: 'What\'s limiting?',    best_for: 'low scores, declining trend, anomalies' },
  decisional:        { emoji: '🎯', label: 'What do I do next?',   best_for: 'planning season, before stock movement' },
  validation:        { emoji: '✅', label: 'Is it working?',       best_for: 'after sustained practice change' },
  trend:             { emoji: '📈', label: 'Is it improving?',     best_for: 'annual review, multi-year trajectory' },
  water_event:       { emoji: '🌧️', label: 'Read the rain',        best_for: 'post-rain visits, drought recovery' },
  intervention_test: { emoji: '🧪', label: 'What did the land say?', best_for: 'after specific interventions or events' },
  blind_spot:        { emoji: '🌀', label: 'What am I missing?',   best_for: 'optimising stage, subtle signals' }
};

// ─── REASONING HELPERS ────────────────────────────────────────────────────────

function identifyLimitingProcess(scores) {
  const candidates = ['water_cycle', 'mineral_cycle', 'energy_flow', 'community_dynamics']
    .map(k => ({ key: k, score: scores[k] }))
    .filter(c => c.score !== null && c.score !== undefined);

  if (!candidates.length) return null;

  candidates.sort((a, b) => a.score - b.score);
  const lowest = candidates[0];
  const second = candidates[1];

  // Water cycle breaks ties — it's the master process
  if (second && (second.score - lowest.score) < 5 && lowest.key !== 'water_cycle') {
    const wc = scores.water_cycle;
    if (wc !== null && wc !== undefined && wc <= lowest.score + 10) return 'water_cycle';
  }

  return lowest.key;
}

function classifyJourneyStage(ehi) {
  if (ehi === null || ehi === undefined) {
    return { stage: 'unknown', label: 'Establishing Baseline', lenses: ['diagnostic', 'water_event', 'blind_spot'] };
  }
  if (ehi < 30) {
    return { stage: 'early', label: 'Early Regeneration', lenses: ['diagnostic', 'water_event', 'decisional'] };
  }
  if (ehi < 55) {
    return { stage: 'building', label: 'Building Function', lenses: ['validation', 'diagnostic', 'intervention_test'] };
  }
  if (ehi < 75) {
    return { stage: 'accelerating', label: 'Accelerating Recovery', lenses: ['trend', 'intervention_test', 'blind_spot'] };
  }
  return { stage: 'optimising', label: 'Optimising', lenses: ['trend', 'blind_spot', 'community_dynamics'] };
}

function assessDataQuality(surveys, answered, total) {
  if (!surveys.length || !total) return 'none';
  const rate = answered / total;
  if (surveys.length >= 5 && rate > 0.7 && answered > 30) return 'rich';
  if (surveys.length >= 2 && rate > 0.4 && answered > 10) return 'partial';
  return 'sparse';
}

function detectAnomalies(answers, scores) {
  const flags = [];
  if (scores.water_cycle > 70 && scores.community_dynamics < 30)
    flags.push('Water cycle high but community dynamics very low — water access may exist without functional diversity');
  if (scores.energy_flow > 70 && scores.mineral_cycle < 30)
    flags.push('Energy flow high but mineral cycle low — biomass accumulating without decomposing (oxidising, not cycling)');
  if (answers.some(a => typeof a.answer === 'number' && a.question?.toLowerCase().includes('bare') && a.answer > 50))
    flags.push('High bare ground in survey data — water cycle likely severely limited regardless of scores');
  return flags;
}

// ─── PROMPT BUILDER ───────────────────────────────────────────────────────────

function buildPrompt({ propertyName, contextKind, surveyCount, eovScores, limitingProcess, journeyStage, dataQuality, answeredSample, answeredCount, totalCount, guildGaps, anomalies }) {

  const scoreLines = ['water_cycle', 'mineral_cycle', 'energy_flow', 'community_dynamics'].map(k => {
    const p = PROCESSES[k];
    const score = (eovScores[k] !== null && eovScores[k] !== undefined) ? `${eovScores[k]}/100` : 'no data';
    const flag = k === limitingProcess ? '  ← LIMITING PROCESS' : '';
    return `  ${p.emoji} ${p.label}: ${score}${flag}`;
  }).join('\n');

  const lp = limitingProcess ? PROCESSES[limitingProcess] : null;
  const limitingDetail = lp ? `
## Limiting Process: ${lp.label}
Core EI question: "${lp.ei_question}"
Key indicators to probe: ${lp.indicators.join(' | ')}
Monitorable metrics: ${lp.metrics.join(' | ')}
Intervention signals to look for: ${lp.signals.join(' | ')}` : '\n## Limiting Process: insufficient data';

  const lensGuide = journeyStage.lenses.map(l => {
    const lens = LENSES[l] || {};
    return `  ${lens.emoji || ''} ${lens.label || l} — best for: ${lens.best_for || l}`;
  }).join('\n');

  const answerText = answeredSample.length
    ? answeredSample.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n')
    : 'No answered questions yet.';

  const anomalyText = anomalies.length ? `\n## Anomalies\n${anomalies.map(a => `- ${a}`).join('\n')}` : '';
  const guildText = guildGaps.length ? `\n## Missing Functional Guilds\n${guildGaps.map(g => `- ${g}`).join('\n')}` : '';

  const system = `You are EIA — the Ecologically Intelligent Agent, the field advisor for GeoDataTrack.
You are a provocateur in the best sense: you ask the questions that shift perspective and help land managers see their landscape more clearly. You draw out what farmers already know rather than prescribing what to do.

You reason through four ecosystem processes (EOV framework):
- Water Cycle: the master process — where rain goes determines everything else
- Mineral Cycle: the system's memory — organic matter accumulating or disappearing?
- Energy Flow: the productivity engine — is the solar panel big enough?
- Community Dynamics: the direction of travel — towards or away from ecological potential?

THREE-PERSPECTIVE DISCIPLINE: Every question must serve all three simultaneously:
1. FARMER — answerable from direct field observation. Helps them decide, understand, or validate.
2. MONITOR — produces a defensible, recordable indicator. Protects the integrity of the record.
3. ECOLOGICAL INTELLIGENCE — targets a specific process function. Connects to intervention if failing.

QUESTION RULES:
- Lead with the limiting process — target the weakest EOV dimension first
- Ground in the observable — answerable by walking the land, not desk analysis
- Activate farmer memory — good questions mine longitudinal knowledge the farmer holds
- Make anomalies welcome — unexpected outcomes are the most ecologically informative data
- Vary the lenses — never generate five diagnostic questions in a row

Respond ONLY with valid JSON. No markdown, no preamble, no explanation.`;

  const user = `## Property
Name: ${propertyName} | Context: ${contextKind} | Surveys: ${surveyCount} | Data: ${dataQuality}
Answers: ${answeredCount}/${totalCount}

## Journey Stage: ${journeyStage.label} (${journeyStage.stage})
Recommended question lenses:
${lensGuide}

## EOV Scores
EHI: ${eovScores.ehi !== null && eovScores.ehi !== undefined ? eovScores.ehi + '/100' : 'no data'}
${scoreLines}
${guildText}${anomalyText}
${limitingDetail}

## Survey Evidence (up to 50 answers)
${answerText}

---

## Generate:

### 1. Ecological Narrative (3–4 sentences)
Interpret the ecological state of ${propertyName}.
- Be specific — name the limiting process and WHY it's limiting
- Situate the property in its regeneration journey
- Tone: direct, ecological, honest

### 2. Five EIA Questions
Distribution rules:
- At least 2 questions target the limiting process
- At least 1 uses a non-diagnostic lens (trend, validation, intervention_test, water_event, or blind_spot)
- At least 1 activates the farmer's longitudinal memory (compare now to a past season)
- Vary observation types — don't repeat the same kind of field walk

For each question provide:
- question: the actual text — specific, observable, field-answerable
- lens: one of [diagnostic, decisional, validation, trend, water_event, intervention_test, blind_spot]
- lens_emoji: the emoji for that lens
- lens_label: the label for that lens
- dimension: one of [water_cycle, mineral_cycle, energy_flow, community_dynamics]
- dimension_label: the label for that dimension
- farmer_value: 1 sentence — what this helps the farmer understand or decide
- monitor_value: 1 sentence — what indicator this produces for the record
- ei_value: 1 sentence — which process function this probes and how
- field_method: one of [walk and observe, count and record, compare to reference, photograph and mark, interview memory]

### 3. Support fields
- ecological_strength: 1 sentence — the highest-scoring dimension and what it signals
- priority_lever: 1 sentence — the single most important management action
- next_field_visit: 2–3 sentences — what to prioritise on the next visit

## JSON Schema
{
  "narrative": "...",
  "limiting_process": "water_cycle|mineral_cycle|energy_flow|community_dynamics|unknown",
  "journey_stage": "early|building|accelerating|optimising|unknown",
  "ecological_strength": "...",
  "priority_lever": "...",
  "next_field_visit": "...",
  "questions": [
    {
      "question": "...",
      "lens": "...",
      "lens_emoji": "...",
      "lens_label": "...",
      "dimension": "...",
      "dimension_label": "...",
      "farmer_value": "...",
      "monitor_value": "...",
      "ei_value": "...",
      "field_method": "..."
    }
  ],
  "data_quality": "rich|partial|sparse|none"
}`;

  return { system, user };
}

// ─── ANSWER-MODE PROMPT ───────────────────────────────────────────────────────

function buildAnswerPrompt({ propertyName, contextKind, question, answeredSample, answeredCount, totalCount, surveyCount }) {
  const answerText = answeredSample.length
    ? answeredSample.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n')
    : 'No answered survey questions available yet.';

  const system = `You are EIA — the Ecologically Intelligent Agent, the field advisor for GeoDataTrack.
You answer follow-up questions about a property's monitoring data in a Socratic, grounded way.
Draw on the survey evidence provided. Be direct and ecological. Prefer asking the farmer to notice over prescribing.
When data is thin, say so and suggest what to observe next.
Respond ONLY with valid JSON: { "answer": "..." }. No markdown, no preamble.`;

  const user = `## Property
Name: ${propertyName} | Context: ${contextKind} | Surveys: ${surveyCount}
Answers available: ${answeredCount}/${totalCount}

## Survey Evidence
${answerText}

## Farmer's question
${question}

## JSON Schema
{ "answer": "2–5 sentences grounded in the evidence above" }`;

  return { system, user };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const {
    mode = 'overview',
    question = '',
    navigation_context = {},
    eov_scores = {},
    surveys = [],
    answers_by_survey = {},
    guild_gaps = []
  } = body;

  // Flatten answers
  const allAnswers = Object.values(answers_by_survey).flat();
  const answered = allAnswers.filter(a => a.answer !== null && a.answer !== undefined && a.answer !== '');
  const sample = answered.slice(0, 50);

  const propertyName = navigation_context.label || navigation_context.property?.name || 'this property';
  const contextKind  = navigation_context.kind || 'property';

  // ── Answer mode: single follow-up question → { answer } ──
  if (mode === 'answer') {
    if (!question || !String(question).trim()) {
      return new Response(JSON.stringify({ error: 'Missing question for answer mode' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('[eia-analyze]', { mode: 'answer', propertyName, question: String(question).slice(0, 80) });

    const { system, user } = buildAnswerPrompt({
      propertyName, contextKind,
      question: String(question).trim(),
      answeredSample: sample,
      answeredCount: answered.length,
      totalCount: allAnswers.length,
      surveyCount: surveys.length
    });

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 800,
          system,
          messages: [{ role: 'user', content: user }]
        })
      });

      const aiData = await resp.json();
      if (!resp.ok) throw new Error(aiData.error?.message || 'Claude API error');

      const rawText = (aiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // Model sometimes returns plain prose — treat whole text as the answer
        parsed = { answer: cleaned || rawText };
      }

      const answer = parsed.answer || parsed.response || cleaned || 'No insight available.';
      return new Response(JSON.stringify({ answer }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      console.error('[eia-analyze] answer error:', err.message);
      return new Response(JSON.stringify({
        answer: 'EIA is temporarily unavailable. Please try again shortly.'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // ── Overview mode (default): narrative + questions ──
  const dataQuality     = assessDataQuality(surveys, answered.length, allAnswers.length);
  const limitingProcess = identifyLimitingProcess(eov_scores);
  const journeyStage    = classifyJourneyStage(eov_scores.ehi);
  const anomalies       = detectAnomalies(answered, eov_scores);

  console.log('[eia-analyze]', { mode: 'overview', propertyName, limitingProcess, journey: journeyStage.stage, dataQuality, answers: answered.length });

  const { system, user } = buildPrompt({
    propertyName, contextKind,
    surveyCount: surveys.length,
    eovScores: eov_scores,
    limitingProcess, journeyStage, dataQuality,
    answeredSample: sample,
    answeredCount: answered.length,
    totalCount: allAnswers.length,
    guildGaps: guild_gaps,
    anomalies
  });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });

    const aiData = await resp.json();
    if (!resp.ok) throw new Error(aiData.error?.message || 'Claude API error');

    const rawText = (aiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error('[eia-analyze] parse failed, raw:', rawText.slice(0, 300));
      parsed = {
        narrative: 'EIA received your data but could not format the analysis. Please try again.',
        questions: [], data_quality: dataQuality
      };
    }

    // Attach server reasoning context
    parsed._reasoning = {
      limiting_process: limitingProcess,
      journey_stage: journeyStage.stage,
      journey_label: journeyStage.label,
      data_quality: dataQuality,
      anomalies: anomalies.length,
      surveys: surveys.length,
      answers: answered.length
    };

    return new Response(JSON.stringify(parsed), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[eia-analyze] error:', err.message);
    return new Response(JSON.stringify({
      narrative: 'EIA is temporarily unavailable.',
      questions: [], _reasoning: { error: err.message }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
};
