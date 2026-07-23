// Core of the cited, versioned rule engine.
//
// A rule set is a domain's parameters for a single effective period, where
// every leaf constant is wrapped in `cite(value, authority, locator)` so the
// number can never drift away from the primary source that fixes it. This is
// the suite's moat: a payroll figure isn't a magic constant, it's a value with
// an IRS Pub 15-T line or an N.J.S.A. § attached, resolved by year/effective
// date, and machine-checkable for completeness (every leaf must be cited).

/** A pointer to the authoritative primary source for a constant. */
export interface Citation {
  /** The document/authority, e.g. "IRS Publication 15-T (2026)", "N.J.S.A. 54:32B-3". */
  readonly authority: string;
  /** Where inside it, e.g. "Worksheet 1A, line 1h", "Appendix Three, field 2". */
  readonly locator: string;
  /** Optional clarifying note (assumptions, scope, verification status). */
  readonly note?: string;
}

/** A constant value bound to the source that fixes it. */
export interface Cited<T> {
  readonly value: T;
  readonly cite: Citation;
}

/** Bind a value to its primary source. */
export function cite<T>(value: T, authority: string, locator: string, note?: string): Cited<T> {
  const c: { authority: string; locator: string; note?: string } = { authority, locator };
  if (note !== undefined) c.note = note;
  return { value, cite: c };
}

/** Runtime type guard: is `x` a Cited node? */
export function isCited(x: unknown): x is Cited<unknown> {
  return (
    typeof x === 'object' &&
    x !== null &&
    'value' in x &&
    'cite' in x &&
    typeof (x as { cite: unknown }).cite === 'object' &&
    (x as { cite: unknown }).cite !== null &&
    'authority' in (x as { cite: object }).cite
  );
}

/** The plain-value shape a cited structure collapses to once citations are stripped. */
export type Materialized<T> =
  T extends Cited<infer U> ? Materialized<U> :
  T extends readonly (infer E)[] ? Materialized<E>[] :
  T extends object ? { [K in keyof T]: Materialized<T[K]> } :
  T;

/**
 * Strip citations, returning the plain values consumers compute against. A
 * Cited node collapses to its value; arrays and plain objects are walked; all
 * other values pass through. Deterministic and side-effect-free.
 */
export function materialize<T>(node: T): Materialized<T> {
  if (isCited(node)) return materialize(node.value) as Materialized<T>;
  if (Array.isArray(node)) return node.map((e) => materialize(e)) as Materialized<T>;
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = materialize(v);
    return out as Materialized<T>;
  }
  return node as Materialized<T>;
}

/** One cited constant flattened out of a rule set, with its dotted path. */
export interface CitedLeaf {
  readonly path: string;
  readonly value: unknown;
  readonly cite: Citation;
}

/** Every cited constant in a structure, in a stable depth-first order. */
export function citedLeaves(node: unknown, prefix = ''): CitedLeaf[] {
  if (isCited(node)) return [{ path: prefix, value: node.value, cite: node.cite }];
  const out: CitedLeaf[] = [];
  if (Array.isArray(node)) {
    node.forEach((e, i) => out.push(...citedLeaves(e, `${prefix}[${i}]`)));
  } else if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      out.push(...citedLeaves(v, prefix ? `${prefix}.${k}` : k));
    }
  }
  return out;
}

/**
 * The citation for one constant, addressed by dotted path (e.g.
 * "SOCIAL_SECURITY_WAGE_BASE" or "FED_STANDARD.single"). Throws if the path
 * doesn't resolve to a cited node — provenance is not allowed to fail silently.
 */
export function citationAt(node: unknown, path: string): Citation {
  const segments = path.split('.').filter(Boolean);
  let cursor: unknown = node;
  for (const seg of segments) {
    if (cursor && typeof cursor === 'object' && seg in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      throw new Error(`No rule parameter at path "${path}" (failed at "${seg}")`);
    }
  }
  if (!isCited(cursor)) throw new Error(`Path "${path}" is not a cited constant`);
  return cursor.cite;
}

/** A domain's parameters for one effective period. */
export interface RuleSet<P> {
  /** e.g. "payroll", "nacha". */
  readonly domain: string;
  /** e.g. "US-NJ", "US". */
  readonly jurisdiction: string;
  /** The calendar year the set is keyed on (the primary version axis). */
  readonly year: number;
  /** ISO date the set takes effect; enables effective-date resolution. */
  readonly effectiveDate: string;
  /** Structured parameters; every leaf is a Cited<...>. */
  readonly params: P;
}

const REGISTRY = new Map<string, RuleSet<unknown>>();

function regKey(domain: string, jurisdiction: string, year: number): string {
  return `${domain}|${jurisdiction}|${year}`;
}

/** Register a rule set. Re-registering the same (domain, jurisdiction, year) is rejected. */
export function register<P>(rs: RuleSet<P>): void {
  const k = regKey(rs.domain, rs.jurisdiction, rs.year);
  if (REGISTRY.has(k)) throw new Error(`Rule set already registered: ${k}`);
  REGISTRY.set(k, rs as RuleSet<unknown>);
}

/** Look up a rule set by exact (domain, jurisdiction, year). */
export function lookup<P>(domain: string, jurisdiction: string, year: number): RuleSet<P> | undefined {
  return REGISTRY.get(regKey(domain, jurisdiction, year)) as RuleSet<P> | undefined;
}

/**
 * Resolve the rule set in effect on a given ISO date: the registered set for
 * that domain/jurisdiction with the latest effectiveDate on or before the date.
 */
export function resolveByDate<P>(domain: string, jurisdiction: string, isoDate: string): RuleSet<P> | undefined {
  let best: RuleSet<unknown> | undefined;
  for (const rs of REGISTRY.values()) {
    if (rs.domain !== domain || rs.jurisdiction !== jurisdiction) continue;
    if (rs.effectiveDate <= isoDate && (!best || rs.effectiveDate > best.effectiveDate)) best = rs;
  }
  return best as RuleSet<P> | undefined;
}
