// Error types and classification — src/errors/

export interface NormalizedError {
  message: string;
  status: number | null;
  code: string | null;
  isNetworkError: boolean;
  isTimeout: boolean;
  /** True when the request was cancelled on purpose (AbortController, axios cancel). */
  isAborted: boolean;
  cause: unknown;
}

export function normalizeError(err: unknown): NormalizedError;

export class HTTPError extends Error {
  name: "HTTPError";
  status: number;
  statusText: string;
  response: Response;
  url: string;
  method: string;
  constructor(response: Response, request: { method: string; url: string });
}
