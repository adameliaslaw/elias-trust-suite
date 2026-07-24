// Canonical suite identifiers.
//
// Every app in the suite models firm / client / matter / user differently —
// books mints opaque base36 uids, iolta uses Firestore auto-ids and composite
// `trust__<uid>` account keys, billable carries free-text client/matter strings
// (grouped by a sha1 tag). There was no shared vocabulary, so the "same" client
// could not be named identically across apps. This module is that vocabulary: a
// typed, prefixed, opaque id an app derives from its own local id and any other
// app can parse and route.
//
// Format: `<prefix>_<localId>`.
//   - `prefix` is a fixed short tag per kind (`firm`, `clnt`, `mtr`, `usr`).
//   - `localId` is the app's own identifier, constrained to a URL-safe opaque
//     shape. Parsing splits on the FIRST underscore only, so a local id may
//     itself contain underscores (iolta's `trust__<uid>` survives intact).
//
// The ids are OPAQUE: nothing downstream should read structure out of the local
// part beyond the kind prefix. `makeEntityId` fails closed on anything that
// isn't a safe local id; free text goes through `slugifyLocalId` (human-legible)
// or `deriveLocalId` (content-addressed) first.

import { createHash } from 'node:crypto';

/** The four canonical entity kinds, in a stable order. */
export const ENTITY_KINDS = ['firm', 'client', 'matter', 'user'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * A branded canonical id string. The brand is compile-time only — at runtime an
 * `EntityId` is exactly the `"<prefix>_<localId>"` string.
 */
export type EntityId<K extends EntityKind = EntityKind> = string & {
  readonly __entity: K;
};

export type FirmId = EntityId<'firm'>;
export type ClientId = EntityId<'client'>;
export type MatterId = EntityId<'matter'>;
export type UserId = EntityId<'user'>;

const KIND_PREFIX: Readonly<Record<EntityKind, string>> = {
  firm: 'firm',
  client: 'clnt',
  matter: 'mtr',
  user: 'usr',
};

const PREFIX_KIND: ReadonlyMap<string, EntityKind> = new Map(
  ENTITY_KINDS.map((k) => [KIND_PREFIX[k], k]),
);

// A local id starts with an alphanumeric and then allows word chars (incl. the
// underscore, so `trust__abc` is fine), dot, tilde and hyphen. No spaces, no
// slashes, no pipes — those come from free text and must be slugged/hashed.
const LOCAL_ID_RE = /^[A-Za-z0-9][\w.~-]*$/;
const MAX_LOCAL_ID = 256;

/** True when `value` is exactly one of the four canonical kinds. */
export function isEntityKind(value: unknown): value is EntityKind {
  return (
    typeof value === 'string' && (ENTITY_KINDS as readonly string[]).includes(value)
  );
}

/** The fixed short prefix for a kind. Throws on an unknown kind. */
export function prefixForKind(kind: EntityKind): string {
  const prefix = KIND_PREFIX[kind];
  if (prefix === undefined) throw new Error(`Unknown entity kind: ${String(kind)}`);
  return prefix;
}

/** True when `value` is a syntactically valid opaque local id. */
export function isValidLocalId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_LOCAL_ID && LOCAL_ID_RE.test(value)
  );
}

/**
 * Build a canonical id from a kind and an already-valid local id. Fails closed
 * on an unknown kind or a local id that isn't URL-safe/opaque — pass free text
 * through {@link slugifyLocalId} or {@link deriveLocalId} first.
 */
export function makeEntityId<K extends EntityKind>(kind: K, localId: string): EntityId<K> {
  if (!isEntityKind(kind)) throw new Error(`Unknown entity kind: ${String(kind)}`);
  if (!isValidLocalId(localId)) {
    throw new Error(`Invalid local id for ${kind}: ${JSON.stringify(localId)}`);
  }
  return `${prefixForKind(kind)}_${localId}` as EntityId<K>;
}

export const firmId = (localId: string): FirmId => makeEntityId('firm', localId);
export const clientId = (localId: string): ClientId => makeEntityId('client', localId);
export const matterId = (localId: string): MatterId => makeEntityId('matter', localId);
export const userId = (localId: string): UserId => makeEntityId('user', localId);

/** The kind + local id an entity id decomposes into. */
export interface ParsedEntityId {
  kind: EntityKind;
  localId: string;
}

/**
 * Decompose a canonical id into its kind + local id. Throws on anything that is
 * not a well-formed id (missing/unknown prefix, empty or unsafe local part).
 */
export function parseEntityId(id: unknown): ParsedEntityId {
  if (typeof id !== 'string') throw new Error(`Not an entity id: ${JSON.stringify(id)}`);
  const sep = id.indexOf('_');
  if (sep <= 0) throw new Error(`Not an entity id (no prefix): ${JSON.stringify(id)}`);
  const prefix = id.slice(0, sep);
  const localId = id.slice(sep + 1);
  const kind = PREFIX_KIND.get(prefix);
  if (kind === undefined) throw new Error(`Unknown id prefix: ${JSON.stringify(prefix)}`);
  if (!isValidLocalId(localId)) {
    throw new Error(`Malformed local id in ${JSON.stringify(id)}`);
  }
  return { kind, localId };
}

/** Non-throwing {@link parseEntityId}; returns null on any malformed input. */
export function tryParseEntityId(id: unknown): ParsedEntityId | null {
  try {
    return parseEntityId(id);
  } catch {
    return null;
  }
}

/**
 * Guard: is `value` a well-formed entity id? When `kind` is given, also requires
 * the id to be of that kind. Never throws.
 */
export function isEntityId<K extends EntityKind>(
  value: unknown,
  kind?: K,
): value is EntityId<K> {
  const parsed = tryParseEntityId(value);
  if (parsed === null) return false;
  return kind === undefined || parsed.kind === kind;
}

/** The kind of an entity id. Throws if `id` is malformed. */
export function entityKindOf(id: unknown): EntityKind {
  return parseEntityId(id).kind;
}

/** The local id of an entity id. Throws if `id` is malformed. */
export function localIdOf(id: unknown): string {
  return parseEntityId(id).localId;
}

/**
 * Turn human free text (billable's `client`/`matter` strings, a customer name)
 * into a legible, valid local id: lowercased, runs of unsafe characters folded
 * to single hyphens, edges trimmed. Throws when nothing slug-able remains — the
 * caller should fall back to {@link deriveLocalId} (a content hash) then.
 */
export function slugifyLocalId(raw: string): string {
  const slug = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error(`Cannot slugify to a local id: ${JSON.stringify(raw)} — hash instead`);
  }
  return slug;
}

/**
 * A stable, content-addressed local id from one or more natural-key parts. The
 * SAME parts always yield the SAME id, so two apps that agree on a natural key
 * (e.g. billable's `client` + `matter`) derive the identical canonical id
 * without coordinating. Parts are joined on a NUL so `['a','bc']` and
 * `['ab','c']` never collide.
 */
export function deriveLocalId(...parts: string[]): string {
  if (parts.length === 0) throw new Error('deriveLocalId requires at least one part');
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

/** {@link deriveLocalId} lifted straight to a canonical id of the given kind. */
export function deriveEntityId<K extends EntityKind>(
  kind: K,
  ...parts: string[]
): EntityId<K> {
  return makeEntityId(kind, deriveLocalId(...parts));
}
