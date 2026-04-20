

import { computeFootprintFromAreaM2 } from './floorPlanArchitectureGuide.js';






export const HARD_RULES = {
  minBedroomWidth_m: 3,
  wcMaxDepth_m: 2,
  minRoomDim_m: 0.5,
  kitchenOpenMin_m: 2.5,
};

export function minEnvelopeHeightForApartmentStack(intent) {
  
  const type = String(intent?.type || '').toLowerCase();
  if (type !== 'apartment' && type !== 'studio') return 0;

  const PRIVATE_RATIO = 0.38;
  const PUBLIC_RATIO = 0.42;

  const needHForLiving = 3.5 / PUBLIC_RATIO;
  const needHForBedMinDim = 2.5 / PRIVATE_RATIO;
  const h = Math.max(needHForLiving, needHForBedMinDim, 5);

  return Number.isFinite(h) ? h : 0;
}


export function applyConstraints(interpreted) {
  
  const overrides = [];
  const warnings = [];

  const step = 0.25;
  const round = (n) => Math.round(n / step) * step;

  let width_m = interpreted.dimensions?.width_m;
  let height_m = interpreted.dimensions?.height_m;
  const area_m2 = Number(interpreted?.intent?.area_m2);
  let userProvidedDims = interpreted.dimensions != null && Number.isFinite(Number(interpreted.dimensions?.width_m));
  let envelopeAdjustable = !userProvidedDims;
  
  if (
    Number.isFinite(area_m2) &&
    area_m2 >= 20 &&
    area_m2 <= 500 &&
    Number.isFinite(Number(width_m)) &&
    Number.isFinite(Number(height_m))
  ) {
    const curA = Number(width_m) * Number(height_m);
    if (curA > 0 && Math.abs(curA - area_m2) / area_m2 > 0.22) {
      userProvidedDims = false;
      envelopeAdjustable = true;
      width_m = undefined;
      height_m = undefined;
      overrides.push({
        kind: 'optimize',
        message: 'Surface (m²) prioritaire : dimensions incohérentes ignorées au profit du calcul depuis la surface.',
        detail: `attendu≈${area_m2} m², était≈${Math.round(curA * 10) / 10} m²`,
      });
    }
  }
  if (!Number.isFinite(width_m) || !Number.isFinite(height_m)) {
    if (Number.isFinite(area_m2) && area_m2 >= 20 && area_m2 <= 500) {
      const fp = computeFootprintFromAreaM2(area_m2);
      let w = fp.width_m;
      let h = fp.height_m;
      const bedN = Math.min(
        4,
        Math.max(
          1,
          Math.round(
            Number(interpreted?.bedroomCount ?? interpreted?.intent?.roomCounts?.bedrooms ?? 2)
          )
        )
      );
      const minWForBedLanes = round(Math.max(6, bedN * 2.5));
      const minHNeed = minEnvelopeHeightForApartmentStack(interpreted?.intent || interpreted);
      if (minHNeed > 0 && h + 1e-6 < minHNeed) h = round(minHNeed);
      w = round(area_m2 / Math.max(0.1, h));
      if (w + 1e-6 < minWForBedLanes) {
        w = minWForBedLanes;
        h = round(area_m2 / Math.max(0.1, w));
        if (minHNeed > 0 && h + 1e-6 < minHNeed) h = round(minHNeed);
      }
      w = round(Math.min(40, Math.max(6, w)));
      h = round(Math.min(40, Math.max(5, h)));
      width_m = w;
      height_m = h;
      overrides.push({
        kind: 'optimize',
        message: 'Dimensions déduites de la surface (m²) fournie.',
        detail: `${area_m2} m² → ${width_m}×${height_m} m (≈${Math.round(width_m * height_m * 10) / 10} m²)`,
      });
    } else {
      width_m = 10;
      height_m = 8;
      overrides.push({
        kind: 'clamp',
        message: 'Dimensions par défaut 10×8 m (non spécifiées ou invalides).',
      });
    }
  }

  width_m = round(Math.min(40, Math.max(6, width_m)));
  height_m = round(Math.min(40, Math.max(5, height_m)));

  if (interpreted.dimensions && (interpreted.dimensions.width_m !== width_m || interpreted.dimensions.height_m !== height_m)) {
    overrides.push({
      kind: 'clamp',
      message: 'Dimensions ajustées aux limites constructibles (6–40 m).',
      detail: `${interpreted.dimensions.width_m}×${interpreted.dimensions.height_m} → ${width_m}×${height_m}`,
    });
  }

  let bedroomCount = interpreted.bedroomCount ?? 3;
  bedroomCount = Math.min(4, Math.max(1, Math.round(bedroomCount)));
  if (interpreted.bedroomCount != null && interpreted.bedroomCount !== bedroomCount) {
    overrides.push({
      kind: 'clamp',
      message: 'Nombre de chambres borné (1–4) pour rester réaliste sur la surface.',
      detail: String(bedroomCount),
    });
  }

  
  if (interpreted.wantsCorridorDedicated && !interpreted.wantsMinimizeCorridor) {
    overrides.push({
      kind: 'reject_user_preference',
      message:
        'Un couloir linéaire dédié a été évité au profit d’une circulation par le séjour (meilleure surface utile).',
    });
  }

  if (interpreted.wantsNoDeadSpace) {
    warnings.push('Les espaces < 0,5 m ne sont pas modélisés comme pièces (règle anti-perte).');
  }

  const minArea_m2 = bedroomCount * (HARD_RULES.minBedroomWidth_m * HARD_RULES.minBedroomWidth_m) + 30;
  const curArea = width_m * height_m;
  if (userProvidedDims && Number.isFinite(curArea) && curArea < minArea_m2) {
    warnings.push(`Surface ${Math.round(curArea)} m² probablement insuffisante pour respecter tous les minimums stricts (min ~${Math.round(minArea_m2)} m²) sans modifier l'enveloppe.`);
  }

  const brief = {
    width_m,
    height_m,
    bedroomCount,
    envelopeAdjustable,
    minBedroomWidth_m: HARD_RULES.minBedroomWidth_m,
    wcMaxDepth_m: HARD_RULES.wcMaxDepth_m,
    minRoomDim_m: HARD_RULES.minRoomDim_m,
    kitchenOpenMin_m: HARD_RULES.kitchenOpenMin_m,
  };

  return { brief, overrides, warnings };
}


export function buildLLMConstraintFooter(brief) {
  return (
    '\n\n--- CONTRAINTES ARCHITECTURALES (non négociables) ---\n' +
    `- Chaque chambre: largeur ≥ ${brief.minBedroomWidth_m} m.\n` +
    `- WC: profondeur ≤ ${brief.wcMaxDepth_m} m (si présent).\n` +
    `- Pas de pièce « fantôme » < ${brief.minRoomDim_m} m; pas de couloir dédié inutile: préférer circulation par séjour.\n` +
    `- Cuisine ouverte sur séjour: liaison ≥ ${brief.kitchenOpenMin_m} m (ouverte ou très large passage).\n` +
    `- Surface totale: ${brief.width_m} m × ${brief.height_m} m.\n` +
    'Si le brief utilisateur contredit ces règles, ADAPTE le plan pour les respecter et explique implicitement par la géométrie (pas de commentaire dans le JSON).\n'
  );
}
