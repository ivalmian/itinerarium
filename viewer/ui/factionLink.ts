/**
 * Clickable "faction name" affordance.
 *
 * Factions are referenced from many places — settlement.factions, caravan
 * owner-actor (when the actor backs a faction), bandit camp owner, named
 * characters' .faction — and every reference should be a click-target that
 * opens the faction screen. Centralize the styling + the setSelection call
 * here so each panel doesn't grow its own copy.
 *
 * Returns a plain HTMLButtonElement (not wrapped) so callers can keep using
 * the same appendChild flow as for any other inline node.
 */

import type { FactionId } from '../../src/sim/types.js';
import { setSelection, type ViewerState } from '../state/viewerState.js';

export const createFactionLink = (
  state: ViewerState,
  factionId: FactionId,
  label: string,
): HTMLButtonElement => {
  const btn = document.createElement('button');
  btn.className = 'faction-link';
  btn.textContent = label;
  btn.title = `Open faction screen: ${label}`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setSelection(state, { kind: 'faction', id: factionId });
  });
  return btn;
};
