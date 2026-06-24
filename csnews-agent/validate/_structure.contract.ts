/**
 * Structural contract tests — verify exported interfaces are stable.
 * If these break, the public API contract is violated.
 */
import { describe, it, expect } from 'vitest';
import * as score from '../src/score';
import * as classify from '../src/classify';
import * as pull from '../src/pull';
import * as dispatch from '../src/dispatch';

describe('score exports', () => {
  it('exports hashStr function', () => {
    expect(typeof score.hashStr).toBe('function');
  });
  it('exports scoreRule function', () => {
    expect(typeof score.scoreRule).toBe('function');
  });
  it('exports applyScore function', () => {
    expect(typeof score.applyScore).toBe('function');
  });
  it('exports AI_ROUTE_R_THRESHOLD constant', () => {
    expect(typeof score.AI_ROUTE_R_THRESHOLD).toBe('number');
  });
});

describe('classify exports', () => {
  it('exports classifyRule function', () => {
    expect(typeof classify.classifyRule).toBe('function');
  });
  it('exports classify function', () => {
    expect(typeof classify.classify).toBe('function');
  });
});

describe('pull exports', () => {
  it('exports TYPE_CONFIG', () => {
    expect(typeof pull.TYPE_CONFIG).toBe('object');
  });
  it('exports parseFilters function', () => {
    expect(typeof pull.parseFilters).toBe('function');
  });
  it('exports VALID_LEVELS', () => {
    expect(Array.isArray(pull.VALID_LEVELS)).toBe(true);
  });
  it('exports VALID_STAGES', () => {
    expect(Array.isArray(pull.VALID_STAGES)).toBe(true);
  });
});

describe('dispatch exports', () => {
  it('exports ALLOWED_ACTIONS array', () => {
    expect(Array.isArray(dispatch.ALLOWED_ACTIONS)).toBe(true);
    expect(dispatch.ALLOWED_ACTIONS.length).toBeGreaterThan(0);
  });
  it('exports dispatchAction function', () => {
    expect(typeof dispatch.dispatchAction).toBe('function');
  });
});
