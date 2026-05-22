/**
 * Masking utilities for identifiers that must not be written to logs in
 * clear text (CodeQL `js/clear-text-logging`).
 *
 * `redactId` keeps just enough of an ID for debugging — a short prefix
 * and suffix — while hiding the bulk of the value. Always route IDs
 * through this function before logging: an inline `.slice(...)` would
 * not be recognised as a sanitizer by CodeQL's data-flow analysis, so
 * the alert would keep firing.
 */

/**
 * Mask an identifier for safe logging.
 *
 * - `null` / `undefined` / empty string → `"none"`
 * - 8 characters or fewer → `"***"` (too short to reveal a prefix safely)
 * - otherwise → first 4 chars + `"…"` + last 2 chars (e.g. `"ak_1…9f"`)
 */
export function redactId(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") {
    return "none";
  }
  if (v.length <= 8) {
    return "***";
  }
  return `${v.slice(0, 4)}…${v.slice(-2)}`;
}
