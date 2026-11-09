/** Helpers for `catch (err)` blocks, where `err` is `unknown`. */

/** The Node error code (`ENOENT`, `EPERM`, ...) of a thrown value, if it has one. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** The message of a thrown value, whatever was thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
