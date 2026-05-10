import { describe, expect, it } from 'vitest';
import { actorId, characterId, factionId } from '../types.js';
import { addMember, createFaction, removeMember, hasMember } from './faction.js';

describe('createFaction', () => {
  it('creates with no members by default', () => {
    const f = createFaction({
      id: factionId('curia-aquileia'),
      actor: actorId('vibian'),
      name: 'Curia of Aquileia',
    });
    expect(f.id).toBe(factionId('curia-aquileia'));
    expect(f.actor).toBe(actorId('vibian'));
    expect(f.name).toBe('Curia of Aquileia');
    expect(f.members).toHaveLength(0);
  });

  it('rejects empty name', () => {
    expect(() =>
      createFaction({
        id: factionId('x'),
        actor: actorId('y'),
        name: '',
      }),
    ).toThrow();
  });

  it('accepts an initial members list', () => {
    const f = createFaction({
      id: factionId('vibian-house'),
      actor: actorId('vibian'),
      name: 'House of Vibian',
      members: [characterId('quintus'), characterId('marcus')],
    });
    expect(f.members).toEqual([characterId('quintus'), characterId('marcus')]);
  });

  it('rejects duplicate members in initial list', () => {
    expect(() =>
      createFaction({
        id: factionId('x'),
        actor: actorId('y'),
        name: 'Z',
        members: [characterId('a'), characterId('a')],
      }),
    ).toThrow();
  });
});

describe('faction membership', () => {
  it('addMember adds a member exactly once', () => {
    const f = createFaction({
      id: factionId('f'),
      actor: actorId('a'),
      name: 'F',
    });
    addMember(f, characterId('quintus'));
    expect(f.members).toEqual([characterId('quintus')]);
    expect(hasMember(f, characterId('quintus'))).toBe(true);
  });

  it('addMember is idempotent on duplicates (no double-counting)', () => {
    const f = createFaction({
      id: factionId('f'),
      actor: actorId('a'),
      name: 'F',
    });
    addMember(f, characterId('quintus'));
    addMember(f, characterId('quintus'));
    expect(f.members).toHaveLength(1);
  });

  it('removeMember removes an existing member', () => {
    const f = createFaction({
      id: factionId('f'),
      actor: actorId('a'),
      name: 'F',
      members: [characterId('quintus'), characterId('marcus')],
    });
    removeMember(f, characterId('quintus'));
    expect(f.members).toEqual([characterId('marcus')]);
    expect(hasMember(f, characterId('quintus'))).toBe(false);
  });

  it('removeMember throws if the member is not present', () => {
    const f = createFaction({
      id: factionId('f'),
      actor: actorId('a'),
      name: 'F',
    });
    expect(() => removeMember(f, characterId('nobody'))).toThrow();
  });

  it('preserves member order', () => {
    const f = createFaction({
      id: factionId('f'),
      actor: actorId('a'),
      name: 'F',
    });
    addMember(f, characterId('a'));
    addMember(f, characterId('b'));
    addMember(f, characterId('c'));
    removeMember(f, characterId('b'));
    expect(f.members).toEqual([characterId('a'), characterId('c')]);
  });
});

describe('faction <-> actor relationship', () => {
  it('the actor field references the owning Actor by ID', () => {
    const f = createFaction({
      id: factionId('vibian-house'),
      actor: actorId('vibian'),
      name: 'House of Vibian',
    });
    expect(f.actor).toBe(actorId('vibian'));
  });
});
