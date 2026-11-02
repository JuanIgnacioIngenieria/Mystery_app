import type { NextFunction, Request, Response } from 'express';
import { httpError } from '../utils/errors.js';

interface Options {
  windowMs: number;
  max: number;
}

interface Bucket {
  hits: number[];
}

/**
 * Rate limiter en memoria (ventana fija) para protegernos del sondeo de
 * códigos y del spam de creación. Para esta iteración es el punto medio
 * correcto entre simplicidad y solidez; si un día desplegamos varias
 * instancias, se sustituye por un almacén compartido sin tocar la API.
 */
export function createRateLimiter({ windowMs, max }: Options) {
  const buckets = new Map<string, Bucket>();
  let janitor: NodeJS.Timeout | null = null;

  function ensureJanitor(): void {
    if (janitor) return;
    janitor = setInterval(() => {
      const cutoff = Date.now() - windowMs;
      for (const [key, bucket] of buckets) {
        bucket.hits = bucket.hits.filter((t) => t > cutoff);
        if (bucket.hits.length === 0) buckets.delete(key);
      }
    }, windowMs);
    // No impedir que Node finalice por culpa del temporizador.
    janitor.unref?.();
  }

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    ensureJanitor();
    const key = `${req.path}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const cutoff = now - windowMs;

    const bucket = buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((t) => t > cutoff);

    if (bucket.hits.length >= max) {
      const retryAfterSec = Math.ceil((bucket.hits[0]! + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      const error = httpError(429, 'RATE_LIMITED', 'Demasiadas peticiones. Espera un momento e inténtalo otra vez.');
      return next(error);
    }

    bucket.hits.push(now);
    buckets.set(key, bucket);
    next();
  };
}

