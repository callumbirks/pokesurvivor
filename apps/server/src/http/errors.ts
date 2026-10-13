import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * An error with a machine-readable `code` the client maps to a UI string (`en.json`). The
 * `message` is for developers and logs only.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string; issues?: unknown };
}

/** Parses `value` with `schema`, turning a failure into a 400 `invalid_request`. */
export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidRequestError(result.error);
  return result.data;
}

class InvalidRequestError extends ApiError {
  constructor(readonly zodError: z.ZodError) {
    super(400, 'invalid_request', 'Request validation failed');
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError | ApiError>((err, request, reply) => {
    if (err instanceof ApiError) {
      const body: ErrorBody = { error: { code: err.code, message: err.message } };
      if (err instanceof InvalidRequestError) body.error.issues = z.treeifyError(err.zodError);
      return reply.status(err.statusCode).send(body);
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) request.log.error({ err }, 'request failed');
    const code = status === 429 ? 'rate_limited' : status >= 500 ? 'internal_error' : 'bad_request';
    const body: ErrorBody = {
      error: { code, message: status >= 500 ? 'Internal server error' : err.message },
    };
    return reply.status(status).send(body);
  });
}
