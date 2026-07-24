// A cross-app identity map.
//
// The canonical ids (ids.ts) give the suite one NAME per firm/client/matter/
// user; the registry gives it one LOOKUP. Each app links the local ids it
// already stores (a books customer uid, a billable client string, an iolta
// account key) to a canonical id, and can then resolve any app's local id to
// the shared entity — the join the end-to-end workflow rides on (a billable
// matter → a books client invoice → an iolta trust ledger, all the same client).
//
// The registry is a pure in-memory structure with no I/O; `toJSON`/`fromJSON`
// let an app persist it however it persists everything else (a books row, an
// iolta doc, a JSON file). It fails closed: you cannot link an id that was never
// registered, and register/fromJSON reject an id whose prefix disagrees with the
// record's kind.

import type { CanonicalEntity } from './entities.js';
import type { EntityId, EntityKind } from './ids.js';
import { entityKindOf, isEntityId } from './ids.js';

/** An app's own reference to a canonical entity. */
export interface EntityAlias {
  /** Which app owns this local id, e.g. 'books' | 'iolta' | 'billable'. */
  app: string;
  kind: EntityKind;
  /** The app's local identifier for the entity (opaque to the registry). */
  localRef: string;
}

interface StoredAlias extends EntityAlias {
  id: EntityId;
}

interface RegistryJSON {
  entities: CanonicalEntity[];
  aliases: StoredAlias[];
}

function aliasKey(app: string, kind: EntityKind, localRef: string): string {
  return `${app}\u0000${kind}\u0000${localRef}`;
}

export class EntityRegistry {
  #entities = new Map<EntityId, CanonicalEntity>();
  #aliasToId = new Map<string, EntityId>();
  #aliasesById = new Map<EntityId, EntityAlias[]>();

  /**
   * Register (or upsert) a canonical entity. Throws if the entity's id prefix
   * disagrees with its declared `kind`.
   */
  register(entity: CanonicalEntity): void {
    if (!isEntityId(entity.id, entity.kind)) {
      throw new Error(
        `Entity id ${JSON.stringify(entity.id)} does not match kind ${entity.kind}`,
      );
    }
    this.#entities.set(entity.id, entity);
  }

  /** The canonical entity for an id, or undefined. */
  get(id: EntityId): CanonicalEntity | undefined {
    return this.#entities.get(id);
  }

  has(id: EntityId): boolean {
    return this.#entities.has(id);
  }

  /** Every registered entity, in insertion order. */
  entities(): CanonicalEntity[] {
    return [...this.#entities.values()];
  }

  /**
   * Point an app's local id at a registered canonical id. Throws if the id was
   * never registered, or if the alias kind disagrees with the id's kind.
   */
  link(id: EntityId, app: string, localRef: string): void {
    if (!this.#entities.has(id)) {
      throw new Error(`Cannot link unregistered id: ${JSON.stringify(id)}`);
    }
    const kind = entityKindOf(id);
    this.#aliasToId.set(aliasKey(app, kind, localRef), id);
    const list = this.#aliasesById.get(id) ?? [];
    if (!list.some((a) => a.app === app && a.kind === kind && a.localRef === localRef)) {
      list.push({ app, kind, localRef });
    }
    this.#aliasesById.set(id, list);
  }

  /** Resolve an app's local id to a canonical id, or undefined. */
  resolve(app: string, kind: EntityKind, localRef: string): EntityId | undefined {
    return this.#aliasToId.get(aliasKey(app, kind, localRef));
  }

  /** Every alias registered for an entity, in link order. */
  aliasesOf(id: EntityId): EntityAlias[] {
    return [...(this.#aliasesById.get(id) ?? [])];
  }

  /** A plain, JSON-serializable snapshot the app can persist. */
  toJSON(): RegistryJSON {
    const aliases: StoredAlias[] = [];
    for (const [id, list] of this.#aliasesById) {
      for (const a of list) aliases.push({ ...a, id });
    }
    return { entities: this.entities(), aliases };
  }

  /** Rebuild a registry from a {@link toJSON} snapshot. Fails closed on a bad id. */
  static fromJSON(data: RegistryJSON): EntityRegistry {
    const reg = new EntityRegistry();
    for (const entity of data.entities ?? []) reg.register(entity);
    for (const a of data.aliases ?? []) reg.link(a.id, a.app, a.localRef);
    return reg;
  }
}
