/**
 * Shared "Named personnel" popup section, used by the caravan / bandit
 * camp / patrol popups to list each named individual + their issued
 * kit. Driven by WorldState.persons + WorldState.personEquipment per
 * docs/04 §"Person registry for moving units".
 */

import type { WorldState } from '../../src/procgen/seed.js';

const fmtAge = (age: number): string => `${age}`;
const fmtSex = (sex: string): string => (sex === 'female' ? 'F' : 'M');
const RESOURCE_SHORT_NAME: ReadonlyMap<string, string> = new Map([
  ['goods.gladius', 'gladius'],
  ['goods.hasta', 'hasta'],
  ['goods.pilum', 'pilum'],
  ['goods.dagger', 'dagger'],
  ['goods.bow', 'bow'],
  ['goods.arrow', 'arrow'],
  ['goods.sling', 'sling'],
  ['goods.sling_bullet', 'glandes'],
  ['goods.helmet', 'helmet'],
  ['goods.body_armor', 'lorica'],
  ['goods.shield', 'shield'],
]);

const kitToString = (slots: ReadonlyMap<string, number> | undefined): string => {
  if (slots === undefined || slots.size === 0) return '—';
  const parts: string[] = [];
  for (const [res, qty] of slots) {
    if (qty <= 0) continue;
    const name = RESOURCE_SHORT_NAME.get(res) ?? res;
    parts.push(qty > 1 ? `${qty}× ${name}` : name);
  }
  return parts.join(', ');
};

/**
 * Append a "Named personnel" section to `parent` listing every alive
 * Person in WorldState.persons whose unitId matches. Skips silently
 * when the world has no Person registry or when no persons match.
 *
 * The table is capped at ~40 rows so a large patrol or 100-bandit camp
 * doesn't blow up the popup; remaining persons are summarized as
 * "+N more".
 */
export const appendUnitPersonnelSection = (
  parent: HTMLElement,
  world: WorldState,
  unitId: string,
): void => {
  if (world.persons === undefined || world.persons.size === 0) return;
  const personsHere: { id: string; name: string; age: number; sex: string; role: string }[] = [];
  for (const [id, p] of world.persons) {
    if (p.unitId !== unitId) continue;
    if (p.status !== 'alive') continue;
    personsHere.push({
      id: String(id),
      name: p.name,
      age: p.age,
      sex: p.sex,
      role: p.role,
    });
  }
  if (personsHere.length === 0) return;

  // Sort by role then age desc → highest-rank-looking first.
  personsHere.sort((a, b) => {
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return b.age - a.age;
  });

  const header = document.createElement('h4');
  header.textContent = `Named personnel (${personsHere.length})`;
  parent.appendChild(header);

  const tbl = document.createElement('table');
  tbl.className = 'popup-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Name</th><th>Role</th><th class="num">Age</th><th>Kit</th></tr>`;
  tbl.appendChild(thead);

  const tb = document.createElement('tbody');
  const cap = 40;
  const rows = personsHere.slice(0, cap);
  for (const p of rows) {
    const slot = world.personEquipment?.get(p.id as unknown as never);
    const tr = document.createElement('tr');
    const c1 = document.createElement('td');
    c1.textContent = `${p.name} (${fmtSex(p.sex)})`;
    const c2 = document.createElement('td');
    c2.textContent = p.role.replace(/_/g, ' ');
    const c3 = document.createElement('td');
    c3.className = 'num';
    c3.textContent = fmtAge(p.age);
    const c4 = document.createElement('td');
    c4.textContent = kitToString(slot);
    tr.appendChild(c1);
    tr.appendChild(c2);
    tr.appendChild(c3);
    tr.appendChild(c4);
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  parent.appendChild(tbl);

  if (personsHere.length > cap) {
    const more = document.createElement('div');
    more.className = 'popup-note';
    more.textContent = `… and ${personsHere.length - cap} more`;
    parent.appendChild(more);
  }
};
