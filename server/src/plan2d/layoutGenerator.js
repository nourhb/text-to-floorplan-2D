

import { validateAndNormalizePlan2D, roundToGrid } from './plan2dValidation.js';


export function generateArchitectPlan(brief) {
  const step = 0.25;

  const W = roundToGrid(Math.min(40, Math.max(6, brief.width_m)), step);
  const H = roundToGrid(Math.min(40, Math.max(5, brief.height_m)), step);

  
  const northH = roundToGrid(H * (2.5 / 8), step);
  const southH = roundToGrid(H * (3 / 8), step);
  const midH = roundToGrid(H - northH - southH, step);
  const yMid = northH;
  const ySouth = northH + midH;

  
  const entryW = roundToGrid(W * 0.2, step);
  const kitchenW = roundToGrid(W * 0.3, step);
  const salonNorthW = roundToGrid(W - entryW - kitchenW, step);

  
  const sejourHubW = roundToGrid(W * 0.6, step);
  const wetW = roundToGrid(W - sejourHubW, step);

  
  const bathW = roundToGrid(wetW * (2.5 / 4), step);
  const wcColW = roundToGrid(wetW - bathW, step);
  const wcH = roundToGrid(Math.min(brief.wcMaxDepth_m, midH * 0.6), step);
  const buanderieH = roundToGrid(midH - wcH, step);

  
  const minB = roundToGrid(Math.max(brief.minBedroomWidth_m, 3), step);
  const bed1W = minB;
  const bed2W = minB;
  const bed3W = roundToGrid(W - bed1W - bed2W, step);

  const xWet = sejourHubW;
  const xBath = xWet;
  const xWcCol = xWet + bathW;

  
  const rooms = [
    { name: 'Entrée', x: 0, y: 0, w: entryW, h: northH, color: '#94a3b8' },
    { name: 'Cuisine', x: entryW, y: 0, w: kitchenW, h: northH, color: '#34d399' },
    { name: 'Salon', x: entryW + kitchenW, y: 0, w: salonNorthW, h: northH, color: '#60a5fa' },

    { name: 'Séjour', x: 0, y: yMid, w: sejourHubW, h: midH, color: '#3b82f6' },
    { name: 'Salle de bain', x: xBath, y: yMid, w: bathW, h: midH, color: '#a78bfa' },
    { name: 'WC', x: xWcCol, y: yMid, w: wcColW, h: wcH, color: '#f97316' },
    { name: 'Buanderie', x: xWcCol, y: yMid + wcH, w: wcColW, h: buanderieH, color: '#94a3b8' },

    { name: 'Chambre 1', x: 0, y: ySouth, w: bed1W, h: southH, color: '#f59e0b' },
    { name: 'Chambre 2', x: bed1W, y: ySouth, w: bed2W, h: southH, color: '#f59e0b' },
    { name: 'Chambre 3', x: bed1W + bed2W, y: ySouth, w: bed3W, h: southH, color: '#ea580c' },
  ];

  const doors = [];

  const draft = { width_m: W, height_m: H, rooms, doors };
  const ok = validateAndNormalizePlan2D(draft);
  if (ok.ok) return { ...ok.data, doors };
  console.warn('[plan2d] architect plan v33 invalid -> fallback. errors=', ok.errors);
  return ok.data || { width_m: W, height_m: H, rooms: rooms.slice(0, 10), doors };
}
