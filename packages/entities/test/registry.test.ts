import { describe, it, expect } from 'vitest';
import {
  EntityRegistry,
  firmEntity,
  clientEntity,
  matterEntity,
  firmId,
  clientId,
  matterId,
} from '../src/index.js';

describe('EntityRegistry — cross-app identity map', () => {
  it('registers and retrieves canonical entities', () => {
    const reg = new EntityRegistry();
    const f = firmEntity(firmId('f1'), 'Elias Counsel');
    reg.register(f);
    expect(reg.has(f.id)).toBe(true);
    expect(reg.get(f.id)).toEqual(f);
    expect(reg.get(firmId('nope'))).toBeUndefined();
    expect(reg.entities()).toEqual([f]);
  });

  it('resolves an app-local id to its canonical id (the whole point)', () => {
    const reg = new EntityRegistry();
    const client = clientEntity(clientId('k9x2'), 'Acme Corp');
    reg.register(client);
    // books knows this client by its customer uid; billable knows it by name.
    reg.link(client.id, 'books', 'cust_88af12');
    reg.link(client.id, 'billable', 'Acme Corp');
    expect(reg.resolve('books', 'client', 'cust_88af12')).toBe(client.id);
    expect(reg.resolve('billable', 'client', 'Acme Corp')).toBe(client.id);
    // Same local ref under a different app / kind does NOT collide.
    expect(reg.resolve('iolta', 'client', 'cust_88af12')).toBeUndefined();
    expect(reg.resolve('books', 'firm', 'cust_88af12')).toBeUndefined();
  });

  it('lists every alias registered for an entity', () => {
    const reg = new EntityRegistry();
    const f = firmEntity(firmId('f1'), 'Elias Counsel');
    reg.register(f);
    reg.link(f.id, 'books', 'co_1');
    reg.link(f.id, 'iolta', 'trust__u1');
    expect(reg.aliasesOf(f.id)).toEqual([
      { app: 'books', kind: 'firm', localRef: 'co_1' },
      { app: 'iolta', kind: 'firm', localRef: 'trust__u1' },
    ]);
  });

  it('fails closed: cannot link an unregistered id', () => {
    const reg = new EntityRegistry();
    expect(() => reg.link(firmId('ghost'), 'books', 'x')).toThrow();
  });

  it('fails closed: register rejects an entity whose id kind ≠ entity.kind', () => {
    const reg = new EntityRegistry();
    const bogus = { id: clientId('c1'), kind: 'firm', name: 'x' } as never;
    expect(() => reg.register(bogus)).toThrow();
  });

  it('re-registering the same id upserts (updates the record)', () => {
    const reg = new EntityRegistry();
    reg.register(firmEntity(firmId('f1'), 'Old Name'));
    reg.register(firmEntity(firmId('f1'), 'New Name'));
    const got = reg.get(firmId('f1'));
    expect(got?.kind).toBe('firm');
    expect((got as { name: string }).name).toBe('New Name');
    expect(reg.entities()).toHaveLength(1);
  });

  it('a matter references its client through canonical ids', () => {
    const reg = new EntityRegistry();
    const client = clientEntity(clientId('c1'), 'Acme');
    const matter = matterEntity(matterId('m1'), 'Estate', client.id);
    reg.register(client);
    reg.register(matter);
    const got = reg.get(matter.id);
    expect(got?.kind).toBe('matter');
    expect(reg.get((got as { clientId: typeof client.id }).clientId)).toEqual(client);
  });
});

describe('EntityRegistry serialization (persist + reload across sessions/apps)', () => {
  it('round-trips entities and aliases through JSON', () => {
    const reg = new EntityRegistry();
    const f = firmEntity(firmId('f1'), 'Elias Counsel');
    const c = clientEntity(clientId('c1'), 'Acme', { firmId: f.id });
    reg.register(f);
    reg.register(c);
    reg.link(f.id, 'books', 'co_1');
    reg.link(c.id, 'billable', 'Acme');

    const json = JSON.parse(JSON.stringify(reg.toJSON()));
    const restored = EntityRegistry.fromJSON(json);

    expect(restored.get(f.id)).toEqual(f);
    expect(restored.get(c.id)).toEqual(c);
    expect(restored.resolve('books', 'firm', 'co_1')).toBe(f.id);
    expect(restored.resolve('billable', 'client', 'Acme')).toBe(c.id);
    expect(restored.entities()).toHaveLength(2);
  });

  it('fromJSON fails closed on a corrupt id', () => {
    const corrupt = { entities: [{ id: 'not-an-id', kind: 'firm', name: 'x' }], aliases: [] };
    expect(() =>
      EntityRegistry.fromJSON(corrupt as unknown as Parameters<typeof EntityRegistry.fromJSON>[0]),
    ).toThrow();
  });
});
