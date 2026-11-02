import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET_SET, GAME_CODE_LENGTH } from '@mystery/shared';
import {
  TOKEN_PATTERN,
  generateAccessToken,
  generateGameCode,
  hashToken,
} from '../src/utils/security.js';

describe('generateGameCode', () => {
  it('devuelve códigos con formato válido (longitud y alfabeto permitido)', () => {
    const codes = Array.from({ length: 200 }, () => generateGameCode());
    const expected = new RegExp(`^[${CODE_ALPHABET_SET}]{${GAME_CODE_LENGTH}}$`);

    for (const code of codes) {
      expect(code).toMatch(expected);
    }
  });

  it('nunca produce caracteres ambiguos (0, O, 1, I, L)', () => {
    const forbidden = /^[^0O1IL]*$/;
    for (let i = 0; i < 200; i += 1) {
      expect(generateGameCode()).toMatch(forbidden);
    }
  });

  it('genera códigos variados (sin repetición en 200 muestras)', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateGameCode()));
    // Colisiones y su impacto: < 5 %, los duplicados aún serían aceptables.
    expect(codes.size).toBeGreaterThan(195);
  });
});

describe('access tokens', () => {
  it('el token es hex de 64 caracteres y su hash es estable', () => {
    const token = generateAccessToken();
    expect(token).toMatch(TOKEN_PATTERN);
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('dos tokens distintos producen hashes distintos', () => {
    const a = generateAccessToken();
    const b = generateAccessToken();
    expect(a).not.toBe(b);
    expect(hashToken(a)).not.toBe(hashToken(b));
  });

  it('el hash no revela el token original (longitud fija de 64 hex)', () => {
    expect(hashToken(generateAccessToken())).toMatch(/^[0-9a-f]{64}$/);
  });
});
