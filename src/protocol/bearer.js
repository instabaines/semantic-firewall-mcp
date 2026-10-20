import { createHash, timingSafeEqual } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

// Constant-time comparison of a presented secret against the expected one.
export function secretMatches(presented, expected) {
  if (!presented || !expected) {
    return false;
  }
  return timingSafeEqual(digest(presented), digest(expected));
}

export function bearerFrom(request) {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}
