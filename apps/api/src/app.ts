import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { ApiErrorBody } from '@mystery/shared';
import { ApiHttpError, httpError } from './utils/errors.js';
import { gamesRouter } from './routes/games.routes.js';

/**
 * App de Express sin tráfico directo a Firestore: toda la base de datos
 * pasa por los servicios con validación y autorización propias.
 */
export function createApp(): express.Express {
  const app = express();

  // Cabeceras básicas de seguridad y límite de tamaño del body: el API solo
  // recibe JSONs pequeños; un body gigante es abuso, no un caso de uso.
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));

  app.use('/api/games', gamesRouter);

  app.use((req, res, next: NextFunction) => {
    next(httpError(404, 'NOT_FOUND', 'Ruta no encontrada.'));
  });

  /**
   * Middleware de errores: convierte ApiHttpError en JSON estable y
   * cualquier falla inesperada en 500 genérico (sin filtrar detalles internos).
   */
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiHttpError) {
      const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
      res.status(error.status).json(body);
      return;
    }
    if (error instanceof SyntaxError && 'body' in (error as { body?: unknown })) {
      // express.json usa SyntaxError para JSON malformado; lo mapeamos a 400.
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'JSON inválido.' } } satisfies ApiErrorBody);
      return;
    }
    console.error('[api] error inesperado:', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor.' } } satisfies ApiErrorBody);
  });

  return app;
}
