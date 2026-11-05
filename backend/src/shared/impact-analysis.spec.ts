import {
  cosineSimilarity,
  IMPACT_CHANGE_THRESHOLD,
  IMPACT_COUPLING_THRESHOLD,
} from './impact-analysis';

describe('cosineSimilarity', () => {
  it('vaut 1 pour deux vecteurs identiques', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('vaut 1 pour deux vecteurs colinéaires', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('vaut 0 pour deux vecteurs orthogonaux', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('vaut -1 pour deux vecteurs opposés', () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10);
  });

  it('retourne 0 si les dimensions diffèrent', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it('retourne 0 pour des vecteurs vides ou nuls', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('seuils d\'analyse d\'impact', () => {
  it('le seuil de couplage est inférieur au seuil de changement', () => {
    expect(IMPACT_COUPLING_THRESHOLD).toBeLessThan(IMPACT_CHANGE_THRESHOLD);
  });

  it('les seuils sont des similarités valides (entre 0 et 1)', () => {
    for (const t of [IMPACT_CHANGE_THRESHOLD, IMPACT_COUPLING_THRESHOLD]) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
  });
});
