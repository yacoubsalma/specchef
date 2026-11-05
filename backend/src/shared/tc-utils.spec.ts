import { levenshtein, runWithConcurrency, safeParseJson } from './tc-utils';

describe('levenshtein', () => {
  it('vaut 0 pour deux chaînes identiques', () => {
    expect(levenshtein('login', 'login')).toBe(0);
  });

  it('calcule la distance d\'édition classique', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('gère les chaînes vides', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });
});

describe('safeParseJson', () => {
  it('parse un JSON valide', () => {
    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('retourne null pour une entrée vide', () => {
    expect(safeParseJson('')).toBeNull();
  });

  it('renvoie tel quel un objet déjà parsé', () => {
    const obj = { a: 1 };
    expect(safeParseJson(obj as any)).toBe(obj);
  });
});

describe('runWithConcurrency', () => {
  it('conserve l\'ordre des résultats', async () => {
    const delays = [30, 5, 15, 1];
    const tasks = delays.map((d, i) => async () => {
      await new Promise((r) => setTimeout(r, d));
      return i;
    });
    await expect(runWithConcurrency(tasks, 2)).resolves.toEqual([0, 1, 2, 3]);
  });

  it('ne dépasse pas la concurrence demandée', async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 8 }, () => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
    await runWithConcurrency(tasks, 3);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
