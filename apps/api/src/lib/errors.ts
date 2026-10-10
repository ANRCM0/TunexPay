export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ChannelDefinitiveError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 422, details);
    this.name = "ChannelDefinitiveError";
  }
}

export class ChannelUncertainError extends AppError {
  constructor(message: string, details?: unknown) {
    super("CHANNEL_RESULT_UNKNOWN", message, 502, details);
    this.name = "ChannelUncertainError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
