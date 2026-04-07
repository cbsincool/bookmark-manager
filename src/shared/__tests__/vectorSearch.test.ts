import { describe, it, expect } from 'vitest';
import { cosineSimilarity, findTopK, groupBySimilarity } from '../vectorSearch';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });
});

describe('findTopK', () => {
  it('returns top K results sorted by similarity', () => {
    const query = new Float32Array([1, 0, 0]);
    const candidates = [
      { id: 'a', vector: new Float32Array([1, 0, 0]) },
      { id: 'b', vector: new Float32Array([0, 1, 0]) },
      { id: 'c', vector: new Float32Array([0.9, 0.1, 0]) },
    ];
    const results = findTopK(query, candidates, 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('a');
    expect(results[1].id).toBe('c');
  });

  it('returns all if K > candidates length', () => {
    const query = new Float32Array([1, 0]);
    const candidates = [{ id: 'a', vector: new Float32Array([1, 0]) }];
    const results = findTopK(query, candidates, 5);
    expect(results).toHaveLength(1);
  });
});

describe('groupBySimilarity', () => {
  it('groups items above threshold', () => {
    const items = [
      { id: 'a', vector: new Float32Array([1, 0, 0]), score: 0.9 },
      { id: 'b', vector: new Float32Array([0.99, 0.01, 0]), score: 0.8 },
      { id: 'c', vector: new Float32Array([0, 1, 0]), score: 0.7 },
    ];
    const groups = groupBySimilarity(items, 0.85);
    expect(groups).toHaveLength(2); // group [a,b] and standalone [c]
    const bigGroup = groups.find((g) => g.length > 1);
    expect(bigGroup).toBeDefined();
    expect(bigGroup!.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('returns single-item groups when nothing is similar', () => {
    const items = [
      { id: 'x', vector: new Float32Array([1, 0, 0]), score: 1 },
      { id: 'y', vector: new Float32Array([0, 1, 0]), score: 1 },
    ];
    const groups = groupBySimilarity(items, 0.85);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.length === 1)).toBe(true);
  });
});
