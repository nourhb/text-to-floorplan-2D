import { roundToGrid, validateAndNormalizePlan2D } from './plan2dValidation.js';
import { placeRooms } from './placeRooms.js';

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function pickCount(v, def, lo, hi) {
  const n = Number.isFinite(Number(v)) ? Math.round(Number(v)) : def;
  return clamp(n, lo, hi);
}


export function generatePlanFromIntent(intent, brief) {
  const step = 0.25;
  const round = (n) => roundToGrid(n, step);

  let W = round(clamp(brief.width_m, 6, 40));
  let H = round(clamp(brief.height_m, 5, 40));

  const type = String(intent?.type || '').toLowerCase();
  if (type === 'apartment' || type === 'studio') {
    return generateApartmentPlanFromIntent(intent, { ...brief, width_m: W, height_m: H });
  }

  
  
  
  
  
  
  
  

  const counts = intent?.roomCounts || {};
  const bedrooms = pickCount(counts.bedrooms, brief.bedroomCount ?? 3, 1, 4);
  let bathrooms = pickCount(counts.bathrooms, 1, 0, 2);
  const wc = pickCount(counts.wc, 1, 0, 2);
  const garage = pickCount(counts.garage, 0, 0, 1);
  const laundry = pickCount(counts.laundry, 0, 0, 1);
  const wcNearEntry = intent?.constraints?.wc_near_entry !== false;
  const wcNotVisible = intent?.constraints?.wc_not_visible !== false;
  const storage = pickCount(counts.storage, 1, 0, 2);

  
  if (bedrooms > 0 && bathrooms === 0) bathrooms = 1;

  
  const rooms = [];

  
  const hasService = Boolean(garage || laundry || storage);
  
  const maxServiceW = round(Math.max(0, W - 7.5)); 
  const serviceW =
    hasService && maxServiceW >= 2.6
      ? round(clamp(W * 0.22, 2.6, Math.min(3.25, maxServiceW)))
      : 0;
  
  
  
  
  const privMinWStrict = 2.5;
  const livingMinWStrict = 3.5;
  const kitchenMinWStrict = 2.4;
  const minMainWStrict = round(privMinWStrict + livingMinWStrict + kitchenMinWStrict);

  
  const computeMainW = () => {
    const mw0 = round(W - serviceW);
    return mw0 < minMainWStrict ? round(W) : mw0;
  };
  let mainW = computeMainW();
  const xService = mainW;

  
  
  
  
  
  
  

  const entryH = round(2.0);
  let liveZoneH = round(H - entryH);

  
  const livingMinW = livingMinWStrict;
  let liveW = round(Math.max(livingMinW, mainW * 0.42));
  const privMinW2 = privMinWStrict;
  const minLiveW2 = round(livingMinWStrict + kitchenMinWStrict);
  const maxLiveW2 = round(Math.max(minLiveW2, mainW - privMinW2));
  liveW = round(clamp(liveW, minLiveW2, maxLiveW2));
  let privW = round(Math.max(privMinW2, mainW - liveW));
  liveW = round(mainW - privW);

  
  const bathH = bathrooms ? round(clamp(2.25, 2.0, 2.75)) : 0;
  const privX0 = 0;
  const privW2 = privW;

  
  
  const bedMin = 2.5;
  
  const requiredPrivW = round(bathH > 0 ? Math.max(privMinW2, privMinWStrict) : privMinWStrict);
  const availableForLiving = round(mainW - requiredPrivW);
  const livingZoneMinTotal = round(livingMinWStrict + kitchenMinWStrict);
  if (privW + 1e-6 < requiredPrivW && availableForLiving + 1e-6 >= livingZoneMinTotal) {
    privW = requiredPrivW;
    liveW = round(mainW - privW);
  }
  
  if (privW + 1e-6 < requiredPrivW) {
    const needW = round(requiredPrivW + livingZoneMinTotal + serviceW);
    W = round(Math.min(40, Math.max(W, needW)));
    mainW = computeMainW();
    liveW = round(clamp(Math.max(livingMinW, mainW * 0.42), minLiveW2, maxLiveW2));
    privW = round(Math.max(requiredPrivW, mainW - liveW));
    liveW = round(mainW - privW);
  }

  
  
  {
    const minHNeed = round(entryH + bathH + bedrooms * bedMin);
    if (H + 1e-6 < minHNeed) {
      H = round(Math.min(40, Math.max(H, minHNeed)));
      liveZoneH = round(H - entryH);
    }
  }

  
  mainW = computeMainW();

  
  const kitchenMinW = kitchenMinWStrict;
  const livingHubW = round(clamp(liveW * 0.62, livingMinWStrict, Math.max(livingMinWStrict, liveW - kitchenMinW)));
  const kitchenW = round(clamp(liveW - livingHubW, kitchenMinW, Math.max(kitchenMinW, liveW - livingMinWStrict)));

  
  const livingX = privW;
  const kitchenX = round(privW + livingHubW);
  
  const kitchenW2 = round(Math.max(0.5, Math.min(kitchenW, mainW - kitchenX)));
  rooms.push({ name: 'Séjour', x: livingX, y: 0, w: livingHubW, h: liveZoneH, color: '#60a5fa' });
  rooms.push({ name: 'Cuisine', x: kitchenX, y: 0, w: kitchenW2, h: liveZoneH, color: '#34d399' });
  rooms.push({ name: 'Entrée', x: privW, y: liveZoneH, w: livingHubW, h: entryH, color: '#94a3b8' });

  
  if (wc && wcNearEntry) {
    const wcW = round(1.5);
    const wcX = round(privW - wcW);
    rooms.push({ name: 'WC', x: wcX, y: liveZoneH, w: wcW, h: entryH, color: '#f97316' });
  }

  const privW2b = round(privW);
  if (bathrooms) rooms.push({ name: 'Salle de bain', x: privX0, y: 0, w: privW2b, h: bathH, color: '#a78bfa' });

  const bedAreaY0 = bathH;
  const bedAreaH = round(liveZoneH - bedAreaY0);
  const bedEachH = round(bedAreaH / bedrooms);
  for (let i = 0; i < bedrooms; i++) {
    const y = round(bedAreaY0 + i * bedEachH);
    const h = i === bedrooms - 1 ? round(liveZoneH - y) : bedEachH;
    rooms.push({ name: `Chambre ${i + 1}`, x: privX0, y, w: privW2b, h, color: '#f59e0b' });
  }

  
  const openingsSegments = [];
  
  const ox = round(privW + livingHubW);
  const oy1 = 0.05;
  const oy2 = round(liveZoneH - 0.05);
  if (oy2 > oy1 + 0.2) openingsSegments.push({ segment: { x1: ox, y1: oy1, x2: ox, y2: oy2 } });

  
  if (serviceW) {
    
    let y = 0;
    if (garage) {
      const gH = round(Math.max(2.75, H * 0.33));
      rooms.push({ name: 'Garage', x: xService, y, w: serviceW, h: gH, color: '#64748b' });
      y = round(y + gH);
    }
    if (laundry) {
      const lH = round(Math.max(1.5, Math.min(2.25, H - y - 1.25)));
      rooms.push({ name: 'Buanderie', x: xService, y, w: serviceW, h: lH, color: '#94a3b8' });
      y = round(y + lH);
    }
    
    const rem = round(Math.max(1.25, H - y));
    rooms.push({ name: 'Cellier', x: xService, y, w: serviceW, h: rem, color: '#94a3b8' });
  }

  const draft = { width_m: W, height_m: H, rooms, openingsSegments };
  const ok = validateAndNormalizePlan2D(draft);
  if (ok.ok) return ok.data;
  
  return draft;

}

function generateApartmentPlanFromIntent(intent, brief) {
  const step = 0.25;
  const round = (n) => roundToGrid(n, step);
  const W = round(clamp(brief.width_m, 5, 30));
  const H = round(clamp(brief.height_m, 5, 30));

  const counts = intent?.roomCounts || {};
  const bedrooms = pickCount(counts.bedrooms, 1, 0, 3);
  let bathrooms = pickCount(counts.bathrooms, 1, 0, 2);
  const wc = pickCount(counts.wc, 1, 0, 2);
  const laundry = pickCount(counts.laundry, 0, 0, 2);
  const storage = pickCount(counts.storage, 0, 0, 2);

  if (bedrooms > 0 && bathrooms === 0) bathrooms = 1;

  const openPlanRequested = intent?.specials?.wantsOpenKitchen !== false;

  
  const spec = [];
  let idn = 1;
  const nid = () => `r${idn++}`;
  for (let i = 0; i < bedrooms; i++) {
    spec.push({ id: nid(), type: 'bedroom', label: `Chambre ${i + 1}` });
  }
  if (bathrooms) spec.push({ id: nid(), type: 'bathroom', label: 'Salle de bain' });
  if (wc) spec.push({ id: nid(), type: 'wc', label: 'WC' });
  spec.push({ id: nid(), type: 'entry', label: 'Entrée' });
  spec.push({ id: nid(), type: 'corridor', label: 'Dégagement' });
  if (laundry) spec.push({ id: nid(), type: 'laundry', label: 'Buanderie' });
  spec.push({ id: nid(), type: 'living_room', label: 'Séjour' });
  spec.push({ id: nid(), type: 'kitchen', label: 'Cuisine' });

  const placed = placeRooms({
    rooms: spec,
    totalWidth: W,
    totalHeight: H,
    openPlanRequested,
  });

  const color = (type) => {
    const m = {
      bedroom: '#f59e0b',
      master_bedroom: '#f59e0b',
      bathroom: '#a78bfa',
      wc: '#f97316',
      entry: '#94a3b8',
      corridor: '#cbd5e1',
      laundry: '#94a3b8',
      living_room: '#60a5fa',
      kitchen: '#34d399',
      storage: '#94a3b8',
    };
    return m[type] || '#94a3b8';
  };

  
  const rooms = placed.rooms.map((r) => {
    const o = {
      name: r.label,
      id: r.id,
      type: r.type,
      x: round(r.x),
      y: round(r.y),
      w: round(r.width),
      h: round(r.height),
      color: color(r.type),
    };
    if (r.openPlanWith) o.openPlanWith = r.openPlanWith;
    if (r.isAlcove) o.isAlcove = true;
    return o;
  });

  
  const openingsSegments = [];
  if (placed.openingsSegment) openingsSegments.push(placed.openingsSegment);

  const transitionDashSegments = placed.transitionDashSegment ? [placed.transitionDashSegment] : [];

  const draft = {
    width_m: W,
    height_m: H,
    rooms,
    openingsSegments,
    transitionDashSegments,
    meta: { placement: 'placeRooms_v1', violations: placed.violations },
  };
  const ok = validateAndNormalizePlan2D(draft);
  if (ok.ok) return ok.data;
  return draft;
}

