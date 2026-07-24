// Cookie-header parsing that never throws. Lifted from books' auth.
//
// A malformed %-escape in one cookie must not take the whole request down (the
// same bug class as a bad route-param decode): the raw value is kept instead,
// which simply won't match any session token.

/** Parse a raw `Cookie:` header value into a name -> value map. */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of String(header ?? '').split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    if (!key) continue;
    const raw = pair.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}
