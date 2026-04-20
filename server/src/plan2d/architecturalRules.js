

function n(v) {
  return Number(v);
}

function area(r) {
  return n(r.w) * n(r.h);
}

function cx(r) {
  return n(r.x) + n(r.w) / 2;
}

function cy(r) {
  return n(r.y) + n(r.h) / 2;
}

function dist(a, b) {
  const dx = cx(a) - cx(b);
  const dy = cy(a) - cy(b);
  return Math.sqrt(dx * dx + dy * dy);
}

function isName(r, keys) {
  const s = String(r?.name || '').toLowerCase();
  return keys.some((k) => s.includes(k));
}

function classifyRoom(r) {
  const s = String(r?.name || '').toLowerCase();
  if (s.includes('séjour') || s.includes('sejour') || s.includes('salon') || s.includes('living')) return 'living';
  if (s.includes('cuisine')) return 'kitchen';
  if (s.includes('salle à manger') || s.includes('salle a manger') || s.includes('dining')) return 'dining';
  if (s.includes('chambre') || s.includes('bed')) return 'bedroom';
  if (s.includes('suite')) return 'bedroom';
  if (s.includes('salle de bain') || s.includes('bain') || s.includes('bath')) return 'bathroom';
  if (/\bwc\b/.test(s) || s.includes('toilet')) return 'wc';
  if (s.includes('buanderie') || s.includes('laundry')) return 'laundry';
  if (s.includes('cellier') || s.includes('rangement') || s.includes('storage') || s.includes('pantry')) return 'storage';
  if (s.includes('entrée') || s.includes('entree') || s.includes('hall')) return 'entry';
  if (s.includes('garage')) return 'garage';
  if (s.includes('bureau') || s.includes('office')) return 'office';
  return 'other';
}

function zoneForType(t) {
  if (t === 'living' || t === 'kitchen' || t === 'dining') return 'day';
  if (t === 'bedroom') return 'night';
  if (t === 'bathroom' || t === 'wc' || t === 'laundry' || t === 'storage' || t === 'garage') return 'service';
  if (t === 'entry') return 'day'; 
  return 'other';
}


export function validateArchitecturalRules(plan, intent = null) {
  
  const warnings = [];
  const enforced = [];
  const notModeled = [];

  const W = Number(plan?.width_m);
  const H = Number(plan?.height_m);
  const rooms = Array.isArray(plan?.rooms) ? plan.rooms : [];

  const byType = new Map();
  for (const r of rooms) {
    const t = classifyRoom(r);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }

  
  enforced.push('dimensions: bedroom>=2.5m minDim and ~7.5m² (compact allowed)');
  for (const r of rooms) {
    const t = classifyRoom(r);
    const w = Number(r.w);
    const h = Number(r.h);
    if (t === 'bedroom') {
      if (Math.min(w, h) < 2.5 - 1e-6) warnings.push(`Bedroom too narrow: "${r.name}" minDim=${Math.min(w, h)}m (<2.5m)`);
      if (area(r) < 7.5 - 1e-6) warnings.push(`Bedroom area too small: "${r.name}" area=${area(r)}m² (<7.5m²)`);
    }
    if (t === 'kitchen') {
      if (Math.min(w, h) < 2.4 - 1e-6) warnings.push(`Kitchen too narrow: "${r.name}" minDim=${Math.min(w, h)}m (<2.4m)`);
    }
    if (t === 'living') {
      if (Math.min(w, h) < 3.5 - 1e-6) warnings.push(`Living too narrow: "${r.name}" minDim=${Math.min(w, h)}m (<3.5m)`);
    }
    if (t === 'bathroom') {
      const minDim = Math.min(w, h);
      const maxDim = Math.max(w, h);
      if (minDim < 1.8 - 1e-6 || maxDim < 2.2 - 1e-6) warnings.push(`Bathroom too small: "${r.name}" ${w}x${h}m (<1.8x2.2m)`);
    }
    if (t === 'wc') {
      
      
      
      const minDim = Math.min(w, h);
      const maxDim = Math.max(w, h);
      if (minDim < 0.8 - 1e-6 || maxDim > 2.6 + 1e-6) warnings.push(`WC footprint unrealistic: "${r.name}" ${w}x${h}m`);
    }
  }

  
  enforced.push('zoning: day/night/service coherent (no random mixing)');
  const dayRooms = rooms.filter((r) => zoneForType(classifyRoom(r)) === 'day');
  const nightRooms = rooms.filter((r) => zoneForType(classifyRoom(r)) === 'night');
  const serviceRooms = rooms.filter((r) => zoneForType(classifyRoom(r)) === 'service');

  function avgPairDist(list) {
    if (list.length < 2) return 0;
    let s = 0;
    let c = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        s += dist(list[i], list[j]);
        c++;
      }
    }
    return c ? s / c : 0;
  }

  const diag = Math.sqrt(W * W + H * H) || 1;
  const daySpread = avgPairDist(dayRooms) / diag;
  const nightSpread = avgPairDist(nightRooms) / diag;
  const serviceSpread = avgPairDist(serviceRooms) / diag;
  if (dayRooms.length >= 2 && daySpread > 0.65) warnings.push('DAY zone is spatially scattered (should be coherent).');
  if (nightRooms.length >= 2 && nightSpread > 0.65) warnings.push('NIGHT zone is spatially scattered (bedrooms should be grouped).');
  if (serviceRooms.length >= 2 && serviceSpread > 0.7) warnings.push('SERVICE zone is spatially scattered (wet rooms should be compact).');

  
  enforced.push('relationships: kitchen near living; bathroom near bedrooms; WC near entry; wet rooms grouped');
  const living = (byType.get('living') || [])[0];
  const kitchen = (byType.get('kitchen') || [])[0];
  if (living && kitchen) {
    if (dist(living, kitchen) / diag > 0.55) warnings.push('Kitchen too far from Living (should be connected/open).');
  } else {
    warnings.push('Missing living or kitchen.');
  }

  const bedroomsList = byType.get('bedroom') || [];
  const bathroom = (byType.get('bathroom') || [])[0];
  if (bathroom && bedroomsList.length) {
    const minBedDist = Math.min(...bedroomsList.map((b) => dist(b, bathroom)));
    if (minBedDist / diag > 0.6) warnings.push('Bathroom too far from bedrooms.');
  }

  const entry = (byType.get('entry') || [])[0];
  const wcRoom = (byType.get('wc') || [])[0];
  if (intent?.constraints?.wc_near_entry) {
    if (!entry || !wcRoom) warnings.push('WC near entry requested but Entry or WC missing.');
    else if (dist(entry, wcRoom) / diag > 0.35) warnings.push('WC is not near Entry (guest access).');
  }

  
  
  if (intent?.constraints?.wc_not_visible) {
    const wcList = byType.get('wc') || [];
    for (const w of wcList) {
      if (Number(w?.y) <= 0.01) warnings.push('WC placed on entrance line (visibility proxy).');
    }
  }

  if (intent?.constraints?.laundry_near_garage) {
    const garage = (byType.get('garage') || [])[0];
    const laundry = (byType.get('laundry') || [])[0];
    
    
    if (!garage || !laundry) {
      notModeled.push('laundry_near_garage (garage/laundry not modeled in current solver)');
    } else if (dist(garage, laundry) / diag > 0.35) warnings.push('Laundry is not near Garage.');
  }

  
  notModeled.push('doors & access flow (no door graph in model)');
  notModeled.push('window/light/ventilation (no opening data in model)');
  notModeled.push('visual privacy rays from entrance (no visibility model)');
  notModeled.push('door collisions/swing ergonomics (no door geometry)');

  return {
    ok: true,
    
    errors: warnings,
    warnings,
    checks: { enforced, notModeled },
  };
}

