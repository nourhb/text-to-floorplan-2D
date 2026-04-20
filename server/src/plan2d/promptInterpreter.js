

function parseNum(s) {
  const n = Number(String(s || '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function boolFromRegex(t, re) {
  return re.test(t);
}

function maxAllIntMatches(text, re) {
  const nums = Array.from(String(text || '').matchAll(re))
    .map((m) => parseInt(m[1], 10))
    .filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) : null;
}







function buildSpatialGraphFromIntent(intent) {
  
  const g = { nodes: [], edges: [] };
  const addNode = (n) => {
    if (!g.nodes.includes(n)) g.nodes.push(n);
  };
  const addEdge = (from, to, kind, reason) => {
    if (!from || !to) return;
    addNode(from);
    addNode(to);
    g.edges.push({ from, to, kind, reason });
  };

  
  addEdge('entry', 'living', 'must_connect', 'access');
  addEdge('living', 'kitchen', 'must_connect', 'day_zone');
  addEdge('living', 'bedrooms', 'prefer_connect', 'circulation');
  addEdge('bedrooms', 'bathroom', 'prefer_connect', 'night_zone');
  if (intent.roomCounts.wc > 0) addEdge('entry', 'wc', 'prefer_connect', 'guest_wc');
  if (intent.roomCounts.garage > 0) addEdge('entry', 'garage', 'prefer_connect', 'direct_access');
  if (intent.roomCounts.laundry > 0) addEdge('garage', 'laundry', 'prefer_connect', 'service_cluster');
  if (intent.roomCounts.storage > 0) addEdge('kitchen', 'storage', 'prefer_connect', 'cellier');

  
  if (intent.constraints.kitchen_near_living) addEdge('kitchen', 'living', 'must_connect', 'constraint');
  if (intent.constraints.bathroom_near_bedrooms) addEdge('bathroom', 'bedrooms', 'must_connect', 'constraint');
  if (intent.constraints.garage_connected_to_entry) addEdge('garage', 'entry', 'must_connect', 'constraint');

  return g;
}


export function interpretPrompt(input) {
  const rawText = String(input || '').trim();
  const t = rawText.toLowerCase();

  const dimMatch = /(\d+(?:[.,]\d+)?)\s*(?:x|×)\s*(\d+(?:[.,]\d+)?)\s*m?\b/i.exec(rawText);
  const dimensions = dimMatch
    ? { width_m: parseNum(dimMatch[1]), height_m: parseNum(dimMatch[2]) }
    : null;

  
  
  const areaEnd = '(?=\\s|$|[.,;:!?\\)\\]\\}])';
  const areaPatterns = [
    new RegExp(`(?:environ|environ\\s+de|≈|~|vers|sur|autour\\s+de)\\s*(\\d+(?:[.,]\\d+)?)\\s*(?:m2|m²|sqm|m\\^2)${areaEnd}`, 'i'),
    new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:m2|m²|sqm|m\\^2)${areaEnd}`, 'i'),
    new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*m\\s*[²2]${areaEnd}`, 'i'),
    new RegExp(`(?:a|an)\\s*(\\d+(?:[.,]\\d+)?)\\s*m\\s*(?:house|maison|home)${areaEnd}`, 'i'),
  ];
  let area_m2 = null;
  for (const re of areaPatterns) {
    const m = re.exec(rawText);
    if (m) {
      area_m2 = parseNum(m[1]);
      break;
    }
  }

  let bedroomCount = maxAllIntMatches(rawText, /\b(\d{1,2})\s*(?:chambres?|bedrooms?)\b/gi);
  if (bedroomCount == null) {
    if (/\bt2\b/i.test(t)) bedroomCount = 1;
    else if (/\bt3\b/i.test(t)) bedroomCount = 2;
    else if (/\bt4\b/i.test(t)) bedroomCount = 3;
  }

  const wantsCorridorDedicated =
    /\b(couloir|corridor|hallway|circulation\s+dédiée)\b/.test(t) &&
    !/\b(sans|no|without|éviter|éliminer|eliminate|minimi|narrow|étroit)\b/.test(t);

  const wantsMinimizeCorridor =
    /\b(sans|no|without|éliminer|eliminate|minimi|rédui|reduce)\s+.{0,20}?(couloir|corridor)\b/.test(t) ||
    /\b(open[-\s]?plan|open\s+plan|pièce\s+de\s+vie|hub|noyau)\b/.test(t);

  const wantsIsland = /\b(island|îlot|ilot|bar\s+(?:central|d['’]?îlot))\b/i.test(rawText);

  const wantsOpenKitchen =
    /\b(cuisine\s+ouverte|open\s+kitchen|ouverte\s+sur)\b/i.test(t) || !/\b(cuisine\s+fermée|closed\s+kitchen)\b/i.test(t);

  const wantsNoDeadSpace = /\b(pas\s+de\s+perte|no\s+dead|sans\s+perte|optimis|efficace)\b/i.test(t);

  const strictBuildability =
    /\b(buildable|réaliste|constructible|strict|non[-\s]?negotiable|must|contrainte|constraint)\b/i.test(t);

  const entryNorth =
    /\bentr(?:e|ée)e\b.*\b(au|a|à)\s+nord\b|\bentry\b.*\bnorth\b/i.test(rawText) ||
    /\bentrée\s+nord\b/i.test(rawText);

  const livingCenter =
    /\bs[ée]jour\b.*\b(au|a|à)\s+(le\s+)?centre\b|\bliving\b.*\b(center|centre)\b/i.test(rawText) ||
    /\bséjour\s+central\b/i.test(rawText);

  const livingSouth =
    /\b(s[ée]jour|sejour|salon|living)\b[\s\S]{0,40}\b(sud|south|façade\s+sud|facing\s+south)\b/i.test(rawText) ||
    /\bplein\s+sud\b/i.test(rawText);

  const kitchenEast = /\bcuisine\b.*\b(à|a|au)\s+l['’]?est\b|\bkitchen\b.*\beast\b/i.test(rawText);

  const bedroomsSouth =
    /\bchambres?\b.*\b(au|a|à)\s+sud\b|\bbedrooms?\b.*\bsouth\b/i.test(rawText) ||
    /\bchambres?\s+au\s+sud\b/i.test(rawText);

  
  const type = /\b(maison|house|villa)\b/.test(t) ? 'house' : /\b(appartement|apartment|flat)\b/.test(t) ? 'apartment' : 'unknown';
  const floors =
    maxAllIntMatches(rawText, /\b(\d{1,2})\s*(?:étages?|floors?)\b/gi) ??
    (/\br\+1\b/.test(t) ? 2 : /\br\+2\b/.test(t) ? 3 : /\bplain[-\s]?pied\b/.test(t) ? 1 : null);

  const bathrooms = maxAllIntMatches(rawText, /\b(\d{1,2})\s*(?:sdb|salles?\s+de\s+bain|bathrooms?)\b/gi) ?? (/\b(sdb|salle\s+de\s+bain|bathroom)\b/.test(t) ? 1 : 0);
  const wc = maxAllIntMatches(rawText, /\b(\d{1,2})\s*(?:wc|toilets?)\b/gi) ?? (/\b(wc|toilet)\b/.test(t) ? 1 : 0);

  const hasKitchen = boolFromRegex(t, /\b(cuisine|kitchen)\b/);
  const hasLiving = boolFromRegex(t, /\b(séjour|sejour|salon|living)\b/);
  const hasDining = boolFromRegex(t, /\b(salle\s+à\s+manger|dining)\b/);
  const hasOffice = boolFromRegex(t, /\b(bureau|office)\b/);
  const hasGarage = boolFromRegex(t, /\b(garage)\b/);
  const hasLaundry = boolFromRegex(t, /\b(buanderie|laundry)\b/);
  const hasStorage = boolFromRegex(t, /\b(cellier|rangement|storage|pantry)\b/);
  const hasEntry = boolFromRegex(t, /\b(entrée|entree|hall)\b/);
  const masterSuite = boolFromRegex(t, /\b(suite\s+parentale|master\s+bed(room)?|chambre\s+parentale)\b/);

  const roomCounts = {
    bedrooms: Math.max(0, Math.min(12, bedroomCount ?? (type === 'house' ? 3 : 2))),
    bathrooms: Math.max(0, Math.min(6, bathrooms)),
    wc: Math.max(0, Math.min(6, wc)),
    kitchen: hasKitchen ? 1 : 0,
    living: hasLiving ? 1 : 0,
    dining: hasDining ? 1 : 0,
    office: hasOffice ? 1 : 0,
    garage: hasGarage ? 1 : 0,
    laundry: hasLaundry ? 1 : 0,
    storage: hasStorage ? 1 : 0,
    entry: hasEntry ? 1 : 0,
  };

  const zones = {
    day: ['living', 'kitchen'].filter((z) => (z === 'living' ? roomCounts.living : roomCounts.kitchen)),
    night: roomCounts.bedrooms ? ['bedrooms'] : [],
    service: ['bathroom', 'wc', 'laundry', 'storage'].filter((z) => {
      if (z === 'bathroom') return roomCounts.bathrooms > 0;
      if (z === 'wc') return roomCounts.wc > 0;
      if (z === 'laundry') return roomCounts.laundry > 0;
      if (z === 'storage') return roomCounts.storage > 0;
      return false;
    }),
  };

  const constraints = {
    kitchen_near_living: true, 
    bathroom_near_bedrooms: roomCounts.bathrooms > 0 && roomCounts.bedrooms > 0,
    bedrooms_south: bedroomsSouth,
    entry_north: entryNorth,
    kitchen_east: kitchenEast,
    living_center: livingCenter,
    living_south: livingSouth,
    garage_connected_to_entry: roomCounts.garage > 0,
    minimize_circulation: wantsMinimizeCorridor || wantsNoDeadSpace,
    open_kitchen: wantsOpenKitchen,
    island: wantsIsland,
    master_suite: masterSuite,
  };

  
  const intent = {
    type,
    floors,
    dimensions,
    area_m2: Number.isFinite(Number(area_m2)) ? Number(area_m2) : null,
    roomCounts,
    specials: { masterSuite, wantsIsland, wantsOpenKitchen },
    zones,
    constraints,
    graph: buildSpatialGraphFromIntent({
      type,
      floors,
      dimensions,
      area_m2: Number.isFinite(Number(area_m2)) ? Number(area_m2) : null,
      roomCounts,
      specials: { masterSuite, wantsIsland, wantsOpenKitchen },
      zones,
      constraints,
      graph: { nodes: [], edges: [] },
    }),
  };

  return {
    rawText,
    intent,
    dimensions,
    bedroomCount,
    entryNorth,
    livingCenter,
    livingSouth,
    kitchenEast,
    bedroomsSouth,
    wantsCorridorDedicated,
    wantsMinimizeCorridor,
    wantsIsland,
    wantsOpenKitchen,
    wantsNoDeadSpace,
    strictBuildability,
  };
}


export function summarizeInterpreted(interpreted) {
  return {
    dimensions: interpreted.dimensions,
    bedroomCount: interpreted.bedroomCount,
    intent: {
      type: interpreted.intent?.type,
      floors: interpreted.intent?.floors,
      roomCounts: interpreted.intent?.roomCounts,
      zones: interpreted.intent?.zones,
      constraints: interpreted.intent?.constraints,
      graph: interpreted.intent?.graph,
    },
    zones: {
      entryNorth: interpreted.entryNorth,
      livingCenter: interpreted.livingCenter,
        livingSouth: interpreted.livingSouth,
      kitchenEast: interpreted.kitchenEast,
      bedroomsSouth: interpreted.bedroomsSouth,
    },
    flags: {
      wantsCorridorDedicated: interpreted.wantsCorridorDedicated,
      wantsMinimizeCorridor: interpreted.wantsMinimizeCorridor,
      wantsIsland: interpreted.wantsIsland,
      wantsOpenKitchen: interpreted.wantsOpenKitchen,
    },
  };
}
