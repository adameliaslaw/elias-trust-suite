// @elias/entities — the suite's canonical firm/client/matter/user identity.
//
// One typed, prefixed, opaque id per entity (ids.ts), the minimal shared record
// each app maps its rows to (entities.ts), a cross-app lookup so any app's local
// id resolves to the shared entity (registry.ts), and the firm-membership role
// reconciliation onto the canonical owner/bookkeeper/read-only set
// (membership.ts). Zero runtime deps; each app supplies its own local ids.
// Phase 7 / #26 — the shared identity layer the end-to-end workflow rides on.

export {
  ENTITY_KINDS,
  isEntityKind,
  prefixForKind,
  isValidLocalId,
  makeEntityId,
  firmId,
  clientId,
  matterId,
  userId,
  parseEntityId,
  tryParseEntityId,
  isEntityId,
  entityKindOf,
  localIdOf,
  slugifyLocalId,
  deriveLocalId,
  deriveEntityId,
} from './ids.js';
export type {
  EntityKind,
  EntityId,
  FirmId,
  ClientId,
  MatterId,
  UserId,
  ParsedEntityId,
} from './ids.js';

export {
  firmEntity,
  clientEntity,
  matterEntity,
  userEntity,
} from './entities.js';
export type {
  FirmEntity,
  ClientEntity,
  MatterEntity,
  UserEntity,
  CanonicalEntity,
} from './entities.js';

export {
  CANONICAL_ROLES,
  FIRM_MEMBERSHIP_ROLES,
  isCanonicalRole,
  isFirmMembershipRole,
  normalizeMembershipRole,
  toMembershipRole,
  firmMembership,
} from './membership.js';
export type {
  CanonicalRole,
  FirmMembershipRole,
  FirmMembership,
} from './membership.js';

export { EntityRegistry } from './registry.js';
export type { EntityAlias } from './registry.js';
