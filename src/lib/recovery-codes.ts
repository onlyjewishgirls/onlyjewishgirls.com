/** "abcde-fghij", "ABCDE FGHIJ" and "ABCDEFGHIJ" are the same code. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
