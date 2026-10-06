/**
 * Signing tokens are opaque, URL-safe secrets issued by the backend (base64url, 32+ random bytes).
 * The portal never decodes them: it only rejects obviously malformed values before calling the API.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}
