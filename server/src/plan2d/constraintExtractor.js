import { getArchitectureGuideBlockForPrompt } from './floorPlanArchitectureGuide.js';

function extractJsonPayload(content) {
  const s = String(content ?? '').trim();
  const m = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(s);
  return m ? m[1].trim() : s;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function validateConstraintsShape(out) {
  if (!isPlainObject(out)) return 'not_an_object';
  if (!('total_area' in out)) return 'missing_total_area';
  if (!Array.isArray(out.rooms)) return 'missing_rooms_array';
  if (!Array.isArray(out.adjacency)) return 'missing_adjacency_array';
  if (!Array.isArray(out.layout_rules)) return 'missing_layout_rules_array';
  if (!isPlainObject(out.orientation)) return 'missing_orientation_object';
  return null;
}


export const ROOM_ALIASES = {
  wc: 'wc',
  toilettes: 'wc',
  toilette: 'wc',
  'w.c': 'wc',
  water: 'wc',
  buanderie: 'laundry',
  laverie: 'laundry',
  dégagement: 'corridor',
  degagement: 'corridor',
  couloir: 'corridor',
  hall: 'entry',
  entrée: 'entry',
  entree: 'entry',
  "salle d'eau": 'bathroom',
  "salle d eau": 'bathroom',
  sdb: 'bathroom',
  'salle de bain': 'bathroom',
  salon: 'living_room',
  séjour: 'living_room',
  sejour: 'living_room',
  cuisine: 'kitchen',
  chambre: 'bedroom',
  chambres: 'bedroom',
  bureau: 'office',
  rangement: 'storage',
  placard: 'storage',
  cellier: 'storage',
};


export const PLACEMENT_HINTS = {
  "près de l'entrée": { nearRoom: 'entry' },
  'près du salon': { nearRoom: 'living_room' },
  'dans le dégagement': { insideRoom: 'corridor' },
  'dans le degagement': { insideRoom: 'corridor' },
  'au fond': { position: 'back' },
  'côté rue': { facing: 'south' },
  'beaucoup de lumière': { windowPriority: 'high' },
  'lumière naturelle': { windowPriority: 'high' },
  ouverte: { openPlan: true },
  ouvert: { openPlan: true },
  séparé: { separate: true },
  separe: { separate: true },
  'éviter les couloirs': { corridorMinimize: true },
  'eviter les couloirs': { corridorMinimize: true },
};

function normalizePrompt(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}


function collectMentionedRoomTypes(raw) {
  const t = normalizePrompt(raw);
  const found = new Set();
  if (/\bwc\b/.test(t)) found.add('wc');
  for (const [phrase, type] of Object.entries(ROOM_ALIASES)) {
    const p = phrase.replace(/\s+/g, ' ').trim().toLowerCase();
    if (p.length < 2) continue;
    if (t.includes(p)) found.add(type);
  }
  
  if (/\b\d+\s*chambres?\b/.test(t) || /\bchambres?\s*\d+\b/.test(t)) found.add('bedroom');
  if (/\bsalon[-\s]?cuisine\b/.test(t) || /\bcuisine[-\s]?americaine\b/.test(t)) {
    found.add('living_room');
    found.add('kitchen');
  }
  return found;
}

function extractPlacementHintsFromPrompt(raw) {
  const t = normalizePrompt(raw);
  
  const out = {};
  for (const [phrase, hint] of Object.entries(PLACEMENT_HINTS)) {
    const p = normalizePrompt(phrase);
    if (p.length >= 4 && t.includes(p)) {
      Object.assign(out, hint);
    }
  }
  return out;
}

function parseTotalAreaM2(t) {
  const s = String(t);
  
  let m = /\benviron\s+(\d+(?:[.,]\d+)?)\s*(?:m\s*2|m2|m²)/i.exec(s);
  if (m) return Number(String(m[1]).replace(',', '.'));
  m = /(\d+(?:[.,]\d+)?)\s*(?:m\s*2|m2|m²)/i.exec(s);
  if (m) return Number(String(m[1]).replace(',', '.'));
  return null;
}

function parseBedroomCount(t) {
  let m = /\b(\d+)\s*chambres?\b/i.exec(t);
  if (m) return Math.min(6, Math.max(0, parseInt(m[1], 10)));
  m = /\bchambres?\s*(\d+)\b/i.exec(t);
  if (m) return Math.min(6, Math.max(0, parseInt(m[1], 10)));
  return null;
}

function bool(t, re) {
  return re.test(t);
}

function mergeRoomEntry(rooms, type, patch) {
  const i = rooms.findIndex((r) => String(r?.type).toLowerCase() === String(type).toLowerCase());
  if (i >= 0) {
    const prev = rooms[i];
    const next = { ...prev, ...patch };
    if (patch.count != null) {
      next.count = Math.max(Number(prev.count) || 0, Number(patch.count) || 0);
    }
    rooms[i] = next;
    return;
  }
  rooms.push({
    type,
    count: patch.count ?? 1,
    area_min: patch.area_min ?? null,
    features: patch.features ?? [],
    facing: patch.facing ?? null,
    zone: patch.zone ?? 'private',
    ...patch,
  });
}


function ensureMentionedRooms(rooms, rawPrompt, warnings) {
  const mentioned = collectMentionedRoomTypes(rawPrompt);
  const byType = new Map(rooms.map((r) => [String(r.type).toLowerCase(), r]));
  const defaults = {
    wc: { zone: 'private', count: 1, area_min: 1.62, features: ['separate'], zone_private: true },
    laundry: { zone: 'service', count: 1, area_min: 1, features: ['in_corridor'] },
    corridor: { zone: 'service', count: 1, area_min: 2.5, features: ['hub'] },
    bathroom: { zone: 'private', count: 1, area_min: 4, features: [] },
    bedroom: { zone: 'private', count: 2, area_min: 9 },
    kitchen: { zone: 'public', count: 1, area_min: 6 },
    living_room: { zone: 'public', count: 1, area_min: 12 },
    entry: { zone: 'public', count: 1, area_min: 3 },
    storage: { zone: 'service', count: 0, area_min: null },
    garage: { zone: 'service', count: 0 },
    office: { zone: 'private', count: 1 },
  };

  for (const typ of mentioned) {
    const row = byType.get(typ);
    const c = row ? Number(row.count) || 0 : 0;
    if (!row || c === 0) {
      const def = defaults[typ];
      if (!def || (def.count === 0 && typ === 'storage')) continue;
      const label = typ;
      warnings.push(`Room '${label}' was mentioned in the prompt but missing or count 0 — adding with default size.`);
      mergeRoomEntry(rooms, typ, { ...def, count: def.count > 0 ? def.count : 1 });
      byType.set(typ, rooms.find((r) => String(r.type).toLowerCase() === typ));
    }
  }
}


export function buildOpenPlanZone(rawPrompt, rooms) {
  const t = normalizePrompt(rawPrompt);
  const hints = extractPlacementHintsFromPrompt(rawPrompt);
  const kitchenRow = rooms.find((r) => String(r?.type).toLowerCase() === 'kitchen');
  const livingRow = rooms.find((r) => String(r?.type).toLowerCase() === 'living_room');

  const phraseOpen =
    /\b(salon[-\s]?cuisine|cuisine[-\s]?ouverte|espace\s+ouvert|cuisine\s+americaine|open\s*plan|plan\s*ouvert)\b/.test(t) ||
    hints.openPlan === true ||
    bool(t, /\bouverte\b/) && /\b(cuisine|salon|sejour)\b/.test(t);

  const hasIsland = bool(t, /\b(îlot|ilot|island)\b/i);

  if (!phraseOpen && !bool(t, /\b(open|ouverte)\b/)) {
    return null;
  }

  let divider = 'none';
  if (hasIsland) divider = 'island';

  const kArea = Number(kitchenRow?.area_min) || 8;
  const lArea = Number(livingRow?.area_min) || 20;

  return {
    rooms: ['living_room', 'kitchen'],
    combined_area: kArea + lArea,
    has_island: hasIsland,
    divider,
    enabled: true,
  };
}

function buildConstraintExtractorSystemPrompt() {
  return `
You are an architectural constraint parser. Given a natural language house description,
extract ALL spatial constraints into a strict JSON object.

Return ONLY valid JSON, no explanation. Format:

{
  "total_area": number | null,
  "rooms": [
    {
      "type": "living_room" | "bedroom" | "kitchen" | "bathroom" | "wc" |
               "corridor" | "garage" | "laundry" | "storage" | "entry",
      "count": number,
      "area_min": number | null,
      "features": ["island", "open", "ensuite", ...],
      "facing": "north" | "south" | "east" | "west" | null,
      "zone": "public" | "private" | "service"
    }
  ],
  "adjacency": [
    { "room_a": string, "room_b": string, "relation": "near" | "connected" | "avoid" }
  ],
  "layout_rules": [
    "avoid_long_corridors" | "cluster_bedrooms" | "open_plan" | ...
  ],
  "orientation": {
    "living_room": "south" | null,
    "master_bedroom": "east" | null
  }
}

Rules:
- ALWAYS include wc and laundry if the user mentions toilet/WC/toilettes or buanderie/laundry.
- ALWAYS include corridor if dégagement/couloir is mentioned or laundry is "in the corridor".
- Parse explicit bedroom count: "2 chambres" → bedroom count 2.
- Parse surface: "65 m²", "environ 65 m²" → total_area.
- "salle d'eau" / "salle d'eau" → bathroom (count 1) unless a separate WC is also asked.
- If salon–cuisine ouverte / cuisine ouverte → kitchen.features includes "open" and layout_rules includes "open_plan".
- Do NOT invent dimensions if absent; use null (except total_area if stated).
- Prefer explicit zone assignment:
  - public: living_room, kitchen, entry
  - private: bedroom, bathroom, wc
  - service: garage, laundry, storage, corridor
` + getArchitectureGuideBlockForPrompt();
}


export function parsePromptProgram(raw) {
  const rawS = String(raw || '').trim();
  const t = normalizePrompt(rawS);

  const total_area = parseTotalAreaM2(rawS);
  const bedroomsParsed = parseBedroomCount(t);

  const wantsIsland = bool(t, /\b(island|îlot|ilot)\b/);
  const wantsOpen =
    bool(t, /\b(open|ouverte)\b/) ||
    bool(t, /\bopen plan|open-plan|plan ouvert\b/) ||
    /\b(salon[-\s]?cuisine|cuisine[-\s]?americaine|espace\s+ouvert)\b/.test(t) ||
    (/\bouverte\b/.test(t) && /\b(cuisine|salon|sejour|séjour)\b/.test(t));

  const wantsAvoidLongCorridors = bool(
    t,
    /\b(éviter|eviter)\s+((les\s+)?long(s)?\s+)?couloirs?\b|\bavoid long corridors\b|\bcorridormin\b/
  );

  
  const naturalLightHigh = bool(t, /\b(beaucoup\s+de\s+lumiere|lumiere\s+naturelle|fenetres?\s+grand)\b/);

  const mentioned = collectMentionedRoomTypes(rawS);

  let bedrooms = bedroomsParsed != null ? bedroomsParsed : 1;
  if (bedroomsParsed == null && mentioned.has('bedroom') && !/\d+\s*chambres?/.test(t)) {
    bedrooms = 1;
  }

  let bathrooms = 1;
  if (/\b(deux|2)\s+salles?\s+(d'|d\s*)?eau\b/.test(t)) bathrooms = 2;
  else if (bool(t, /\bune\s+salle\s+(d'|d\s*)?eau\b/) || mentioned.has('bathroom')) bathrooms = 1;

  
  const wcCount = 1;
  const laundryCount =
    mentioned.has('laundry') || bool(t, /\bbuanderie|laverie\b/) ? 1 : 0;
  const corridorCount =
    mentioned.has('corridor') || bool(t, /\bd(eg|é)agement|couloir\b/) || laundryCount > 0 ? 1 : 0;

  const storageCount = bool(t, /\brangement|placard|cellier\b/) ? 1 : 0;

  return {
    total_area,
    bedrooms,
    bathrooms,
    wcCount,
    laundryCount,
    corridorCount,
    storageCount,
    wantsIsland,
    wantsOpen,
    wantsAvoidLongCorridors,
    naturalLightHigh,
    mentioned,
  };
}


export function enrichExtractedConstraints(extracted, rawPrompt) {
  const warnings = [];
  const out = extracted && typeof extracted === 'object' ? { ...extracted } : {};
  const prog = parsePromptProgram(rawPrompt);

  if (!Array.isArray(out.rooms)) out.rooms = [];
  if (!Array.isArray(out.adjacency)) out.adjacency = [];
  if (!Array.isArray(out.layout_rules)) out.layout_rules = [];
  if (!isPlainObject(out.orientation)) out.orientation = { living_room: null, master_bedroom: null };

  if (prog.total_area != null && (out.total_area == null || Number(out.total_area) <= 0)) {
    out.total_area = prog.total_area;
    warnings.push(`Filled total_area=${prog.total_area} from prompt (parser).`);
  }

  
  const bedRow = out.rooms.find((r) => String(r?.type).toLowerCase() === 'bedroom');
  if (prog.bedrooms >= 1 && bedRow) {
    bedRow.count = prog.bedrooms;
  } else if (prog.bedrooms >= 1) {
    mergeRoomEntry(out.rooms, 'bedroom', { count: prog.bedrooms, zone: 'private', area_min: 9 });
  }

  mergeRoomEntry(out.rooms, 'laundry', { count: Math.max(prog.laundryCount, countOfType(out.rooms, 'laundry')), zone: 'service' });
  mergeRoomEntry(out.rooms, 'corridor', { count: Math.max(prog.corridorCount, countOfType(out.rooms, 'corridor')), zone: 'service' });
  mergeRoomEntry(out.rooms, 'wc', { count: Math.max(1, countOfType(out.rooms, 'wc')), zone: 'private', area_min: 1.62, features: ['separate'] });
  mergeRoomEntry(out.rooms, 'bathroom', { count: Math.max(1, countOfType(out.rooms, 'bathroom')), zone: 'private', area_min: 4 });

  if (prog.storageCount === 0) {
    const st = out.rooms.find((r) => String(r?.type).toLowerCase() === 'storage');
    if (st) st.count = 0;
  }

  ensureMentionedRooms(out.rooms, rawPrompt, warnings);

  const wcNear =
    /\bwc\b.*\b(entree|entrée)\b|\b(entree|entrée)\b.*\bwc\b|près\s*(de\s*)?l\s*'?(entree|entrée)|wc\s+séparé/i.test(rawPrompt);
  if (wcNear) {
    const has = out.adjacency.some(
      (e) =>
        ['wc', 'entry'].includes(String(e.room_a).toLowerCase()) && ['wc', 'entry'].includes(String(e.room_b).toLowerCase())
    );
    if (!has) out.adjacency.push({ room_a: 'wc', room_b: 'entry', relation: 'near' });
  }

  const hasKitchenLiving = out.adjacency.some(
    (e) =>
      String(e.relation).toLowerCase() === 'connected' &&
      ((String(e.room_a).toLowerCase() === 'kitchen' && String(e.room_b).toLowerCase() === 'living_room') ||
        (String(e.room_b).toLowerCase() === 'kitchen' && String(e.room_a).toLowerCase() === 'living_room'))
  );
  if (!hasKitchenLiving) out.adjacency.push({ room_a: 'kitchen', room_b: 'living_room', relation: 'connected' });

  if (countOfType(out.rooms, 'laundry') > 0 && countOfType(out.rooms, 'corridor') > 0) {
    const hasLaundryCorridor = out.adjacency.some(
      (e) =>
        ['laundry', 'corridor'].includes(String(e.room_a).toLowerCase()) &&
        ['laundry', 'corridor'].includes(String(e.room_b).toLowerCase())
    );
    if (!hasLaundryCorridor) {
      out.adjacency.push({ room_a: 'laundry', room_b: 'corridor', relation: 'connected' });
    }
  }

  const beds = countOfType(out.rooms, 'bedroom');
  if (beds >= 2 && !out.layout_rules.includes('cluster_bedrooms')) out.layout_rules.push('cluster_bedrooms');
  if (prog.wantsOpen && !out.layout_rules.includes('open_plan')) out.layout_rules.push('open_plan');
  if (prog.wantsAvoidLongCorridors && !out.layout_rules.includes('avoid_long_corridors')) {
    out.layout_rules.push('avoid_long_corridors');
  }
  if (prog.naturalLightHigh && !out.layout_rules.includes('many_windows')) out.layout_rules.push('many_windows');

  const kitchenIdx = out.rooms.findIndex((r) => String(r?.type).toLowerCase() === 'kitchen');
  if (kitchenIdx >= 0) {
    const fs = new Set([...(out.rooms[kitchenIdx].features || [])].map((x) => String(x).toLowerCase()));
    if (prog.wantsOpen) fs.add('open');
    if (prog.wantsIsland) fs.add('island');
    out.rooms[kitchenIdx].features = [...fs];
  }

  out.placement_hints = extractPlacementHintsFromPrompt(rawPrompt);
  out.open_plan_zone = buildOpenPlanZone(rawPrompt, out.rooms);

  if (!out.meta || typeof out.meta !== 'object') out.meta = {};
  out.meta.warnings = [...(out.meta.warnings || []), ...warnings];
  out.meta.extractor = { enriched: true, parser: 'v2' };

  return out;
}

function countOfType(rooms, type) {
  const r = rooms.find((x) => String(x?.type).toLowerCase() === String(type).toLowerCase());
  const n = Math.round(Number(r?.count));
  return Number.isFinite(n) ? n : 0;
}


export function extractConstraintsHeuristic(prompt) {
  const raw = String(prompt || '').trim();
  const prog = parsePromptProgram(raw);

  const kitchenFeatures = [];
  if (prog.wantsOpen) kitchenFeatures.push('open');
  if (prog.wantsIsland) kitchenFeatures.push('island');

  
  const rooms = [];
  rooms.push({ type: 'entry', count: 1, area_min: 3, features: [], facing: null, zone: 'public' });
  rooms.push({ type: 'living_room', count: 1, area_min: 14, features: [], facing: null, zone: 'public' });
  rooms.push({
    type: 'kitchen',
    count: 1,
    area_min: 8,
    features: kitchenFeatures,
    facing: null,
    zone: 'public',
  });
  if (prog.bedrooms > 0) {
    rooms.push({ type: 'bedroom', count: prog.bedrooms, area_min: 9, features: [], facing: null, zone: 'private' });
  }
  rooms.push({
    type: 'bathroom',
    count: prog.bathrooms,
    area_min: 4,
    features: bool(normalizePrompt(raw), /\bsalle\s+d['\s]*eau\b/) ? ['shower_room'] : [],
    facing: null,
    zone: 'private',
  });
  rooms.push({
    type: 'wc',
    count: Math.max(1, prog.wcCount),
    area_min: 1.62,
    features: ['separate'],
    facing: null,
    zone: 'private',
  });
  if (prog.laundryCount > 0) {
    rooms.push({
      type: 'laundry',
      count: 1,
      area_min: 1,
      features: ['in_corridor'],
      facing: null,
      zone: 'service',
    });
  }
  if (prog.corridorCount > 0) {
    rooms.push({
      type: 'corridor',
      count: 1,
      area_min: 2.5,
      features: ['hub', 'degagement'],
      facing: null,
      zone: 'service',
    });
  }
  if (prog.storageCount > 0) {
    rooms.push({ type: 'storage', count: 1, area_min: 2, features: [], facing: null, zone: 'service' });
  }

  const adjacency = [
    { room_a: 'kitchen', room_b: 'living_room', relation: 'connected' },
    { room_a: 'wc', room_b: 'entry', relation: 'near' },
  ];
  if (prog.laundryCount > 0) {
    adjacency.push({ room_a: 'laundry', room_b: 'corridor', relation: 'connected' });
  }

  const layout_rules = [];
  if (prog.wantsAvoidLongCorridors) layout_rules.push('avoid_long_corridors');
  if (prog.bedrooms >= 2) layout_rules.push('cluster_bedrooms');
  if (prog.wantsOpen) layout_rules.push('open_plan');
  if (prog.naturalLightHigh) layout_rules.push('many_windows');

  const tnorm = normalizePrompt(raw);
  const meta = {
    inferred_building: /\b(appartement|apartment)\b/.test(tnorm) ? 'apartment' : /\b(maison|house)\b/.test(tnorm) ? 'house' : 'unknown',
    qualifiers: {
      naturalLightHigh: prog.naturalLightHigh,
      wantsOpen: prog.wantsOpen,
    },
  };

  const base = {
    total_area: prog.total_area,
    rooms,
    adjacency,
    layout_rules,
    orientation: { living_room: null, master_bedroom: null },
    meta,
    placement_hints: extractPlacementHintsFromPrompt(raw),
    open_plan_zone: buildOpenPlanZone(raw, rooms),
  };

  const warnings = [];
  ensureMentionedRooms(base.rooms, raw, warnings);
  if (warnings.length) base.meta.warnings = warnings;

  return base;
}


export async function extractConstraints({ client, model, prompt }) {
  if (!client) throw new Error('extractConstraints: client missing');
  const m = String(model || '').trim();
  if (!m) throw new Error('extractConstraints: model missing');
  const input = String(prompt || '').trim();
  if (!input) throw new Error('extractConstraints: prompt missing');

  const completion = await client.chat.completions.create({
    model: m,
    temperature: 0.1,
    messages: [
      { role: 'system', content: buildConstraintExtractorSystemPrompt() },
      { role: 'user', content: input },
    ],
    response_format: { type: 'json_object' },
  });

  const content = completion?.choices?.[0]?.message?.content;
  if (!content) throw new Error('extractConstraints: empty LLM response');

  let parsed;
  try {
    parsed = JSON.parse(extractJsonPayload(content));
  } catch {
    throw new Error('extractConstraints: invalid JSON');
  }

  const shapeErr = validateConstraintsShape(parsed);
  if (shapeErr) throw new Error(`extractConstraints: invalid shape (${shapeErr})`);

  return enrichExtractedConstraints(parsed, input);
}
