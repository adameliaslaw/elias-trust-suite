import { describe, it, expect } from 'vitest';
import {
  firmEntity,
  clientEntity,
  matterEntity,
  userEntity,
  firmId,
  clientId,
  matterId,
  userId,
} from '../src/index.js';

describe('canonical entity constructors', () => {
  it('builds a firm', () => {
    const f = firmEntity(firmId('trust__abc'), 'Elias Counsel');
    expect(f).toEqual({ id: 'firm_trust__abc', kind: 'firm', name: 'Elias Counsel' });
  });

  it('builds a client, optionally scoped to a firm', () => {
    expect(clientEntity(clientId('c1'), 'Acme Corp')).toEqual({
      id: 'clnt_c1',
      kind: 'client',
      name: 'Acme Corp',
    });
    const scoped = clientEntity(clientId('c1'), 'Acme Corp', { firmId: firmId('f1') });
    expect(scoped.firmId).toBe('firm_f1');
  });

  it('builds a matter that must reference a client', () => {
    const m = matterEntity(matterId('m1'), 'Estate Plan', clientId('c1'), {
      firmId: firmId('f1'),
    });
    expect(m).toEqual({
      id: 'mtr_m1',
      kind: 'matter',
      name: 'Estate Plan',
      clientId: 'clnt_c1',
      firmId: 'firm_f1',
    });
  });

  it('builds a user; username null is the default household owner', () => {
    expect(userEntity(userId('jane'), 'jane')).toEqual({
      id: 'usr_jane',
      kind: 'user',
      username: 'jane',
    });
    const owner = userEntity(userId('owner'), null, { displayName: 'Adam Elias' });
    expect(owner.username).toBeNull();
    expect(owner.displayName).toBe('Adam Elias');
  });
});

describe('entity constructors validate id kind + required fields', () => {
  it('rejects an id whose kind does not match the constructor', () => {
    // @ts-expect-error — a client id is not a firm id
    expect(() => firmEntity(clientId('c1'), 'x')).toThrow();
    // @ts-expect-error — a firm id is not a matter id
    expect(() => matterEntity(firmId('f1'), 'x', clientId('c1'))).toThrow();
  });

  it('rejects a blank name', () => {
    expect(() => firmEntity(firmId('f1'), '')).toThrow();
    expect(() => firmEntity(firmId('f1'), '   ')).toThrow();
  });

  it('rejects a matter whose clientId is not a client id', () => {
    // @ts-expect-error — a firm id is not a client id
    expect(() => matterEntity(matterId('m1'), 'x', firmId('f1'))).toThrow();
  });

  it('omits optional fields entirely when not provided (exactOptionalPropertyTypes)', () => {
    const c = clientEntity(clientId('c1'), 'Acme');
    expect('firmId' in c).toBe(false);
    const u = userEntity(userId('u1'), 'u1');
    expect('displayName' in u).toBe(false);
  });
});
