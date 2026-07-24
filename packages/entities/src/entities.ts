// Minimal canonical entity records.
//
// These are the shared shapes an app maps its local rows to when it wants to
// speak about a firm / client / matter / user in suite-wide terms — a client
// invoice in billable, a trust account in iolta, and a company in books can all
// point at the SAME canonical client. The records are intentionally thin: they
// carry the canonical id, the kind, a human name, and only the cross-references
// that matter for the end-to-end workflow (a matter belongs to a client; a
// client and matter may be scoped to a firm). App-specific detail stays in the
// app.

import type { ClientId, FirmId, MatterId, UserId } from './ids.js';
import { isEntityId } from './ids.js';

export interface FirmEntity {
  id: FirmId;
  kind: 'firm';
  name: string;
}

export interface ClientEntity {
  id: ClientId;
  kind: 'client';
  name: string;
  /** The firm this client belongs to, when known. */
  firmId?: FirmId;
}

export interface MatterEntity {
  id: MatterId;
  kind: 'matter';
  name: string;
  /** The client this matter belongs to (required — a matter is always a client's). */
  clientId: ClientId;
  /** The firm this matter belongs to, when known. */
  firmId?: FirmId;
}

export interface UserEntity {
  id: UserId;
  kind: 'user';
  /** Login name; `null` is the default household owner (the shared password). */
  username: string | null;
  displayName?: string;
}

export type CanonicalEntity = FirmEntity | ClientEntity | MatterEntity | UserEntity;

function requireName(name: string): string {
  const trimmed = String(name).trim();
  if (!trimmed) throw new Error('An entity name is required');
  return trimmed;
}

/** Construct a firm record; validates the id kind + non-blank name. */
export function firmEntity(id: FirmId, name: string): FirmEntity {
  if (!isEntityId(id, 'firm')) throw new Error(`Not a firm id: ${JSON.stringify(id)}`);
  return { id, kind: 'firm', name: requireName(name) };
}

/** Construct a client record, optionally scoped to a firm. */
export function clientEntity(
  id: ClientId,
  name: string,
  opts: { firmId?: FirmId } = {},
): ClientEntity {
  if (!isEntityId(id, 'client')) throw new Error(`Not a client id: ${JSON.stringify(id)}`);
  const base: ClientEntity = { id, kind: 'client', name: requireName(name) };
  if (opts.firmId !== undefined) {
    if (!isEntityId(opts.firmId, 'firm')) {
      throw new Error(`Not a firm id: ${JSON.stringify(opts.firmId)}`);
    }
    return { ...base, firmId: opts.firmId };
  }
  return base;
}

/** Construct a matter record; a matter always references a client. */
export function matterEntity(
  id: MatterId,
  name: string,
  clientId: ClientId,
  opts: { firmId?: FirmId } = {},
): MatterEntity {
  if (!isEntityId(id, 'matter')) throw new Error(`Not a matter id: ${JSON.stringify(id)}`);
  if (!isEntityId(clientId, 'client')) {
    throw new Error(`Not a client id: ${JSON.stringify(clientId)}`);
  }
  const base: MatterEntity = { id, kind: 'matter', name: requireName(name), clientId };
  if (opts.firmId !== undefined) {
    if (!isEntityId(opts.firmId, 'firm')) {
      throw new Error(`Not a firm id: ${JSON.stringify(opts.firmId)}`);
    }
    return { ...base, firmId: opts.firmId };
  }
  return base;
}

/** Construct a user record; `username` null is the default household owner. */
export function userEntity(
  id: UserId,
  username: string | null,
  opts: { displayName?: string } = {},
): UserEntity {
  if (!isEntityId(id, 'user')) throw new Error(`Not a user id: ${JSON.stringify(id)}`);
  const base: UserEntity = { id, kind: 'user', username };
  if (opts.displayName !== undefined) {
    return { ...base, displayName: opts.displayName };
  }
  return base;
}
