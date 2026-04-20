import OpenAI from 'openai';
import { asyncHandler, AppError } from '../middleware/error.middleware.js';
import { renderPlan2DSvg } from '../utils/plan2dRenderer.js';
import { roundToGrid, validateAndNormalizePlan2D } from '../plan2d/plan2dValidation.js';
import { interpretPrompt, summarizeInterpreted } from '../plan2d/promptInterpreter.js';
import { applyConstraints, buildLLMConstraintFooter, minEnvelopeHeightForApartmentStack } from '../plan2d/constraintEngine.js';
import { generateArchitectPlan } from '../plan2d/layoutGenerator.js';
import { generatePlanFromIntent } from '../plan2d/intentLayout.js';
import { validateArchitecturalRules } from '../plan2d/architecturalRules.js';
import { geometryLayout } from '../services/geometryServiceClient.js';
import { extractConstraints, extractConstraintsHeuristic } from '../plan2d/constraintExtractor.js';
import { getArchitectureGuideBlockForPrompt, computeFootprintFromAreaM2 } from '../plan2d/floorPlanArchitectureGuide.js';
import { buildOpenPlanSegmentsFromLivingKitchen } from '../plan2d/openPlanSegmentsFromRooms.js';

const MAX_INPUT_LENGTH = Number(process.env.TEXT2D_PLAN_MAX_INPUT_LENGTH) || 6000;

const CACHE_TTL_MS = Number(process.env.TEXT2D_PLAN_CACHE_TTL_MS) || 5 * 60_000;
const CACHE_MAX = Number(process.env.TEXT2D_PLAN_CACHE_MAX) || 200;

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  if (!key) return;
  cache.set(key, { at: Date.now(), data });
  if (cache.size <= CACHE_MAX) return;
  const firstKey = cache.keys().next().value;
  if (firstKey) cache.delete(firstKey);
}

function renderPlanSvgs(plan, norms) {
  return {
    svg: renderPlan2DSvg(plan, { theme: 'architectural_bw', norms }),
  };
}

function extractJsonPayload(content) {
  const s = String(content ?? '').trim();
  
  const m = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(s);
  return m ? m[1].trim() : s;
}

function buildIntentSystemPrompt() {
  return (
    'You are building a domain-specific reasoning engine for architectural floor plans.\n' +
    'Convert ANY messy / multilingual brief into a structured intent.\n' +
    'Do NOT output a layout image. Output ONLY valid JSON.\n\n' +
    'MANDATORY: THINK BEFORE DRAWING.\n' +
    'You are NOT allowed to jump directly from text to room rectangles.\n' +
    'You MUST first produce: ZONES → PRIORITY RULES → MAIN FLOW → BLOCK LAYOUT → ROOM PLACEMENT → LOGIC CHECKS.\n' +
    'If any mandatory reasoning section is missing, the output is invalid.\n\n' +
    'You MUST simulate 4 internal agents (but still output one single JSON object):\n' +
    '- agent1_nlp_parser: entities + relationships + implicit requirements + inferred missing.\n' +
    '- agent2_program_normalizer: standardized program + constraints + zones.\n' +
    '- agent3_spatial_graph: nodes + typed edges.\n' +
    '- agent4_layout_synthesizer: zoning-first reasoning + block layout + checks (no coordinates here).\n\n' +
    'Architectural minimums:\n' +
    '- bedroom >= 3m x 3m\n' +
    '- WC depth <= 2m\n' +
    '- minimize corridors, group wet rooms, ensure daylight for habitable rooms when possible\n\n' +
    'Output schema (STRICT):\n' +
    '{\n' +
    '  "agent1_nlp_parser": {\n' +
    '    "entities": {\n' +
    '      "building_type": "house" | "apartment" | "unknown",\n' +
    '      "dimensions": { "width_m": number|null, "height_m": number|null } | null,\n' +
    '      "floors": number|null,\n' +
    '      "rooms": {\n' +
    '        "bedrooms": number,\n' +
    '        "bathrooms": number,\n' +
    '        "wc": number,\n' +
    '        "kitchen": number,\n' +
    '        "living": number,\n' +
    '        "dining": number,\n' +
    '        "garage": number,\n' +
    '        "office": number,\n' +
    '        "dressing": number,\n' +
    '        "laundry": number,\n' +
    '        "storage": number,\n' +
    '        "entry": number\n' +
    '      }\n' +
    '    },\n' +
    '    "relationships": [\n' +
    '      { "type": "position" | "adjacency" | "separation", "from": string, "to": string, "value": string }\n' +
    '    ],\n' +
    '    "preferences": { "open_kitchen": boolean, "wants_island": boolean, "privacy_high": boolean, "minimize_circulation": boolean },\n' +
    '    "missing_inferred": { "added_wc": boolean, "added_storage": boolean, "added_circulation": boolean }\n' +
    '  },\n' +
    '  "agent2_program_normalizer": {\n' +
    '    "program": [ { "id": string, "label": string, "zone": "day" | "night" | "service", "count": number } ],\n' +
    '    "constraints": [ { "id": string, "kind": "must" | "prefer", "from": string, "to": string, "value": string } ],\n' +
    '    "zones": { "day": string[], "night": string[], "service": string[] }\n' +
    '  },\n' +
    '  "agent3_spatial_graph": {\n' +
    '    "nodes": string[],\n' +
    '    "edges": [ { "from": string, "to": string, "type": "direct_access" | "adjacency" | "visual_connection", "priority": "must" | "prefer" } ]\n' +
    '  },\n' +
    '  "agent4_layout_synthesizer": {\n' +
    '    "zones": { "day": string[], "night": string[], "service": string[] },\n' +
    '    "priority_rules": string[],\n' +
    '    "main_flow": string[],\n' +
    '    "block_layout": {\n' +
    '      "day_block": { "position": "north"|"south"|"east"|"west"|"center", "notes": string },\n' +
    '      "night_block": { "position": "north"|"south"|"east"|"west"|"center", "notes": string },\n' +
    '      "service_block": { "position": "north"|"south"|"east"|"west"|"center", "notes": string }\n' +
    '    },\n' +
    '    "room_placement_notes": string[],\n' +
    '    "logic_checks": { "status": "ok" | "needs_repair", "issues": string[] }\n' +
    '  }\n' +
    '}\n' +
    getArchitectureGuideBlockForPrompt()
  );
}

function hasNonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

function rect(r) {
  const x = Number(r?.x);
  const y = Number(r?.y);
  const w = Number(r?.w);
  const h = Number(r?.h);
  return { x, y, w, h, x2: x + w, y2: y + h };
}

function areaRect(r) {
  return Number(r?.w) * Number(r?.h);
}

function isFiniteRect(r) {
  return [r?.x, r?.y, r?.w, r?.h].every((n) => Number.isFinite(Number(n)));
}

function shareBoundary(a, b, tol = 1e-6) {
  
  const A = rect(a);
  const B = rect(b);
  if (!isFiniteRect(A) || !isFiniteRect(B)) return false;

  const vTouch = Math.abs(A.x2 - B.x) <= tol || Math.abs(B.x2 - A.x) <= tol;
  if (vTouch) {
    const oy = Math.min(A.y2, B.y2) - Math.max(A.y, B.y);
    if (oy > tol) return true;
  }
  const hTouch = Math.abs(A.y2 - B.y) <= tol || Math.abs(B.y2 - A.y) <= tol;
  if (hTouch) {
    const ox = Math.min(A.x2, B.x2) - Math.max(A.x, B.x);
    if (ox > tol) return true;
  }
  return false;
}

function pickEnvelopeFromArea(area_m2, attemptIdx, intentForMinHeight = null) {
  const a = Number(area_m2);
  if (!Number.isFinite(a) || a < 20 || a > 500) return null;
  const step = 0.25;
  const round = (n) => roundToGrid(n, step);
  const fp = computeFootprintFromAreaM2(a);
  let w = fp.width_m;
  let h = fp.height_m;

  const counts = intentForMinHeight?.roomCounts || {};
  const beds = Math.min(4, Math.max(1, Math.round(Number(counts.bedrooms) || 1)));
  const minWForBedLanes = round(Math.max(6, beds * 2.5));

  const minHNeed = minEnvelopeHeightForApartmentStack(intentForMinHeight || {});
  if (minHNeed > 0 && h + 1e-6 < minHNeed) h = round(minHNeed);
  w = round(a / Math.max(0.1, h));
  if (w + 1e-6 < minWForBedLanes) {
    w = minWForBedLanes;
    h = round(a / Math.max(0.1, w));
    if (minHNeed > 0 && h + 1e-6 < minHNeed) h = round(minHNeed);
  }

  const k = Math.max(0, Math.floor(Number(attemptIdx) || 0));
  if (k > 0) {
    w = round(Math.min(40, Math.max(6, w + (k % 5) * 0.25)));
    h = round(Math.min(40, Math.max(5, a / Math.max(0.1, w))));
  }

  if (process.env.DEBUG_PLACER === '1') {
    console.log('FOOTPRINT:', {
      requestedArea: a,
      computedWidth: w,
      computedHeight: h,
      actualArea: w * h,
      bedroomLanesMinW: minWForBedLanes,
    });
  }

  return { width_m: w, height_m: h };
}

function classify3BandType(room) {
  const s = String(room?.name || '').toLowerCase();
  if (s.includes('séjour') || s.includes('sejour') || s.includes('salon') || s.includes('living')) return 'living';
  if (s.includes('cuisine')) return 'kitchen';
  if (s.includes('chambre') || s.includes('bed')) return 'bedroom';
  if (s.includes('salle de bain') || s.includes('bain') || s.includes('bath')) return 'bathroom';
  if (/\bwc\b/.test(s) || s.includes('toilet')) return 'wc';
  if (s.includes('entrée') || s.includes('entree') || s.includes('hall')) return 'entry';
  if (s.includes('couloir') || s.includes('corridor') || s.includes('circulation')) return 'corridor';
  if (s.includes('cellier')) return 'service_storage';
  if (s.includes('rangement') || s.includes('storage') || s.includes('pantry')) return 'storage';
  if (s.includes('garage')) return 'garage';
  if (s.includes('buanderie') || s.includes('laundry')) return 'laundry';
  return 'other';
}

function infer3HorizontalBands(plan) {
  const rooms = Array.isArray(plan?.rooms) ? plan.rooms : [];
  const nightRooms = rooms.filter((r) => ['bedroom', 'bathroom'].includes(classify3BandType(r)));
  const transitionRooms = rooms.filter((r) => ['entry', 'wc', 'storage'].includes(classify3BandType(r)));
  const dayRooms = rooms.filter((r) => ['living', 'kitchen'].includes(classify3BandType(r)));

  const nightY2 = nightRooms.length ? Math.max(...nightRooms.map((r) => Number(r.y) + Number(r.h))) : 0;
  const transitionY2 = transitionRooms.length ? Math.max(...transitionRooms.map((r) => Number(r.y) + Number(r.h))) : nightY2;
  const dayY = dayRooms.length ? Math.min(...dayRooms.map((r) => Number(r.y))) : transitionY2;

  const yNight0 = 0;
  const yNight1 = roundToGrid(nightY2, 0.25);
  const yTransition0 = yNight1;
  const yTransition1 = roundToGrid(Number.isFinite(transitionY2) && transitionY2 > 0 ? transitionY2 : dayY, 0.25);
  const yDay0 = yTransition1;
  const yDay1 = Number(plan?.height_m);

  return {
    south_day: { y0: yDay0, y1: yDay1 },
    middle_transition: { y0: yTransition0, y1: yTransition1 },
    north_night: { y0: yNight0, y1: yNight1 },
  };
}

function validate3BandSolver(plan) {
  const errors = [];
  const W = Number(plan?.width_m);
  const H = Number(plan?.height_m);
  const rooms = Array.isArray(plan?.rooms) ? plan.rooms : [];
  const bands = infer3HorizontalBands(plan);
  const { north_night, middle_transition, south_day } = bands;
  const tol = 1e-6;

  const byType = new Map();
  for (const r of rooms) {
    const t = classify3BandType(r);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }

  const withinY = (r, y0, y1) => Number(r.y) >= y0 - tol && Number(r.y) + Number(r.h) <= y1 + tol;

  
  for (const r of rooms) {
    const t = classify3BandType(r);
    if (t === 'living' || t === 'kitchen') {
      if (!withinY(r, south_day.y0, south_day.y1)) errors.push(`DAY room outside SOUTH band: "${r.name}"`);
    } else if (t === 'entry' || t === 'wc' || t === 'storage' || t === 'corridor') {
      if (!withinY(r, middle_transition.y0, middle_transition.y1)) errors.push(`TRANSITION room outside MIDDLE band: "${r.name}"`);
    } else if (t === 'bedroom' || t === 'bathroom') {
      if (!withinY(r, north_night.y0, north_night.y1)) errors.push(`NIGHT room outside NORTH band: "${r.name}"`);
    } else if (t === 'garage' || t === 'laundry' || t === 'service_storage') {
      
      continue;
    }
  }

  
  const wcList = byType.get('wc') || [];
  const bedList = byType.get('bedroom') || [];
  const entry = (byType.get('entry') || [])[0];
  const living = (byType.get('living') || [])[0];
  const kitchen = (byType.get('kitchen') || [])[0];
  const corridors = byType.get('corridor') || [];

  if (!living || !kitchen) errors.push('Missing living or kitchen.');
  else if (!shareBoundary(living, kitchen)) errors.push('Kitchen does not touch Living (must share boundary).');

  for (const w of wcList) if (!withinY(w, middle_transition.y0, middle_transition.y1)) errors.push('WC not inside transition band.');
  for (const b of bedList) if (!withinY(b, north_night.y0, north_night.y1)) errors.push('Bedroom not inside night band.');

  if (entry && bedList.length) {
    for (const b of bedList) if (shareBoundary(entry, b)) errors.push('Entrance touches a bedroom (privacy violation).');
  }

  
  for (const c of corridors) {
    const w = Number(c?.w);
    const h = Number(c?.h);
    const len = Math.max(w, h);
    if (Number.isFinite(len) && len > 3 + 1e-6) errors.push(`Long corridor (>3m): "${c.name}" len=${len}m`);
    
    const minDim = Math.min(w, h);
    if (Number.isFinite(minDim) && minDim < 0.9 - 1e-6) errors.push(`Corridor too narrow (<0.9m): "${c.name}" minDim=${minDim}m`);
  }

  
  const totalArea = rooms.reduce((s, r) => s + areaRect(r), 0);
  const envelopeArea = W * H;
  if (Number.isFinite(envelopeArea)) {
    const unused = envelopeArea - totalArea;
    if (unused < -1e-3) errors.push('Invalid geometry: rooms exceed envelope area.');
    const unusedPct = envelopeArea > 0 ? unused / envelopeArea : 0;
    if (unusedPct > 0.15 + 1e-6) errors.push(`Dead space > 15%: unusedPct=${Math.round(unusedPct * 1000) / 10}%`);
  }

  return {
    ok: errors.length === 0,
    errors,
    bands,
    checklist: {
      wc_in_transition: wcList.length ? wcList.every((w) => withinY(w, middle_transition.y0, middle_transition.y1)) : true,
      bedrooms_only_in_night: bedList.length ? bedList.every((b) => withinY(b, north_night.y0, north_night.y1)) : true,
      kitchen_touches_living: Boolean(living && kitchen && shareBoundary(living, kitchen)),
      entrance_separated_from_bedrooms: Boolean(!entry || bedList.every((b) => !shareBoundary(entry, b))),
      corridor_short: corridors.length ? corridors.every((c) => Math.max(Number(c?.w), Number(c?.h)) <= 3 + 1e-6) : true,
      no_dead_space: Number.isFinite(envelopeArea) ? (envelopeArea - totalArea) / envelopeArea <= 0.15 + 1e-6 : true,
    },
  };
}

function validateHouseLivingHub(plan) {
  const errors = [];
  const W = Number(plan?.width_m);
  const H = Number(plan?.height_m);
  const rooms = Array.isArray(plan?.rooms) ? plan.rooms : [];
  const tol = 1e-6;

  const findBy = (pred) => rooms.filter((r) => pred(String(r?.name || '')));
  const byType = (t) => rooms.filter((r) => classify3BandType(r) === t);

  const livings = byType('living') || [];
  const living = livings[0];
  const kitchen = (byType('kitchen') || [])[0];
  const entry = findBy((n) => /\bentr[ée]e\b|\bentree\b/i.test(n))[0] || (byType('entry') || [])[0];
  const wc = (byType('wc') || [])[0];
  const bedrooms = byType('bedroom') || [];
  const corridors = byType('corridor') || [];
  const celliers = findBy((n) => /cellier/i.test(n));
  const hallsNamed = findBy((n) => /\bhall\b/i.test(n));

  
  if (corridors.length) errors.push('Corridor/Couloir detected (forbidden by living-hub rule).');
  if (hallsNamed.length) errors.push('Hall detected (forbidden by living-hub rule).');

  
  if (!entry || !living) errors.push('Missing entry or living.');
  else if (!shareBoundary(entry, living)) errors.push('Flow invalid: entry does not touch living (must be entry → living).');

  
  if (!living || bedrooms.length === 0) errors.push('Missing living or bedrooms.');
  else {
    for (const b of bedrooms) {
      const direct = livings.some((lr) => shareBoundary(b, lr));
      if (!direct) errors.push(`Bedroom not connected to living hub: "${b.name}" must touch living.`);
    }
  }

  
  if (!kitchen || !living) errors.push('Missing kitchen or living.');
  else if (!shareBoundary(kitchen, living)) errors.push('Kitchen must touch living (open plan).');
  else {
    const segs = Array.isArray(plan?.openingsSegments) ? plan.openingsSegments : [];
    const hasWideOpening = segs.some((s) => {
      const seg = s?.segment || s;
      if (!seg) return false;
      const x1 = Number(seg.x1);
      const y1 = Number(seg.y1);
      const x2 = Number(seg.x2);
      const y2 = Number(seg.y2);
      
      const vertical = Math.abs(x1 - x2) < 0.01 && Number.isFinite(y1) && Number.isFinite(y2);
      if (!vertical) return false;
      const x = x1;
      
      
      
      const sharedX =
        Math.abs(Number(kitchen.x) - x) < 0.02 ||
        Math.abs(Number(living.x) + Number(living.w) - x) < 0.02;
      if (!sharedX) return false;
      const len = Math.abs(y2 - y1);
      const target = Math.min(Number(kitchen.h), Number(living.h));
      return Number.isFinite(len) && Number.isFinite(target) && len >= target - 0.25;
    });
    if (!hasWideOpening) errors.push('Kitchen is not truly open: missing full opening between kitchen and living.');
  }

  
  if (wc) {
    if (!entry) errors.push('WC present but entry missing.');
    else if (!shareBoundary(wc, entry)) errors.push('WC must be near entry: WC must touch entry.');
    if (living && shareBoundary(wc, living)) errors.push('WC privacy violation: WC touches living (should be hidden).');
  }

  
  const envelopeArea = W * H;
  if (Number.isFinite(envelopeArea) && envelopeArea > 0 && celliers.length) {
    for (const c of celliers) {
      const a = areaRect(c);
      if (Number.isFinite(a) && a / envelopeArea > 0.15 + tol) errors.push(`Oversized service storage: "${c.name}" > 15% envelope.`);
    }
  }

  
  const totalArea = rooms.reduce((s, r) => s + areaRect(r), 0);
  if (Number.isFinite(envelopeArea)) {
    const unused = envelopeArea - totalArea;
    if (unused < -1e-3) errors.push('Invalid geometry: rooms exceed envelope area.');
    const unusedPct = envelopeArea > 0 ? unused / envelopeArea : 0;
    if (unusedPct > 0.15 + tol) errors.push(`Dead space > 15%: unusedPct=${Math.round(unusedPct * 1000) / 10}%`);
  }

  return {
    ok: errors.length === 0,
    errors,
    bands: null,
    checklist: {
      no_corridor: corridors.length === 0 && hallsNamed.length === 0,
      flow_entry_to_living: Boolean(entry && living && shareBoundary(entry, living)),
      bedrooms_touch_living: bedrooms.length ? bedrooms.every((b) => livings.some((lr) => shareBoundary(b, lr))) : true,
      kitchen_open: Boolean(kitchen && living && shareBoundary(kitchen, living)),
      wc_hidden: Boolean(!wc || (entry && shareBoundary(wc, entry) && living && !shareBoundary(wc, living))),
    },
  };
}

function validateIntentReasoningShape(llmIntentRaw) {
  const a4 = llmIntentRaw?.agent4_layout_synthesizer;
  if (!a4 || typeof a4 !== 'object') return 'missing agent4_layout_synthesizer';
  if (!a4.zones || typeof a4.zones !== 'object') return 'missing agent4 zones';
  if (!hasNonEmptyArray(a4.priority_rules)) return 'missing priority_rules';
  if (!hasNonEmptyArray(a4.main_flow)) return 'missing main_flow';
  if (!a4.block_layout || typeof a4.block_layout !== 'object') return 'missing block_layout';
  if (!a4.logic_checks || typeof a4.logic_checks !== 'object') return 'missing logic_checks';
  if (!hasNonEmptyArray(a4.room_placement_notes)) return 'missing room_placement_notes';
  return null;
}

function buildCanonicalConstraintsFromIntent(intent) {
  const c = intent?.constraints || {};
  const specials = intent?.specials || {};
  const roomCounts = intent?.roomCounts || {};

  return {
    
    living_facing: c.living_south ? 'south' : null,

    
    bedrooms_clustered: c.bedrooms_grouped !== false,
    bedrooms_private: c.bedrooms_private_zone !== false,

    
    kitchen_open_to_living: c.kitchen_near_living !== false,
    bathroom_near_bedrooms: c.bathroom_near_bedrooms !== false,

    
    wc_near: c.wc_near_entry ? 'entry' : null,
    wc_not_visible: c.wc_not_visible !== false,

    
    laundry_near: c.laundry_near_garage ? 'garage' : null,

    
    minimize_corridors: c.minimize_circulation === true,

    
    island: Boolean(specials?.wantsIsland || c.island),

    
    wants_garage: Number(roomCounts?.garage || 0) > 0,
    wants_laundry: Number(roomCounts?.laundry || 0) > 0,
  };
}

function applyCanonicalToEngineConstraints(intent, canonical) {
  
  const out = { ...(intent || {}) };
  out.canonicalConstraints = canonical;
  out.constraints = {
    ...(intent?.constraints || {}),
    living_south: canonical?.living_facing === 'south',
    kitchen_near_living: canonical?.kitchen_open_to_living !== false,
    bathroom_near_bedrooms: canonical?.bathroom_near_bedrooms !== false,
    wc_near_entry: canonical?.wc_near === 'entry',
    wc_not_visible: canonical?.wc_not_visible !== false,
    laundry_near_garage: canonical?.laundry_near === 'garage',
    minimize_circulation: canonical?.minimize_corridors === true,
  };
  return out;
}

function buildIntentFromExtractedConstraints(extracted, fallbackInterpreted) {
  const x = extracted && typeof extracted === 'object' ? extracted : {};
  const roomsArr = Array.isArray(x.rooms) ? x.rooms : [];
  const adjacency = Array.isArray(x.adjacency) ? x.adjacency : [];
  const layoutRules = Array.isArray(x.layout_rules) ? x.layout_rules : [];
  const orientation = x.orientation && typeof x.orientation === 'object' ? x.orientation : {};

  const countOf = (type, def = 0) => {
    const r = roomsArr.find((rr) => String(rr?.type || '').toLowerCase() === String(type).toLowerCase());
    const n = Math.round(Number(r?.count));
    return Number.isFinite(n) ? Math.max(0, Math.min(12, n)) : def;
  };

  const hasFeature = (type, feat) => {
    const r = roomsArr.find((rr) => String(rr?.type || '').toLowerCase() === String(type).toLowerCase());
    const fs = Array.isArray(r?.features) ? r.features.map((s) => String(s || '').toLowerCase()) : [];
    return fs.includes(String(feat).toLowerCase());
  };

  const ruleHas = (id) => layoutRules.map((s) => String(s || '').toLowerCase()).includes(String(id).toLowerCase());
  const adjacencyHas = (a, b, rel) =>
    adjacency.some(
      (e) =>
        String(e?.relation || '').toLowerCase() === String(rel).toLowerCase() &&
        ((String(e?.room_a || '').toLowerCase() === String(a).toLowerCase() &&
          String(e?.room_b || '').toLowerCase() === String(b).toLowerCase()) ||
          (String(e?.room_a || '').toLowerCase() === String(b).toLowerCase() &&
            String(e?.room_b || '').toLowerCase() === String(a).toLowerCase()))
    );

  
  
  const requestedBeds = Number(fallbackInterpreted?.bedroomCount);
  const bedsFromConstraints = countOf('bedroom', fallbackInterpreted?.bedroomCount ?? 3);
  const bedrooms = Number.isFinite(requestedBeds) && requestedBeds > 0 ? requestedBeds : Math.max(1, bedsFromConstraints);
  const bathrooms = Math.max(0, countOf('bathroom', 1));
  const wc = Math.max(1, countOf('wc', 1));
  const kitchen = Math.max(1, countOf('kitchen', 1));
  const living = Math.max(1, countOf('living_room', 1));
  const garage = Math.max(0, countOf('garage', 0));
  const laundry = Math.max(0, countOf('laundry', 0));
  const storage = Math.max(0, countOf('storage', 0));
  const entry = Math.max(1, countOf('entry', 1));

  const wantsIsland = hasFeature('kitchen', 'island');
  const wantsOpenKitchen = hasFeature('kitchen', 'open') || ruleHas('open_plan');

  const livingFacing = String(orientation?.living_room || '').toLowerCase() || null;
  const livingSouth = livingFacing === 'south';

  const wcNearEntry =
    adjacencyHas('wc', 'entry', 'near') ||
    adjacencyHas('wc', 'entry', 'connected') ||
    /\bwc\b/i.test(String(fallbackInterpreted?.rawText || ''));

  const laundryNearGarage =
    adjacencyHas('laundry', 'garage', 'near') || adjacencyHas('laundry', 'garage', 'connected') || false;

  
  const garage2 = laundryNearGarage ? Math.max(garage, 1) : garage;
  const laundry2 = laundryNearGarage ? Math.max(laundry, 1) : laundry;

  const inferredBuilding =
    String(x?.meta?.inferred_building || '').toLowerCase() ||
    (/\b(apartment|appartement|flat|studio)\b/i.test(String(fallbackInterpreted?.rawText || '')) ? 'apartment' : '') ||
    '';

  const extractedArea = Number(x.total_area);
  const intentLike = {
    type: inferredBuilding === 'apartment' ? 'apartment' : fallbackInterpreted?.intent?.type || fallbackInterpreted?.type || 'house',
    floors: fallbackInterpreted?.intent?.floors ?? 1,
    dimensions: fallbackInterpreted?.dimensions || fallbackInterpreted?.intent?.dimensions || null,
    area_m2:
      Number.isFinite(Number(fallbackInterpreted?.intent?.area_m2)) && Number(fallbackInterpreted.intent.area_m2) > 0
        ? Number(fallbackInterpreted.intent.area_m2)
        : Number.isFinite(extractedArea) && extractedArea > 0
          ? extractedArea
          : null,
    roomCounts: {
      bedrooms,
      bathrooms: Math.max(1, Math.min(6, bathrooms || 1)),
      wc: Math.max(1, Math.min(6, wc)),
      kitchen: Math.max(1, Math.min(3, kitchen)),
      living: 1,
      dining: 0,
      office: 0,
      garage: Math.max(0, Math.min(2, garage2)),
      laundry: Math.max(0, Math.min(2, laundry2)),
      storage: Math.max(0, Math.min(3, storage)),
      entry,
    },
    specials: { masterSuite: false, wantsIsland, wantsOpenKitchen },
    zones: fallbackInterpreted?.intent?.zones || { day: ['living', 'kitchen'], night: ['bedrooms'], service: ['bathroom', 'wc'] },
    constraints: {
      living_south: livingSouth,
      kitchen_near_living: true,
      bathroom_near_bedrooms: true,
      wc_near_entry: wcNearEntry,
      wc_not_visible: true,
      laundry_near_garage: laundryNearGarage,
      minimize_circulation: ruleHas('avoid_long_corridors'),
      bedrooms_grouped: ruleHas('cluster_bedrooms'),
      bedrooms_private_zone: true,
    },
    raw: { extracted_constraints: x },
  };

  const canonical = {
    living_facing: livingSouth ? 'south' : null,
    bedrooms_clustered: ruleHas('cluster_bedrooms'),
    bedrooms_private: true,
    kitchen_open_to_living: true,
    bathroom_near_bedrooms: true,
    wc_near: wcNearEntry ? 'entry' : null,
    wc_not_visible: true,
    laundry_near: laundryNearGarage ? 'garage' : null,
    minimize_corridors: ruleHas('avoid_long_corridors'),
    island: wantsIsland,
    wants_garage: garage2 > 0,
    wants_laundry: laundry2 > 0,
  };

  return applyCanonicalToEngineConstraints(intentLike, canonical);
}

async function generateIntentWithLLM({ client, model, input }) {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: buildIntentSystemPrompt() },
      { role: 'user', content: String(input || '').trim() },
    ],
    response_format: { type: 'json_object' },
  });
  const content = completion?.choices?.[0]?.message?.content;
  if (!content) throw new AppError('Réponse vide du fournisseur LLM (intent).', 502);
  try {
    const parsed = JSON.parse(extractJsonPayload(content));
    const shapeErr = validateIntentReasoningShape(parsed);
    if (shapeErr) throw new AppError(`Intent invalide (raisonnement manquant): ${shapeErr}`, 502);
    return parsed;
  } catch {
    throw new AppError('JSON intent invalide reçu du fournisseur.', 502);
  }
}

function normalizeIntent(intent, fallbackInterpreted) {
  const t = intent && typeof intent === 'object' ? intent : {};

  
  const entities =
    t?.agent1_nlp_parser && typeof t.agent1_nlp_parser === 'object'
      ? t.agent1_nlp_parser?.entities
      : null;
  const relationships =
    t?.agent1_nlp_parser && typeof t.agent1_nlp_parser === 'object' && Array.isArray(t.agent1_nlp_parser.relationships)
      ? t.agent1_nlp_parser.relationships
      : Array.isArray(t.relationships)
        ? t.relationships
        : [];

  const building_type = entities?.building_type || t.type;
  const dims =
    (entities?.dimensions && typeof entities.dimensions === 'object' ? entities.dimensions : null) ||
    (t.dimensions && typeof t.dimensions === 'object' ? t.dimensions : null);

  const width_m = Number(dims?.width_m);
  const height_m = Number(dims?.height_m);
  const dimensions =
    Number.isFinite(width_m) && Number.isFinite(height_m)
      ? { width_m, height_m }
      : fallbackInterpreted?.dimensions || null;

  const roomsObj =
    (entities?.rooms && typeof entities.rooms === 'object' ? entities.rooms : null) ||
    (t.roomCounts && typeof t.roomCounts === 'object' ? t.roomCounts : {});

  const asInt = (v, d) => {
    const n = Number.isFinite(Number(v)) ? Math.round(Number(v)) : d;
    return Math.max(0, Math.min(12, n));
  };
  const bedrooms = asInt(roomsObj.bedrooms, fallbackInterpreted?.bedroomCount ?? 3);

  const roomCounts = {
    bedrooms,
    bathrooms: Math.max(0, Math.min(6, asInt(roomsObj.bathrooms, 1))),
    wc: Math.max(0, Math.min(6, asInt(roomsObj.wc, 1))),
    kitchen: Math.max(0, Math.min(3, asInt(roomsObj.kitchen, 1))),
    living: Math.max(0, Math.min(3, asInt(roomsObj.living, 1))),
    dining: Math.max(0, Math.min(3, asInt(roomsObj.dining, 0))),
    office: Math.max(0, Math.min(2, asInt(roomsObj.office, 0))),
    garage: Math.max(0, Math.min(2, asInt(roomsObj.garage, 0))),
    laundry: Math.max(0, Math.min(2, asInt(roomsObj.laundry, 0))),
    storage: Math.max(0, Math.min(3, asInt(roomsObj.storage, 0))),
    entry: Math.max(0, Math.min(2, asInt(roomsObj.entry, 1))),
  };

  
  
  const rawText = String(fallbackInterpreted?.rawText || '');
  const wcNearEntryFromText = /\bwc\b[\s\S]{0,30}\b(near|près|proche)\b[\s\S]{0,30}\b(entr[eé]e|entry)\b/i.test(rawText);
  const laundryNearGarageFromText = /\b(laundry|buanderie)\b[\s\S]{0,30}\b(near|près|proche)\b[\s\S]{0,30}\bgarage\b/i.test(rawText);
  const mentionsGarage = /\bgarage\b/i.test(rawText);

  
  if (wcNearEntryFromText) {
    roomCounts.wc = Math.max(roomCounts.wc, 1);
    roomCounts.entry = Math.max(roomCounts.entry, 1);
  }
  if (laundryNearGarageFromText) {
    roomCounts.laundry = Math.max(roomCounts.laundry, 1);
    roomCounts.garage = Math.max(roomCounts.garage, 1);
  }
  if (mentionsGarage) roomCounts.garage = Math.max(roomCounts.garage, 1);

  const prefs =
    t?.agent1_nlp_parser && typeof t.agent1_nlp_parser === 'object'
      ? t.agent1_nlp_parser?.preferences
      : null;
  const specials = t.specials && typeof t.specials === 'object' ? t.specials : {};

  const zones =
    (t?.agent2_program_normalizer?.zones && typeof t.agent2_program_normalizer.zones === 'object'
      ? t.agent2_program_normalizer.zones
      : null) || (t.zones && typeof t.zones === 'object' ? t.zones : {});

  
  const constraintList = Array.isArray(t?.agent2_program_normalizer?.constraints) ? t.agent2_program_normalizer.constraints : null;
  const listHas = (id) => (constraintList ? constraintList.some((c) => String(c?.id || '').toLowerCase() === id) : false);

  const constraints = t.constraints && typeof t.constraints === 'object' ? t.constraints : {};

  
  const relHasPosition = (room, pos) =>
    relationships.some(
      (r) =>
        String(r?.type || '').toLowerCase() === 'position' &&
        String(r?.from || '').toLowerCase().includes(String(room).toLowerCase()) &&
        String(r?.value || '').toLowerCase().includes(String(pos).toLowerCase())
    );

  const graph =
    (t?.agent3_spatial_graph && typeof t.agent3_spatial_graph === 'object' ? t.agent3_spatial_graph : null) ||
    (t.graph && typeof t.graph === 'object' ? t.graph : {});

  return {
    type: building_type === 'house' || building_type === 'apartment' ? building_type : fallbackInterpreted?.intent?.type || 'unknown',
    floors: Number.isFinite(Number(entities?.floors)) ? Math.max(1, Math.round(Number(entities?.floors))) : Number.isFinite(Number(t.floors)) ? Math.max(1, Math.round(Number(t.floors))) : null,
    dimensions,
    roomCounts,
    specials: {
      masterSuite: Boolean(specials.masterSuite || roomsObj.dressing > 0),
      wantsIsland: Boolean(specials.wantsIsland || prefs?.wants_island),
      wantsOpenKitchen: (specials.wantsOpenKitchen !== false) && !(prefs?.open_kitchen === false),
    },
    zones: {
      day: Array.isArray(zones.day) ? zones.day.slice(0, 10) : fallbackInterpreted?.intent?.zones?.day || [],
      night: Array.isArray(zones.night) ? zones.night.slice(0, 10) : fallbackInterpreted?.intent?.zones?.night || [],
      service: Array.isArray(zones.service) ? zones.service.slice(0, 10) : fallbackInterpreted?.intent?.zones?.service || [],
    },
    constraints: {
      entry_north: Boolean(constraints.entry_north || listHas('entry_north')),
      bedrooms_south: Boolean(constraints.bedrooms_south || listHas('bedrooms_south')),
      kitchen_east: Boolean(constraints.kitchen_east || listHas('kitchen_east')),
      living_center: Boolean(constraints.living_center || listHas('living_center')),
      living_south: Boolean(
        relHasPosition('living', 'south') ||
          relHasPosition('séjour', 'sud') ||
          constraints.living_south ||
          listHas('living_south') ||
          /\b(s[ée]jour|sejour|salon|living)\b[\s\S]{0,50}\b(facing\s+south|south|plein\s+sud|façade\s+sud|côté\s+sud|au\s+sud)\b/i.test(
            fallbackInterpreted?.rawText || ''
          )
      ),
      wc_near_entry: Boolean(listHas('wc_near_entry')) || /\bwc\b[\s\S]{0,30}\b(near|près|proche)\b[\s\S]{0,30}\b(entr[eé]e|entry)\b/i.test(fallbackInterpreted?.rawText || ''),
      wc_not_visible: true, 
      laundry_near_garage: Boolean(listHas('laundry_near_garage')) || /\b(laundry|buanderie)\b[\s\S]{0,30}\b(near|près|proche)\b[\s\S]{0,30}\bgarage\b/i.test(fallbackInterpreted?.rawText || ''),
      kitchen_near_living: constraints.kitchen_near_living !== false,
      bathroom_near_bedrooms: constraints.bathroom_near_bedrooms !== false,
      garage_connected_to_entry: Boolean(constraints.garage_connected_to_entry || listHas('garage_connected_to_entry')),
      minimize_circulation: Boolean(constraints.minimize_circulation || prefs?.minimize_circulation || listHas('minimize_circulation')),
      master_suite: Boolean(constraints.master_suite || specials.masterSuite || roomsObj.dressing > 0),
    },
    graph: {
      nodes: Array.isArray(graph.nodes) ? graph.nodes.slice(0, 30) : [],
      edges: Array.isArray(graph.edges) ? graph.edges.slice(0, 80) : [],
    },
    raw: t, 
  };
}

function buildUserMessage(input) {
  const sanitized = String(input || '').trim();
  return `${sanitized}\n\nGénère un plan 2D cohérent (top-down) à partir de ce brief.`
}

function buildSystemPrompt() {
  return (
    'Tu es un architecte d\'intérieur et un dessinateur de plan 2D.\n' +
    'Objectif: transformer le texte utilisateur en un PLAN 2D structuré.\n' +
    'Si le brief entre en conflit avec les contraintes architecturales fournies dans le message utilisateur, respecte les contraintes (constructibilité, circulation, dimensions minimales).\n\n' +
    'Règles essentielles:\n' +
    '- Comprendre l\'INTENTION (pas juste des mots-clés): type (maison/appartement), dimensions, étages, pièces, relations spatiales (nord/sud/est/ouest/centre), zones (jour/nuit/service), adjacences.\n' +
    '- Normaliser les demandes vagues: interpréter "centre" comme zone centrale; si conflit, corriger avec une logique architecturale (circulation courte, zones séparées, pièces techniques compactes).\n' +
    '- Sortie STRICTEMENT UN JSON valide (pas de Markdown, pas de texte hors JSON).\n' +
    '- Coordonnées en mètres.\n' +
    '- Système: origine (0,0) en haut-gauche; x vers la droite; y vers le bas.\n' +
    '- Les pièces sont des rectangles axis-aligned.\n' +
    '- Les rectangles ne doivent pas se chevaucher (touchers autorisés).\n' +
    '- Chaque rectangle doit être entièrement dans la bounding box.\n' +
    '- width_m et height_m doivent correspondre à l\'emprise réelle des pièces: sans bande vide sur le pourtour, donc width_m = max(x+w) et height_m = max(y+h) sur toutes les pièces (à 0.25 m près).\n' +
    '- Utilise une grille de 0.25m: x,y,w,h doivent être multiples de 0.25.\n' +
    '- Génère 4 à 10 pièces max, avec les noms en français.\n' +
    '- Fournis une couleur HEX par pièce (ex: #ff7a18). Utilise des couleurs distinctes.\n\n' +
    'Schéma JSON attendu:\n' +
    '{\n' +
    '  "width_m": number,\n' +
    '  "height_m": number,\n' +
    '  "units": "m",\n' +
    '  "rooms": [\n' +
    '    { "name": string, "x": number, "y": number, "w": number, "h": number, "color": "#RRGGBB" }\n' +
    '  ]\n' +
    '}\n'
  );
}

function createGroqClient() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: Number(process.env.LLM_TIMEOUT_MS) || 90_000,
    maxRetries: 2,
  });
}

function createOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    timeout: Number(process.env.LLM_TIMEOUT_MS) || 90_000,
    maxRetries: 2,
  });
}

function getRetryAfterSeconds(err) {
  const h =
    err?.headers?.['retry-after'] ?? err?.headers?.get?.('retry-after') ?? err?.response?.headers?.['retry-after'];
  if (h == null) return 0;
  const n = parseInt(String(h), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 60) : 0;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function generateLocalFallbackPlan(input) {
  const step = 0.25;
  const t = String(input || '').toLowerCase();

  
  const dimMatch = /(\d+(?:[.,]\d+)?)\s*(?:x|×)\s*(\d+(?:[.,]\d+)?)\s*m?\b/i.exec(String(input || ''));
  const parseNum = (s) => {
    const n = Number(String(s || '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  };
  let width_m = dimMatch ? parseNum(dimMatch[1]) : NaN;
  let height_m = dimMatch ? parseNum(dimMatch[2]) : NaN;

  const isStudio = /\bstudio\b|appartement\s+studio/.test(t);
  const isMaison = /\bmaison\b/.test(t);

  if (!Number.isFinite(width_m) || !Number.isFinite(height_m)) {
    width_m = isStudio ? 8 : isMaison ? 12 : 10.5;
    height_m = isStudio ? 7 : isMaison ? 9 : 8;
  }

  
  width_m = Math.min(40, Math.max(6, roundToGrid(width_m, step)));
  height_m = Math.min(40, Math.max(5, roundToGrid(height_m, step)));

  const pickInt = (re, def = 0) => {
    const m = re.exec(t);
    if (!m) return def;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : def;
  };

  
  
  
  const bedroomNums = Array.from(t.matchAll(/\b(\d{1,2})\s*(?:chambres?|bedrooms?)\b/gi))
    .map((m) => parseInt(m[1], 10))
    .filter((n) => Number.isFinite(n));
  const bedroomsFromText = bedroomNums.length ? Math.max(...bedroomNums) : 0;
  const bedrooms =
    Math.max(
      bedroomsFromText,
      /t2\b/.test(t) ? 1 : 0,
      /t3\b/.test(t) ? 2 : 0,
      /t4\b/.test(t) ? 3 : 0
    ) || (isStudio ? 0 : 1);

  const bathrooms = pickInt(/\b(\d{1,2})\s*(?:sdb|salles?\s+de\s+bain|bathrooms?)\b/i, 1);
  const hasKitchen = /\bcuisine\b|kitchen/.test(t) || true;
  const hasDining = /\bsalle\s+a\s+manger\b|dining/.test(t);
  const hasOffice = /\bbureau\b|office|workspace/.test(t);
  const hasWc = /\bwc\b|toilet/.test(t);
  const hasEntry = /\bentr(?:e|ée)e\b|hall|couloir/.test(t) || true;
  const hasStorage = /\brangement\b|cellier|buanderie|laundry|storage/.test(t);

  
  
  const hasDirectionWords = /\b(nord|sud|est|ouest|centre|center)\b/.test(t);
  const wantsCenteredLiving = /\bs[ée]jour\b.*\b(au|a|à)\s+centre\b|\bliving\b.*\b(center|centre)\b/.test(t);
  const wantsKitchenEast = /\bcuisine\b.*\b(à|a|au)\s+l['’]?est\b|\bkitchen\b.*\beast\b/.test(t);
  const wantsEntryNorth = /\bentr(?:e|ée)e\b.*\b(au|a|à)\s+nord\b|\bentry\b.*\bnorth\b/.test(t);
  const wantsBedroomsSouth = /\bchambres?\b.*\b(au|a|à)\s+sud\b|\bbedrooms?\b.*\bsouth\b/.test(t);

  const shouldUseConstrainedLayout =
    hasDirectionWords && (wantsCenteredLiving || wantsKitchenEast || wantsEntryNorth || wantsBedroomsSouth);

  if (shouldUseConstrainedLayout) {
    
    
    
    
    
    const W = width_m;
    const H = height_m;

    const clampGrid = (v, min, max) => roundToGrid(Math.min(max, Math.max(min, v)), step);

    const northBand = clampGrid(H * 0.22, 1.25, 2.25);
    const southBand = clampGrid(H * 0.28, 2.0, 3.0);
    const eastBand = clampGrid(W * 0.30, 2.5, 3.5);
    
    

    
    const entryW = clampGrid(Math.min(3.0, W - eastBand - 1.0), 2.25, 3.25);
    const entryH = clampGrid(northBand, 1.25, 2.25);

    
    const kitchenH = clampGrid(northBand, 1.25, 2.25);
    const kitchenW = clampGrid(eastBand, 2.5, 3.5);

    
    const bedCount = Math.min(3, Math.max(1, bedrooms));
    const bedGap = clampGrid(0.35, 0.25, 0.6);
    const bedAreaW = clampGrid(W - eastBand, 4.5, W);
    const bedW = clampGrid((bedAreaW - bedGap * (bedCount + 1)) / bedCount, 2.5, 4.75);
    const bedH = clampGrid(southBand, 2.25, 3.0);

    
    const wetW = clampGrid(eastBand, 2.5, 3.5);
    const wcH = clampGrid(1.25, 1.0, 1.75);
    const bathH = clampGrid(1.75, 1.5, 2.25);
    const wetStackH = wcH + bathH;
    
    const wetY = clampGrid(
      northBand + clampGrid((H - northBand - southBand - wetStackH) * 0.55, 0.5, 10),
      northBand + 0.25,
      H - southBand - wetStackH - 0.25
    );

    
    const usableX0 = entryW;
    const usableX1 = W - eastBand;
    const usableY0 = northBand;
    const usableY1 = H - southBand;
    const usableW = Math.max(step, usableX1 - usableX0);
    const usableH = Math.max(step, usableY1 - usableY0);

    const livingW = clampGrid(Math.min(usableW, clampGrid(W * 0.42, 3.75, 5.25)), 3.5, usableW);
    const livingH = clampGrid(Math.min(usableH, clampGrid(H * 0.38, 2.75, 3.75)), 2.5, usableH);

    const livingX = clampGrid(usableX0 + (usableW - livingW) / 2, usableX0, usableX1 - livingW);
    const livingY = clampGrid(usableY0 + (usableH - livingH) / 2, usableY0, usableY1 - livingH);

    const rooms = [];

    if (hasEntry) rooms.push({ name: 'Entrée', x: 0, y: 0, w: entryW, h: entryH, color: '#94a3b8' });
    if (hasStorage) rooms.push({ name: 'Rangement', x: 0, y: entryH, w: entryW, h: clampGrid(northBand - entryH, 0.75, northBand - 0.25), color: '#94a3b8' });

    if (hasKitchen)
      rooms.push({ name: hasDining ? 'Cuisine' : 'Cuisine', x: W - kitchenW, y: 0, w: kitchenW, h: kitchenH, color: '#34d399' });
    if (hasDining)
      rooms.push({
        name: 'Salle à manger',
        x: W - kitchenW,
        y: kitchenH,
        w: kitchenW,
        h: clampGrid(Math.max(0.75, northBand - kitchenH), 0.75, 1.5),
        color: '#22c55e',
      });

    rooms.push({ name: 'Séjour', x: livingX, y: livingY, w: livingW, h: livingH, color: '#60a5fa' });

    
    rooms.push({ name: 'Salle de bain', x: W - wetW, y: wetY, w: wetW, h: bathH, color: '#a78bfa' });
    if (hasWc) rooms.push({ name: 'WC', x: W - wetW, y: wetY + bathH, w: wetW, h: wcH, color: '#f97316' });

    
    for (let i = 0; i < bedCount; i++) {
      const bx = clampGrid(bedGap + i * (bedW + bedGap), 0, W - eastBand - bedW);
      rooms.push({ name: `Chambre ${i + 1}`, x: bx, y: H - bedH, w: bedW, h: bedH, color: '#f59e0b' });
    }

    
    const draft = { width_m, height_m, rooms };
    const ok = validateAndNormalizePlan2D(draft);
    if (ok.ok) return ok.data;
    console.warn('[plan2d] constrained layout invalid -> fallback. errors=', ok.errors);
  }

  
  const wants = [];
  wants.push({ name: 'Séjour', weight: 30, color: '#60a5fa' });
  if (hasKitchen) wants.push({ name: hasDining ? 'Cuisine' : 'Cuisine / Salle à manger', weight: hasDining ? 16 : 20, color: '#34d399' });
  if (hasDining) wants.push({ name: 'Salle à manger', weight: 12, color: '#22c55e' });
  for (let i = 0; i < Math.min(5, bedrooms); i++) wants.push({ name: `Chambre ${i + 1}`, weight: 16, color: '#f59e0b' });
  for (let i = 0; i < Math.min(3, bathrooms); i++) wants.push({ name: i === 0 ? 'Salle de bain' : `Salle de bain ${i + 1}`, weight: 9, color: '#a78bfa' });
  if (hasOffice) wants.push({ name: 'Bureau', weight: 10, color: '#10b981' });
  if (hasEntry) wants.push({ name: 'Entrée / Couloir', weight: 8, color: '#fb7185' });
  if (hasWc) wants.push({ name: 'WC', weight: 4, color: '#f97316' });
  if (hasStorage) wants.push({ name: 'Rangement', weight: 6, color: '#94a3b8' });

  
  const pruned = wants.slice(0, 10);
  while (pruned.length < 4) pruned.push({ name: `Pièce ${pruned.length + 1}`, weight: 10, color: '#94a3b8' });

  
  
  const area = width_m * height_m;
  const totalWeight = pruned.reduce((a, r) => a + (Number(r.weight) || 1), 0) || 1;

  
  const rooms = [];
  let x = 0;
  let y = 0;
  let remainingW = width_m;
  let remainingH = height_m;

  for (let i = 0; i < pruned.length; i++) {
    const isLast = i === pruned.length - 1;
    const fraction = (pruned[i].weight || 1) / totalWeight;
    const targetArea = Math.max(step * step, area * fraction);

    
    const splitVertical = remainingW >= remainingH;
    let w;
    let h;
    if (isLast) {
      w = remainingW;
      h = remainingH;
    } else if (splitVertical) {
      w = Math.max(step, roundToGrid(Math.min(remainingW, targetArea / Math.max(remainingH, step)), step));
      h = remainingH;
    } else {
      w = remainingW;
      h = Math.max(step, roundToGrid(Math.min(remainingH, targetArea / Math.max(remainingW, step)), step));
    }

    
    w = Math.min(remainingW, Math.max(step, w));
    h = Math.min(remainingH, Math.max(step, h));

    rooms.push({
      name: pruned[i].name,
      x: roundToGrid(x, step),
      y: roundToGrid(y, step),
      w: roundToGrid(w, step),
      h: roundToGrid(h, step),
      color: pruned[i].color,
    });

    
    if (isLast) break;
    if (splitVertical) {
      x = x + w;
      remainingW = roundToGrid(width_m - x, step);
    } else {
      y = y + h;
      remainingH = roundToGrid(height_m - y, step);
    }

    
    if (remainingW < step || remainingH < step) {
      const last = rooms[rooms.length - 1];
      last.w = roundToGrid(Math.max(step, width_m - last.x), step);
      last.h = roundToGrid(Math.max(step, height_m - last.y), step);
      break;
    }
  }

  
  const draft = { width_m, height_m, rooms };
  const validated = validateAndNormalizePlan2D(draft);
  if (validated.ok) return validated.data;

  const grid = [];
  const cols = 2;
  const rows = 2;
  const cellW = roundToGrid(width_m / cols, step);
  const cellH = roundToGrid(height_m / rows, step);
  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (k >= pruned.length) break;
      const gx = roundToGrid(c * cellW, step);
      const gy = roundToGrid(r * cellH, step);
      const gw = roundToGrid(c === cols - 1 ? width_m - gx : cellW, step);
      const gh = roundToGrid(r === rows - 1 ? height_m - gy : cellH, step);
      grid.push({ name: pruned[k].name, x: gx, y: gy, w: gw, h: gh, color: pruned[k].color });
      k++;
    }
  }
  while (grid.length < 4) {
    grid.push({ name: `Pièce ${grid.length + 1}`, x: 0, y: 0, w: cellW, h: cellH, color: '#94a3b8' });
  }
  const gridDraft = { width_m, height_m, rooms: grid.slice(0, 10) };
  const gridOk = validateAndNormalizePlan2D(gridDraft);
  if (gridOk.ok) return gridOk.data;
  return gridDraft;
}

async function generatePlanWithLLM({
  client,
  model,
  input,
  attemptFix = false,
  previousErrors = [],
  constraintFooter = '',
}) {
  const system = buildSystemPrompt();
  const fixNote =
    attemptFix && previousErrors.length
      ? `\n\nIMPORTANT: Votre dernière sortie était invalide. Erreurs relevées:\n- ${previousErrors.slice(0, 8).join('\n- ')}\n` +
        'Corrige la sortie et respecte strictement toutes les règles (pas de chevauchement, rectangles dans la bounding box, grille 0.25m).'
      : '';

  const user = `${buildUserMessage(input)}${constraintFooter}${fixNote}\n\nRetourne uniquement le JSON.`;

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.45,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  });

  const content = completion?.choices?.[0]?.message?.content;
  if (!content) throw new AppError('Réponse vide du fournisseur LLM.', 502);

  let parsed;
  try {
    parsed = JSON.parse(extractJsonPayload(content));
  } catch {
    throw new AppError('JSON invalide reçu du fournisseur.', 502);
  }

  return parsed;
}

export const createTextTo2dPlan = asyncHandler(async (req, res) => {
  const raw = typeof req.body?.input === 'string' ? req.body.input : '';
  const input = String(raw || '').trim();
  const norms = String(req.body?.norms || 'fr').trim().toLowerCase() === 'int' ? 'int' : 'fr';
  if (!input) {
    throw new AppError('Champ "input" manquant ou vide.', 400);
  }
  if (input.length > MAX_INPUT_LENGTH) {
    throw new AppError(`Texte trop long (max ${MAX_INPUT_LENGTH} caractères).`, 400);
  }

  
  const interpreted = interpretPrompt(input);
  const { brief, overrides, warnings } = applyConstraints(interpreted);
  const constraintFooter = buildLLMConstraintFooter(brief);

  const modelName = String(process.env.LLM_MODEL || process.env.GROQ_MODEL || 'llama-3.1-70b-versatile').trim();
  const rendererVersion = 'v97-apartment-envelope-minh-wetcore-wc-entry';
  const cacheKey = `text2d:${rendererVersion}:${modelName}:${norms}:${input}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.status(200).json({ success: true, data: cached, meta: { cached: true } });

  const pipelineMeta = {
    interpreted: summarizeInterpreted(interpreted),
    brief,
    constraintOverrides: overrides,
    constraintWarnings: warnings,
  };

  
  

  const attempts = 3;
  const groqClient = createGroqClient();
  const openaiClient = groqClient ? null : createOpenAIClient();

  const client = groqClient || openaiClient;
  if (!client) {
    
    const intent2raw = interpreted?.intent || null;
    const intent2 = intent2raw ? applyCanonicalToEngineConstraints(intent2raw, buildCanonicalConstraintsFromIntent(intent2raw)) : null;
    const planCandidate = intent2 ? generatePlanFromIntent(intent2, brief) : null;
    const ok = planCandidate ? validateAndNormalizePlan2D(planCandidate) : { ok: false, errors: ['no_plan'] };
    if (!ok.ok) throw new AppError(`Impossible de générer un plan déterministe. ${ok.errors?.[0] || ''}`, 422);
    const { svg } = renderPlanSvgs(ok.data, norms);
    const data = { svg, plan: ok.data };
    cacheSet(cacheKey, data);
    return res.status(200).json({ success: true, data, meta: { mode: 'deterministic_no_llm', pipeline: pipelineMeta, rendererVersion } });
  }

  
  
  
  try {
    const extracted = await extractConstraints({ client, model: modelName, prompt: input });
    pipelineMeta.constraintExtraction = { ok: true, source: 'llm', data: extracted };
  } catch (e) {
    
    try {
      const fallback = extractConstraintsHeuristic(input);
      pipelineMeta.constraintExtraction = { ok: true, source: 'heuristic', data: fallback, llmError: String(e?.message || e).slice(0, 160) };
    } catch (e2) {
      pipelineMeta.constraintExtraction = { ok: false, error: String(e?.message || e).slice(0, 240) };
    }
  }

  try {
    
    
    if (pipelineMeta?.constraintExtraction?.ok && pipelineMeta?.constraintExtraction?.data) {
      const intentC = buildIntentFromExtractedConstraints(pipelineMeta.constraintExtraction.data, interpreted);
      const interpretedFromC = {
        ...interpreted,
        intent: {
          ...interpreted.intent,
          ...intentC,
          area_m2: intentC.area_m2 ?? interpreted.intent?.area_m2 ?? null,
          dimensions: intentC.dimensions ?? interpreted.intent?.dimensions ?? interpreted.dimensions,
        },
        dimensions: intentC.dimensions ?? interpreted.dimensions,
        bedroomCount: intentC.roomCounts?.bedrooms ?? interpreted.bedroomCount,
        livingSouth: Boolean(intentC.constraints?.living_south),
        wantsIsland: Boolean(intentC.specials?.wantsIsland),
        wantsOpenKitchen: intentC.specials?.wantsOpenKitchen !== false,
      };
      const { brief: briefC, overrides: overridesC, warnings: warningsC } = applyConstraints(interpretedFromC);

      const lockedEnvelope = briefC?.envelopeAdjustable === false;
      const maxTries = lockedEnvelope ? 3 : 18;
      let lastReason = null;

      for (let k = 0; k < maxTries; k++) {
        const grow = lockedEnvelope ? Math.min(k, 2) * 0.25 : k;
        const targetArea = Number(interpretedFromC?.intent?.area_m2);
        const fromArea = !lockedEnvelope ? pickEnvelopeFromArea(targetArea, k, intentC) : null;
        const briefK = lockedEnvelope
          ? {
              ...briefC,
              width_m: Math.min(40, briefC.width_m + grow),
              height_m: Math.min(40, briefC.height_m + grow),
            }
          : fromArea
            ? { ...briefC, ...fromArea }
            : {
                ...briefC,
                width_m: Math.min(40, briefC.width_m + grow * 0.5),
                height_m: Math.min(40, briefC.height_m + (grow >= 6 ? 0.5 : 0) + Math.floor(grow / 10) * 0.25),
              };

        let planIntent;
        let geoMeta = null;
        const geoUrl = String(process.env.GEOMETRY_SERVICE_URL || '').trim();
        const preferLocal = String(process.env.PLAN2D_PREFER_LOCAL_SOLVER || 'true').trim().toLowerCase() === 'true';
        if (geoUrl && !preferLocal) {
          const payload = {
            intent: {
              building_type: intentC.type || 'unknown',
              envelope: { width_m: briefK.width_m, height_m: briefK.height_m },
              program: {
                bedrooms: intentC.roomCounts?.bedrooms ?? briefK.bedroomCount,
                bathrooms: intentC.roomCounts?.bathrooms ?? 1,
                wc: intentC.roomCounts?.wc ?? 1,
                kitchen: intentC.roomCounts?.kitchen ?? 1,
                living: 1,
                dining: 0,
                office: 0,
                garage: intentC.roomCounts?.garage ?? 0,
                laundry: intentC.roomCounts?.laundry ?? 0,
                storage: intentC.roomCounts?.storage ?? 0,
                entry: 1,
              },
              constraints: {
                living_south: intentC?.canonicalConstraints?.living_facing === 'south',
                kitchen_connected_to_living: intentC?.canonicalConstraints?.kitchen_open_to_living !== false,
                bathroom_near_bedrooms: intentC?.canonicalConstraints?.bathroom_near_bedrooms !== false,
                wc_near_entrance: intentC?.canonicalConstraints?.wc_near === 'entry',
                wc_not_visible: intentC?.canonicalConstraints?.wc_not_visible !== false,
                laundry_near_garage: intentC?.canonicalConstraints?.laundry_near === 'garage',
              },
              raw: intentC.raw || null,
            },
            strict: true,
            max_iterations: 120,
          };
          const geoOut = await geometryLayout({ url: geoUrl, payload });
          geoMeta = geoOut?.meta || null;
          planIntent = {
            width_m: geoOut?.envelope?.width_m ?? briefK.width_m,
            height_m: geoOut?.envelope?.height_m ?? briefK.height_m,
            rooms: Array.isArray(geoOut?.rooms)
              ? geoOut.rooms.map((r) => ({ name: r.label, x: r.x, y: r.y, w: r.w, h: r.h, color: '#94a3b8' }))
              : [],
            doorsSegments: Array.isArray(geoOut?.doors) ? geoOut.doors : [],
            windowsSegments: Array.isArray(geoOut?.windows) ? geoOut.windows : [],
          };
          const kitchenOpenC = intentC?.canonicalConstraints?.kitchen_open_to_living !== false;
          if (kitchenOpenC && Array.isArray(planIntent.rooms) && planIntent.rooms.length) {
            const extraC = buildOpenPlanSegmentsFromLivingKitchen(planIntent.rooms);
            if (extraC.transitionDashSegments.length) {
              planIntent.openingsSegments = [...(planIntent.openingsSegments || []), ...extraC.openingsSegments];
              planIntent.transitionDashSegments = [
                ...(planIntent.transitionDashSegments || []),
                ...extraC.transitionDashSegments,
              ];
            }
          }
        } else {
          planIntent = generatePlanFromIntent(intentC, briefK);
        }

        const ok = validateAndNormalizePlan2D(planIntent);
        if (!ok.ok) {
          lastReason = `geometry_invalid:${ok.errors.slice(0, 4).join('|')}`;
          continue;
        }
        const arch = validateArchitecturalRules(ok.data, intentC);
        const isHouse = String(intentC?.type || '').toLowerCase() === 'house';
        const bandVal = isHouse ? validateHouseLivingHub(ok.data) : { ok: true, bands: null, checklist: null, errors: [] };
        if (!bandVal.ok) {
          lastReason = `solver_3band_failed:${bandVal.errors.slice(0, 4).join('|')}`;
          continue;
        }

        const { svg } = renderPlanSvgs(ok.data, norms);
        const data = { svg, plan: ok.data };
        cacheSet(cacheKey, data);
        return res.status(200).json({
          success: true,
          data,
          meta: {
            mode: 'constraints_first',
            rendererVersion,
            pipeline: {
              ...pipelineMeta,
              interpreted: summarizeInterpreted(interpretedFromC),
              brief: briefK,
              constraintOverrides: overridesC,
              constraintWarnings: warningsC,
              canonicalConstraints: intentC?.canonicalConstraints || null,
              intent: intentC,
              architecturalRules: arch.checks,
              architecturalWarnings: arch.warnings || [],
              layoutWarnings: ok.layoutWarnings || [],
              geometryService: geoMeta,
              solver3Band: isHouse ? { bands: bandVal.bands, checklist: bandVal.checklist } : null,
              regenerate: { tries: k + 1, lastReason: null },
            },
          },
        });
      }

      pipelineMeta.constraintsFirstFailure = String(lastReason || 'unknown');
    }

    
    try {
      const llmIntentRaw = await generateIntentWithLLM({ client, model: modelName, input });
      const intent0 = normalizeIntent(llmIntentRaw, interpreted);
      const canonical0 = buildCanonicalConstraintsFromIntent(intent0);
      const intent = applyCanonicalToEngineConstraints(intent0, canonical0);
      const reasoning = {
        
        intentParsed: intent,
        
        zoning: llmIntentRaw?.agent4_layout_synthesizer?.zones || null,
        
        internalPlan: {
          priority_rules: llmIntentRaw?.agent4_layout_synthesizer?.priority_rules || [],
          main_flow: llmIntentRaw?.agent4_layout_synthesizer?.main_flow || [],
          room_placement_notes: llmIntentRaw?.agent4_layout_synthesizer?.room_placement_notes || [],
          adjacency: {
            kitchen_living: true,
            bathroom_bedrooms: Boolean(intent?.constraints?.bathroom_near_bedrooms),
            wc_entry_hidden: Boolean(intent?.constraints?.wc_near_entry),
          },
        },
      };

      const interpretedFromIntent = {
        ...interpreted,
        dimensions: intent.dimensions,
        bedroomCount: intent.roomCounts?.bedrooms ?? interpreted.bedroomCount,
        entryNorth: Boolean(intent.constraints?.entry_north),
        livingCenter: Boolean(intent.constraints?.living_center),
        livingSouth: Boolean(intent.constraints?.living_south),
        kitchenEast: Boolean(intent.constraints?.kitchen_east),
        bedroomsSouth: Boolean(intent.constraints?.bedrooms_south),
        wantsIsland: Boolean(intent.specials?.wantsIsland),
        wantsOpenKitchen: intent.specials?.wantsOpenKitchen !== false,
      };

      const { brief: brief2, overrides: overrides2, warnings: warnings2 } = applyConstraints(interpretedFromIntent);

      
      
      
      const lockedEnvelope = brief2?.envelopeAdjustable === false;
      const maxTries = lockedEnvelope ? 3 : 18;
      let lastReason = null;

      for (let k = 0; k < maxTries; k++) {
        const grow = lockedEnvelope ? Math.min(k, 2) * 0.25 : k;
        const targetArea = Number(interpretedFromIntent?.intent?.area_m2);
        const fromArea = !lockedEnvelope ? pickEnvelopeFromArea(targetArea, k, intent) : null;
        const briefK = lockedEnvelope
          ? {
              ...brief2,
              width_m: Math.min(40, brief2.width_m + grow),
              height_m: Math.min(40, brief2.height_m + grow),
            }
          : fromArea
            ? { ...brief2, ...fromArea }
            : {
                ...brief2,
                width_m: Math.min(40, brief2.width_m + grow * 0.5),
                height_m: Math.min(40, brief2.height_m + (grow >= 6 ? 0.5 : 0) + Math.floor(grow / 10) * 0.25),
              };

        
        
        let planIntent;
        
        let geoMeta = null;
        const geoUrl = String(process.env.GEOMETRY_SERVICE_URL || '').trim();
        const preferLocal = String(process.env.PLAN2D_PREFER_LOCAL_SOLVER || 'true').trim().toLowerCase() === 'true';
        if (geoUrl && !preferLocal) {
          const payload = {
            intent: {
              building_type: intent.type || 'unknown',
              envelope: { width_m: briefK.width_m, height_m: briefK.height_m },
              program: {
                bedrooms: intent.roomCounts?.bedrooms ?? briefK.bedroomCount,
                bathrooms: intent.roomCounts?.bathrooms ?? 1,
                wc: intent.roomCounts?.wc ?? 1,
                kitchen: intent.roomCounts?.kitchen ?? 1,
                living: 1,
                dining: intent.roomCounts?.dining ?? 0,
                office: intent.roomCounts?.office ?? 0,
                garage: intent.roomCounts?.garage ?? 0,
                laundry: intent.roomCounts?.laundry ?? 0,
                storage: intent.roomCounts?.storage ?? 0,
                entry: 1,
              },
              constraints: {
                living_south: intent?.canonicalConstraints?.living_facing === 'south',
                kitchen_connected_to_living: intent?.canonicalConstraints?.kitchen_open_to_living !== false,
                bathroom_near_bedrooms: intent?.canonicalConstraints?.bathroom_near_bedrooms !== false,
                wc_near_entrance: intent?.canonicalConstraints?.wc_near === 'entry',
                wc_not_visible: intent?.canonicalConstraints?.wc_not_visible !== false,
                laundry_near_garage: intent?.canonicalConstraints?.laundry_near === 'garage',
              },
              raw: intent.raw || null,
            },
            strict: true,
            max_iterations: 120,
          };

          const geoOut = await geometryLayout({ url: geoUrl, payload });
          geoMeta = geoOut?.meta || null;
          
          planIntent = {
            width_m: geoOut?.envelope?.width_m ?? briefK.width_m,
            height_m: geoOut?.envelope?.height_m ?? briefK.height_m,
            rooms: Array.isArray(geoOut?.rooms)
              ? geoOut.rooms.map((r) => ({
                  name: r.label,
                  x: r.x,
                  y: r.y,
                  w: r.w,
                  h: r.h,
                  color: '#94a3b8',
                }))
              : [],
            doorsSegments: Array.isArray(geoOut?.doors) ? geoOut.doors : [],
            windowsSegments: Array.isArray(geoOut?.windows) ? geoOut.windows : [],
          };
          const kitchenOpen = intent?.canonicalConstraints?.kitchen_open_to_living !== false;
          if (kitchenOpen && Array.isArray(planIntent.rooms) && planIntent.rooms.length) {
            const extra = buildOpenPlanSegmentsFromLivingKitchen(planIntent.rooms);
            if (extra.transitionDashSegments.length) {
              planIntent.openingsSegments = [...(planIntent.openingsSegments || []), ...extra.openingsSegments];
              planIntent.transitionDashSegments = [
                ...(planIntent.transitionDashSegments || []),
                ...extra.transitionDashSegments,
              ];
            }
          }
        } else {
          planIntent = generatePlanFromIntent(intent, briefK);
        }

        const ok = validateAndNormalizePlan2D(planIntent);
        if (!ok.ok) {
          lastReason = `geometry_invalid:${ok.errors.slice(0, 4).join('|')}`;
          continue;
        }

        const arch = validateArchitecturalRules(ok.data, intent);

        const isHouse = String(intent?.type || '').toLowerCase() === 'house';
        const bandVal = isHouse ? validateHouseLivingHub(ok.data) : { ok: true, bands: null, checklist: null, errors: [] };
        if (!bandVal.ok) {
          lastReason = `solver_3band_failed:${bandVal.errors.slice(0, 4).join('|')}`;
          continue;
        }

        const { svg } = renderPlanSvgs(ok.data, norms);
        const data = { svg, plan: ok.data };
        cacheSet(cacheKey, data);
        return res.status(200).json({
          success: true,
          data,
          meta: {
            mode: 'intent_first',
            rendererVersion,
            pipeline: {
              ...pipelineMeta,
              interpreted: summarizeInterpreted(interpretedFromIntent),
              brief: briefK,
              constraintOverrides: overrides2,
              constraintWarnings: warnings2,
              intent,
              canonicalConstraints: intent?.canonicalConstraints || null,
              reasoning,
              architecturalRules: arch.checks,
              architecturalWarnings: arch.warnings || [],
              layoutWarnings: ok.layoutWarnings || [],
              geometryService: geoMeta,
              solver3Band: isHouse ? { bands: bandVal.bands, checklist: bandVal.checklist } : null,
              regenerate: { tries: k + 1, lastReason: null },
            },
          },
        });
      }

      
      
      pipelineMeta.intentFirstFailure = String(lastReason || 'unknown');
    } catch (e) {
      
      pipelineMeta.intentFirstFailure = String(e?.message || e);
    }

    
    
    try {
      const intent2raw = interpreted?.intent || null;
      if (intent2raw) {
        const canonical2 = buildCanonicalConstraintsFromIntent(intent2raw);
        const intent2 = applyCanonicalToEngineConstraints(intent2raw, canonical2);
        const interpretedFromInterpreterIntent = {
          ...interpreted,
          dimensions: interpreted.dimensions,
          bedroomCount: interpreted.bedroomCount,
          entryNorth: interpreted.entryNorth,
          livingCenter: interpreted.livingCenter,
          livingSouth: interpreted.livingSouth,
          kitchenEast: interpreted.kitchenEast,
          bedroomsSouth: interpreted.bedroomsSouth,
          wantsIsland: interpreted.wantsIsland,
          wantsOpenKitchen: interpreted.wantsOpenKitchen,
        };

        const { brief: briefLocal, overrides: overridesLocal, warnings: warningsLocal } = applyConstraints(interpretedFromInterpreterIntent);

        const lockedEnvelope = briefLocal?.envelopeAdjustable === false;
        const maxTriesLocal = lockedEnvelope ? 3 : 18;
        let lastLocalReason = null;
        for (let k = 0; k < maxTriesLocal; k++) {
          const grow = lockedEnvelope ? Math.min(k, 2) * 0.25 : k;
          const targetArea = Number(interpretedFromInterpreterIntent?.intent?.area_m2);
          const fromArea = !lockedEnvelope ? pickEnvelopeFromArea(targetArea, k, intent2) : null;
          const briefK = lockedEnvelope
            ? {
                ...briefLocal,
                width_m: Math.min(40, briefLocal.width_m + grow),
                height_m: Math.min(40, briefLocal.height_m + grow),
              }
            : fromArea
              ? { ...briefLocal, ...fromArea }
              : {
                  ...briefLocal,
                  width_m: Math.min(40, briefLocal.width_m + grow * 0.5),
                  height_m: Math.min(40, briefLocal.height_m + (grow >= 6 ? 0.5 : 0) + Math.floor(grow / 10) * 0.25),
                };

          const planCandidate = generatePlanFromIntent(intent2, briefK);
          const ok = validateAndNormalizePlan2D(planCandidate);
          if (!ok.ok) {
            lastLocalReason = `geometry_invalid:${ok.errors.slice(0, 4).join('|')}`;
            continue;
          }
          const arch = validateArchitecturalRules(ok.data, intent2);

          const isHouse = String(intent2?.type || '').toLowerCase() === 'house';
          const bandVal = isHouse ? validateHouseLivingHub(ok.data) : { ok: true, bands: null, checklist: null, errors: [] };
          if (!bandVal.ok) {
            lastLocalReason = `solver_3band_failed:${bandVal.errors.slice(0, 4).join('|')}`;
            continue;
          }

          const { svg } = renderPlanSvgs(ok.data, norms);
          const data = { svg, plan: ok.data };
          cacheSet(cacheKey, data);
          return res.status(200).json({
            success: true,
            data,
            meta: {
              mode: 'intent_fallback_local',
              rendererVersion,
              pipeline: {
                ...pipelineMeta,
                brief: briefK,
                constraintOverrides: overridesLocal,
                constraintWarnings: warningsLocal,
                architecturalRules: arch.checks,
                architecturalWarnings: arch.warnings || [],
                layoutWarnings: ok.layoutWarnings || [],
                canonicalConstraints: intent2?.canonicalConstraints || null,
                solver3Band: isHouse ? { bands: bandVal.bands, checklist: bandVal.checklist } : null,
                intentFirstFailure: pipelineMeta.intentFirstFailure,
                localFallback: { tries: k + 1, lastReason: null },
              },
            },
          });
        }
        pipelineMeta.localFallbackFailure = String(lastLocalReason || 'unknown');
      }
    } catch (e) {
      pipelineMeta.localFallbackFailure = String(e?.message || e);
    }

    
    const allowDirectLlm = String(process.env.ALLOW_DIRECT_LLM_PLAN || '').trim().toLowerCase() === 'true';
    if (!allowDirectLlm) {
      
      
      const adjustable = interpreted?.dimensions == null || !Number.isFinite(Number(interpreted?.dimensions?.width_m));
      if (adjustable) {
        try {
          const { brief: briefUx, overrides: overridesUx, warnings: warningsUx } = applyConstraints(interpreted);
          let lastUx = null;
          for (let k = 0; k < 24; k++) {
            const targetArea = Number(interpreted?.intent?.area_m2);
            const fromArea = pickEnvelopeFromArea(targetArea, k, interpreted?.intent || null);
            const briefK = fromArea
              ? { ...briefUx, ...fromArea }
              : {
                  ...briefUx,
                  width_m: Math.min(40, briefUx.width_m + k * 0.5),
                  height_m: Math.min(40, briefUx.height_m + Math.floor(k / 8) * 0.5),
                };
            const candidate = generateArchitectPlan(briefK);
            const ok = validateAndNormalizePlan2D(candidate);
            if (!ok.ok) {
              lastUx = `geometry_invalid:${ok.errors.slice(0, 3).join('|')}`;
              continue;
            }
            const arch = validateArchitecturalRules(ok.data, interpreted?.intent || {});
            
            const { svg } = renderPlanSvgs(ok.data, norms);
            const data = { svg, plan: ok.data };
            cacheSet(cacheKey, data);
            return res.status(200).json({
              success: true,
              data,
              meta: {
                mode: 'best_effort_architect',
                rendererVersion,
                pipeline: {
                  ...pipelineMeta,
                  brief: briefK,
                  constraintOverrides: overridesUx,
                  constraintWarnings: [
                    ...warningsUx,
                    ...(arch.warnings || []),
                    ...(ok.layoutWarnings || []),
                    'Mode best-effort: contraintes strictes non entièrement satisfaites; le plan reste exportable et géométriquement valide.',
                    `Détail: intentFirstFailure=${String(pipelineMeta.intentFirstFailure || '')} localFallbackFailure=${String(
                      pipelineMeta.localFallbackFailure || ''
                    )} lastUx=${String(lastUx || '')}`,
                  ],
                  intentFirstFailure: pipelineMeta.intentFirstFailure,
                  localFallbackFailure: pipelineMeta.localFallbackFailure,
                },
              },
            });
          }
        } catch {
          
        }
      }

      throw new AppError(
        `Impossible de générer un plan valide avec contraintes strictes. intentFirstFailure=${String(pipelineMeta.intentFirstFailure || '')} localFallbackFailure=${String(
          pipelineMeta.localFallbackFailure || ''
        )}`,
        422
      );
    }

    for (let attempt = 0; attempt < attempts; attempt++) {
      const llmOut = await generatePlanWithLLM({
        client,
        model: modelName,
        input,
        attemptFix: attempt > 0,
        previousErrors: [],
        constraintFooter,
      }).catch((e) => {
        throw e;
      });

      const normalized = validateAndNormalizePlan2D(llmOut);
      if (normalized.ok) {
        const { svg } = renderPlanSvgs(normalized.data, norms);
        const data = { svg, plan: normalized.data };
        cacheSet(cacheKey, data);
        return res.status(200).json({ success: true, data, meta: { mode: 'llm', pipeline: pipelineMeta, rendererVersion } });
      }

      if (attempt < attempts - 1) {
        const normalized2 = validateAndNormalizePlan2D(llmOut);
        const previousErrors = normalized2.errors;
        const llmOut2 = await generatePlanWithLLM({
          client,
          model: modelName,
          input,
          attemptFix: true,
          previousErrors,
          constraintFooter,
        });
        const normalizedPlan2 = validateAndNormalizePlan2D(llmOut2);
        if (normalizedPlan2.ok) {
          const { svg } = renderPlanSvgs(normalizedPlan2.data, norms);
          const data = { svg, plan: normalizedPlan2.data };
          cacheSet(cacheKey, data);
          return res.status(200).json({ success: true, data, meta: { mode: 'llm', pipeline: pipelineMeta, rendererVersion } });
        }
      }
    }

    
    try {
      const intent2raw = interpreted?.intent || null;
      if (!intent2raw) throw new Error('missing_interpreted_intent');
      const intent2 = applyCanonicalToEngineConstraints(intent2raw, buildCanonicalConstraintsFromIntent(intent2raw));
      const planCandidate = generatePlanFromIntent(intent2, brief);
      const ok = validateAndNormalizePlan2D(planCandidate);
      if (!ok.ok) throw new Error(ok.errors?.[0] || 'invalid_plan');
      const arch = validateArchitecturalRules(ok.data, intent2);
      const { svg } = renderPlanSvgs(ok.data, norms);
      const data = { svg, plan: ok.data };
      cacheSet(cacheKey, data);
      return res.status(200).json({
        success: true,
        data,
        meta: {
          mode: 'deterministic_final_fallback',
          pipeline: pipelineMeta,
          rendererVersion,
          architecturalWarnings: arch.warnings || [],
          layoutWarnings: ok.layoutWarnings || [],
        },
      });
    } catch (e) {
      throw new AppError(`Impossible de générer un plan valide (contraintes strictes). ${String(e?.message || e).slice(0, 160)}`, 422);
    }
  } catch (err) {
    
    throw err instanceof AppError ? err : new AppError(String(err?.message || 'Erreur LLM'), 502);
  }
});

