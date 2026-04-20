export function roundToGrid(n, step) {
  return Math.round(n / step) * step;
}

function parseColorToHex(color, fallbackHex) {
  const c = String(color ?? '').trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(c);
  if (!m) return fallbackHex;
  return `#${m[1].toLowerCase()}`;
}


export function validateAndNormalizePlan2D(plan) {
  const errors = [];
  const layoutWarnings = [];

  const width_m = Number(plan?.width_m);
  const height_m = Number(plan?.height_m);

  if (!Number.isFinite(width_m) || width_m < 4 || width_m > 80) errors.push('width_m hors limites');
  if (!Number.isFinite(height_m) || height_m < 3 || height_m > 80) errors.push('height_m hors limites');

  const roomsRaw = Array.isArray(plan?.rooms) ? plan.rooms : null;
  if (!roomsRaw) errors.push('rooms manquante');

  const rooms = (roomsRaw || [])
    .map((r, idx) => {
      const name = String(r?.name ?? `Room ${idx + 1}`).trim();
      const x = Number(r?.x);
      const y = Number(r?.y);
      const w = Number(r?.w);
      const h = Number(r?.h);
      const color = parseColorToHex(r?.color, `#${((idx * 9973) ^ 0xabcdef).toString(16).slice(0, 6).padStart(6, '0').slice(0, 6)}`);
      return {
        name,
        x,
        y,
        w,
        h,
        color,
        ...(r?.id != null ? { id: r.id } : {}),
        ...(r?.type ? { type: r.type } : {}),
        ...(r?.openPlanWith ? { openPlanWith: r.openPlanWith } : {}),
        ...(r?.isAlcove ? { isAlcove: true } : {}),
      };
    })
    .filter((r) => r && r.name);

  if (rooms.length < 4 || rooms.length > 12) errors.push('nombre de rooms hors limites (4..12)');

  const step = 0.25;

  const normalizedRooms = rooms.map((r, idx) => {
    let x = r.x;
    let y = r.y;
    let w = r.w;
    let h = r.h;

    if (![x, y, w, h].every((n) => Number.isFinite(n))) {
      errors.push(`rooms[${idx}] coordonnées non numériques`);
      x = 0;
      y = 0;
      w = 1;
      h = 1;
    }

    x = roundToGrid(x, step);
    y = roundToGrid(y, step);
    w = roundToGrid(w, step);
    h = roundToGrid(h, step);

    if (w < 0.5 || h < 0.5) errors.push(`rooms[${idx}] w/h trop petit`);

    if (Number.isFinite(width_m)) {
      if (x < 0) errors.push(`rooms[${idx}] x < 0`);
      if (y < 0) errors.push(`rooms[${idx}] y < 0`);
      if (x + w > width_m + 1e-6) {
        layoutWarnings.push(`rooms[${idx}] x+w > width_m (sera corrigé par extension d'emprise)`);
      }
      if (y + h > height_m + 1e-6) {
        layoutWarnings.push(`rooms[${idx}] y+h > height_m (sera corrigé par extension d'emprise)`);
      }
    }

    return { ...r, x, y, w, h };
  });

  const tol = 1e-6;
  for (let i = 0; i < normalizedRooms.length; i++) {
    for (let j = i + 1; j < normalizedRooms.length; j++) {
      const a = normalizedRooms[i];
      const b = normalizedRooms[j];
      if (!a || !b) continue;

      const ax1 = a.x;
      const ay1 = a.y;
      const ax2 = a.x + a.w;
      const ay2 = a.y + a.h;

      const bx1 = b.x;
      const by1 = b.y;
      const bx2 = b.x + b.w;
      const by2 = b.y + b.h;

      const ox = Math.min(ax2, bx2) - Math.max(ax1, bx1);
      const oy = Math.min(ay2, by2) - Math.max(ay1, by1);

      if (ox > tol && oy > tol) {
        layoutWarnings.push(`rooms[${i}] chevauche rooms[${j}] (avertissement)`);
      }
    }
  }

  let outWidth_m = width_m;
  let outHeight_m = height_m;
  if (errors.length === 0 && normalizedRooms.length) {
    const extentW = Math.max(...normalizedRooms.map((r) => r.x + r.w));
    const extentH = Math.max(...normalizedRooms.map((r) => r.y + r.h));
    outWidth_m = roundToGrid(Math.max(width_m, extentW), step);
    outHeight_m = roundToGrid(Math.max(height_m, extentH), step);
    if (outWidth_m > width_m + 1e-6 || outHeight_m > height_m + 1e-6) {
      layoutWarnings.push(
        `Emprise ajustée: ${width_m}×${height_m} m → ${outWidth_m}×${outHeight_m} m pour englober la géométrie`
      );
    }
  }

  const doorsSegments = Array.isArray(plan?.doorsSegments) ? plan.doorsSegments : [];
  const windowsSegments = Array.isArray(plan?.windowsSegments) ? plan.windowsSegments : [];
  const openingsSegments = Array.isArray(plan?.openingsSegments) ? plan.openingsSegments : [];
  const transitionDashSegments = Array.isArray(plan?.transitionDashSegments) ? plan.transitionDashSegments : [];

  return {
    ok: errors.length === 0,
    errors,
    layoutWarnings,
    data:
      errors.length === 0
        ? {
            width_m: outWidth_m,
            height_m: outHeight_m,
            rooms: normalizedRooms,
            doorsSegments,
            windowsSegments,
            openingsSegments,
            transitionDashSegments,
            ...(plan?.meta != null ? { meta: plan.meta } : {}),
          }
        : null,
  };
}
