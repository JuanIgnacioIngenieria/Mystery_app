import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/middleware/rate-limit.js';

/** Duplicados HTTP mínimos para probar el middleware sin levantar la app. */
function fakeReq(path: string, ip: string): Request {
  return { path, ip } as unknown as Request;
}

function fakeRes(): Response {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  } as unknown as Response;
}

const callMiddleware = (
  limiter: ReturnType<typeof createRateLimiter>,
  req: Request,
  res: Response,
): Promise<{ blocked: boolean }> =>
  new Promise((resolve) => {
    limiter(req, res, (error?: unknown) => {
      resolve({ blocked: error != null });
    });
  });

describe('rate limiter', () => {
  it('permite hasta max peticiones dentro de la ventana y bloquea la siguiente', async () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });

    const results: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await callMiddleware(limiter, fakeReq('/api/games', '1.2.3.4'), fakeRes());
      results.push(result.blocked);
    }

    expect(results).toEqual([false, false, false, true]);
  });

  it('cada IP tiene su propio contador', async () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });

    const a1 = await callMiddleware(limiter, fakeReq('/api/games', '1.1.1.1'), fakeRes());
    const b1 = await callMiddleware(limiter, fakeReq('/api/games', '2.2.2.2'), fakeRes());
    const a2 = await callMiddleware(limiter, fakeReq('/api/games', '1.1.1.1'), fakeRes());

    expect(a1.blocked).toBe(false);
    expect(b1.blocked).toBe(false);
    expect(a2.blocked).toBe(true);
  });

  it('libera el contador al expirar la ventana', async () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    const req = fakeReq('/api/games', '5.5.5.5');
    const res = fakeRes();

    expect((await callMiddleware(limiter, req, res)).blocked).toBe(false);
    expect((await callMiddleware(limiter, req, res)).blocked).toBe(true);

    vi.advanceTimersByTime(1100);
    expect((await callMiddleware(limiter, req, res)).blocked).toBe(false);

    vi.useRealTimers();
  });
});
