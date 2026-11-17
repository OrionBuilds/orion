export function getErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

export function logError(context: string, error: unknown): void {
  console.error(`[${context}] ${getErrorMessage(error)}`, error);
}

/**
 * Handler for intentionally non-blocking work (background syncs, notifications,
 * activity logging). The failure never reaches the caller, so it must be logged.
 */
export function reportBackgroundError(context: string): (error: unknown) => void {
  return (error: unknown) => logError(context, error);
}
