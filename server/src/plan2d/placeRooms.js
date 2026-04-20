

function snap(n, step = 0.25) {
  return Math.round(n / step) * step;
}

const MIN_SIZES = {
  bedroom: 9,
  master_bedroom: 12,
  living_room: 12,
  kitchen: 5,
  bathroom: 3.5,
  wc: 1.2,
  entry: 2,
  corridor: 1.5,
  laundry: 0.8,
  dining_room: 8,
  dressing: 5,
};


export function getBandRatios(totalWidth, totalHeight) {
  const tw = Number(totalWidth);
  const th = Number(totalHeight);
  if (!Number.isFinite(tw) || !Number.isFinite(th) || th <= 0) {
    return { private: 0.38, circ: 0.2, public: 0.42 };
  }
  const ratio = tw / th;
  if (ratio > 1.4) return { private: 0.4, circ: 0.2, public: 0.4 };
  if (ratio > 1.1) return { private: 0.38, circ: 0.22, public: 0.4 };
  return { private: 0.36, circ: 0.26, public: 0.38 };
}


export function calcCircBandWidths(totalWidth) {
  const W = Number(totalWidth);
  const FRACTIONS = {
    bathroom: 0.32,
    corridor: 0.18,
    entryColumn: 0.5,
  };

  let sdbW = W * FRACTIONS.bathroom;
  let corrW = W * FRACTIONS.corridor;
  let entColW = W * FRACTIONS.entryColumn;

  sdbW = Math.max(sdbW, 2.0);
  entColW = Math.max(entColW, 1.5);
  corrW = W - sdbW - entColW;

  if (corrW < 0.9) {
    const deficit = 0.9 - corrW;
    entColW -= deficit * 0.55;
    sdbW -= deficit * 0.45;
    corrW = 0.9;
  }

  const total = sdbW + corrW + entColW;
  if (Math.abs(total - W) > 0.01) {
    corrW += W - total;
  }

  const xSdb = 0;
  const xCorr = xSdb + sdbW;
  const xEntCol = xCorr + corrW;

  return {
    bathroom: { x: xSdb, w: sdbW },
    corridor: { x: xCorr, w: corrW },
    entryColumn: { x: xEntCol, w: entColW },
    wc: { x: xEntCol, w: entColW },
    entry: { x: xEntCol, w: entColW },
  };
}


export function placeRooms(input) {
  const totalWidth = Number(input.totalWidth);
  const totalHeight = Number(input.totalHeight);
  const openPlanRequested = input.openPlanRequested !== false;

  const rooms = (input.rooms || []).map((r) => ({
    ...r,
    x: undefined,
    y: undefined,
    width: undefined,
    height: undefined,
  }));

  if (process.env.DEBUG_PLACER === '1') {
    const br = rooms.filter((r) => r.type === 'bedroom' || r.type === 'master_bedroom');
    console.log('BEDROOM PLACEMENT DEBUG:', {
      totalWidth,
      totalHeight,
      bedroomCount: br.length,
      privateH: totalHeight * 0.38,
      bedroomW: br.length ? totalWidth / br.length : null,
      expectedArea: br.length ? (totalWidth / br.length) * (totalHeight * 0.38) : null,
    });
  }

  const privateTypes = ['bedroom', 'master_bedroom', 'bathroom', 'wc', 'dressing'];
  const publicTypes = ['living_room', 'kitchen', 'dining_room', 'open_plan'];
  const serviceTypes = ['laundry', 'storage', 'garage', 'boiler_room'];

  const privateRooms = rooms.filter((r) => privateTypes.includes(r.type));
  const publicRooms = rooms.filter((r) => publicTypes.includes(r.type));
  void publicRooms;
  void serviceTypes;

  const br = getBandRatios(totalWidth, totalHeight);
  const privateH = snap(totalHeight * br.private);
  const circH = snap(totalHeight * br.circ);
  const publicH = snap(totalHeight - privateH - circH);

  const privateY = 0;
  const circY = privateH;
  const publicY = privateH + circH;

  const bedroomRooms = privateRooms.filter((r) => r.type === 'bedroom' || r.type === 'master_bedroom');
  const nBed = Math.max(1, bedroomRooms.length);
  const bedroomW = totalWidth / nBed;

  bedroomRooms.forEach((room, i) => {
    room.x = snap(i * bedroomW);
    room.y = snap(privateY);
    room.width = snap(i === nBed - 1 ? totalWidth - room.x : bedroomW);
    room.height = snap(privateH);
  });

  if (process.env.DEBUG_PLACER === '1') {
    bedroomRooms.forEach((room) => {
      const w = Number(room.width);
      const h = Number(room.height);
      if (w < 2.5) console.warn(`ASSERT width ${room.label}: ${w} < 2.5m`);
      if (h < 2.5) console.warn(`ASSERT height ${room.label}: ${h} < 2.5m`);
      if (w * h < 9) console.warn(`ASSERT area ${room.label}: ${w * h} < 9m²`);
    });
  }

  const laundry = rooms.find((r) => r.type === 'laundry');
  const strip = calcCircBandWidths(totalWidth);
  let sdbW0 = strip.bathroom.w;
  let corrW0 = strip.corridor.w;

  let alcW = 0;
  if (laundry) {
    alcW = snap(Math.min(1.0, Math.max(0, corrW0 - 0.9)));
    corrW0 -= alcW;
  }

  const sdb = rooms.find((r) => r.type === 'bathroom');
  if (sdb) {
    sdb.x = 0;
    sdb.y = snap(circY);
    sdb.width = snap(sdbW0);
    sdb.height = snap(circH);
  }

  if (laundry) {
    laundry.x = snap(sdbW0);
    laundry.y = snap(circY);
    laundry.width = snap(alcW);
    const maxH = Math.min(circH * 0.5, 1.0);
    const minHForArea = MIN_SIZES.laundry / Math.max(Number(laundry.width), 0.25);
    laundry.height = snap(Math.max(Math.min(maxH, 1.0), minHForArea));
    laundry.isAlcove = true;
  }

  const corridor = rooms.find((r) => r.type === 'corridor');
  if (corridor) {
    corridor.x = snap(sdbW0 + alcW);
    corridor.y = snap(circY);
    corridor.width = snap(corrW0);
    corridor.height = snap(circH);
  }

  const xEntryZone = snap(sdbW0 + alcW + corrW0);
  const ENTRY_W = snap(totalWidth - xEntryZone);

  const wcRoom = rooms.find((r) => r.type === 'wc');
  const entry = rooms.find((r) => r.type === 'entry');

  let wcHeight = Math.min(1.8, Number(circH) * 0.7);
  wcHeight = Math.min(wcHeight, Math.max(1.0, Number(circH) - 0.75));
  wcHeight = Math.min(wcHeight, 1.2);
  wcHeight = snap(wcHeight);
  if (wcRoom && entry) {
    wcHeight = snap(Math.min(wcHeight, circH - 0.5));
  } else if (wcRoom) {
    wcHeight = snap(circH);
  }

  if (wcRoom) {
    wcRoom.x = xEntryZone;
    wcRoom.y = snap(circY);
    wcRoom.width = ENTRY_W;
    wcRoom.height = entry ? wcHeight : snap(circH);
  }

  if (entry) {
    entry.x = xEntryZone;
    entry.width = ENTRY_W;
    if (wcRoom) {
      entry.y = snap(circY + wcRoom.height);
      entry.height = snap(circH - wcRoom.height);
    } else {
      entry.y = snap(circY);
      entry.height = snap(circH);
    }
  }

  const MAX_ENTRY_M2 = 4;
  if (entry && wcRoom && entry.width * entry.height > MAX_ENTRY_M2) {
    const targetH = MAX_ENTRY_M2 / Math.max(entry.width, 0.25);
    const freed = entry.height - snap(targetH);
    if (freed > 0) {
      entry.height = snap(targetH);
      wcRoom.height = snap(wcRoom.height + freed);
      entry.y = snap(circY + wcRoom.height);
    }
  }

  if (process.env.DEBUG_PLACER === '1' && entry) {
    console.log('Entry area (m²):', (entry.width * entry.height).toFixed(2), 'wc h:', wcRoom?.height, 'entry:', entry);
  }

  const isOpenPlan =
    rooms.some((r) => r.type === 'open_plan') ||
    (rooms.some((r) => r.type === 'living_room') &&
      rooms.some((r) => r.type === 'kitchen') &&
      openPlanRequested);

  const living = rooms.find((r) => r.type === 'living_room');
  const kitchen = rooms.find((r) => r.type === 'kitchen');
  const dining = rooms.find((r) => r.type === 'dining_room');

  if (isOpenPlan && living && kitchen) {
    const lw = snap(totalWidth * 0.55);
    living.x = 0;
    living.y = snap(publicY);
    living.width = lw;
    living.height = snap(publicH);
    living.openPlanWith = kitchen.id;
    kitchen.x = living.x + living.width;
    kitchen.y = snap(publicY);
    kitchen.width = snap(totalWidth - kitchen.x);
    kitchen.height = snap(publicH);
    kitchen.openPlanWith = living.id;
  } else if (living && kitchen) {
    const lw = snap(totalWidth * 0.55);
    living.x = 0;
    living.y = snap(publicY);
    living.width = lw;
    living.height = snap(publicH);
    kitchen.x = living.x + living.width;
    kitchen.y = snap(publicY);
    kitchen.width = snap(totalWidth - kitchen.x);
    kitchen.height = snap(publicH);
  }

  if (dining && living && kitchen && !isOpenPlan) {
    living.width = snap(totalWidth * 0.4);
    dining.x = snap(totalWidth * 0.4);
    dining.y = snap(publicY);
    dining.width = snap(totalWidth * 0.25);
    dining.height = snap(publicH);
    kitchen.x = snap(totalWidth * 0.65);
    kitchen.y = snap(publicY);
    kitchen.width = snap(totalWidth - kitchen.x);
    kitchen.height = snap(publicH);
  }

  const violations = [];
  rooms.forEach((room) => {
    const w = Number(room.width);
    const h = Number(room.height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    const area = w * h;
    const min = MIN_SIZES[room.type];
    if (min != null && area < min - 1e-6) {
      violations.push({
        room: room.label || room.id,
        actual: area.toFixed(1),
        minimum: min,
      });
    }
  });

  let openingsSegment = null;
  let transitionDashSegment = null;
  if (isOpenPlan && living && kitchen && living.openPlanWith === kitchen.id) {
    const ox = snap(Number(living.x) + Number(living.width));
    const oy1 = snap(publicY + 0.05);
    const oy2 = snap(publicY + publicH - 0.05);
    openingsSegment = { segment: { x1: ox, y1: oy1, x2: ox, y2: oy2 } };
    transitionDashSegment = { segment: { x1: ox, y1: oy1, x2: ox, y2: oy2 } };
  }

  if (process.env.DEBUG_PLACER === '1') {
    const ec = strip.entryColumn || strip.entry;
    console.log('FOOTPRINT:', {
      totalWidth,
      totalHeight,
      stripSum: strip.bathroom.w + strip.corridor.w + ec.w,
    });
  }

  return { rooms, violations, openingsSegment, transitionDashSegment, isOpenPlan };
}
