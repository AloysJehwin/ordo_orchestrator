export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}
