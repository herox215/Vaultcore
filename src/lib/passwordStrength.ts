// #345 — password strength estimator for the EncryptFolder flow.
//
// A minimal rule-based scorer: 0–3 segments of a meter, based on
// length + digit + non-alphanumeric presence. Deliberately avoids
// third-party libraries (zxcvbn ≈ 400 KB) so the bundle budget
// stays on-spec. The meter is advisory — the encrypt flow does NOT
// block on low strength (user decision per #345 brief).

export type PasswordStrength = "empty" | "weak" | "ok" | "strong";

/**
 * Score a password into a 3-segment bar category.
 *
 * Rules (deliberately simple and transparent):
 * - empty:  length 0
 * - weak:   length < 8 OR no criteria beyond length met
 * - ok:     length >= 8 and (has-digit OR has-symbol)
 * - strong: length >= 12 AND has-digit AND has-symbol
 */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) return "empty";
  const len = password.length;
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);

  if (len >= 12 && hasDigit && hasSymbol) return "strong";
  if (len >= 8 && (hasDigit || hasSymbol)) return "ok";
  return "weak";
}

/** Segments filled in the UI meter, 0-3. */
export function passwordStrengthFillCount(s: PasswordStrength): number {
  switch (s) {
    case "strong":
      return 3;
    case "ok":
      return 2;
    case "weak":
      return 1;
    case "empty":
      return 0;
  }
}
