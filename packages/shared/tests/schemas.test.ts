import { describe, expect, it } from 'vitest';
import {
  displayNameSchema,
  gameCodeSchema,
  joinGameSchema,
  normalizeGameCode,
} from '../src/index';

describe('gameCodeSchema', () => {
  it('normaliza códigos escritos con espacios, guiones o minúsculas', () => {
    expect(gameCodeSchema.parse(' ab-cdJ ')).toBe('ABCDJ');
  });

  it('rechaza caracteres fuera del alfabeto (1, 0, I, L…)', () => {
    expect(gameCodeSchema.safeParse('ABCD1').success).toBe(false);
    expect(gameCodeSchema.safeParse('ABC0J').success).toBe(false);
  });
});

describe('displayNameSchema', () => {
  it('recorta espacios y colapsa los internos', () => {
    expect(displayNameSchema.parse('  Ada   Lovelace  ')).toBe('Ada Lovelace');
  });

  it('rechaza nombres demasiado cortos o largos', () => {
    expect(displayNameSchema.safeParse('A').success).toBe(false);
    expect(displayNameSchema.safeParse('x'.repeat(21)).success).toBe(false);
  });
});

describe('normalizeGameCode', () => {
  it('marca como válido solo el formato exacto de 5 caracteres del alfabeto', () => {
    expect(normalizeGameCode('abcdj')).toEqual({ value: 'ABCDJ', looksValid: true });
    // I/L/0/1 no forman parte del alfabeto visible.
    expect(normalizeGameCode('ABCI1').looksValid).toBe(false);
    expect(normalizeGameCode('ABCD').looksValid).toBe(false);
  });
});

describe('joinGameSchema', () => {
  it('valida y normaliza el objeto completo de unión', () => {
    const parsed = joinGameSchema.parse({ code: ' jk 2m9 ', displayName: ' Ana ' });
    expect(parsed).toEqual({ code: 'JK2M9', displayName: 'Ana' });
  });
});
