import type { QuadSlots } from '../types';

export type SlotIndex = 1 | 2 | 3 | 4;

export const EMPTY_SLOTS: QuadSlots = { slot1: null, slot2: null, slot3: null, slot4: null };

export function slotKey(index: SlotIndex): keyof QuadSlots {
	return `slot${index}` as keyof QuadSlots;
}

export function slotsToArray(slots: QuadSlots): Array<string | null> {
	return [slots.slot1, slots.slot2, slots.slot3, slots.slot4];
}

export function arrayToSlots(ids: Array<string | null>): QuadSlots {
	return {
		slot1: ids[0] ?? null,
		slot2: ids[1] ?? null,
		slot3: ids[2] ?? null,
		slot4: ids[3] ?? null,
	};
}

export function nextEmptySlot(slots: QuadSlots): SlotIndex | null {
	const arr = slotsToArray(slots);
	const idx = arr.findIndex((id) => !id);
	return idx === -1 ? null : ((idx + 1) as SlotIndex);
}

export function addVideoToQuad(
	slots: QuadSlots,
	videoId: string,
	replaceSlot?: SlotIndex,
): { slots: QuadSlots; status: 'added' | 'duplicate' | 'needsSlot' } {
	const existing = slotsToArray(slots);
	if (existing.includes(videoId)) return { slots, status: 'duplicate' };
	if (replaceSlot) {
		const next = [...existing];
		next[replaceSlot - 1] = videoId;
		return { slots: arrayToSlots(next), status: 'added' };
	}
	const empty = nextEmptySlot(slots);
	if (!empty) return { slots, status: 'needsSlot' };
	const next = [...existing];
	next[empty - 1] = videoId;
	return { slots: arrayToSlots(next), status: 'added' };
}

export function addManyToQuad(
	slots: QuadSlots,
	videoIds: string[],
): { slots: QuadSlots; remaining: string[]; needsSlot: boolean } {
	let current = { ...slots };
	const remaining: string[] = [];
	for (const id of videoIds) {
		const result = addVideoToQuad(current, id);
		if (result.status === 'needsSlot') {
			remaining.push(id);
			continue;
		}
		if (result.status === 'added') current = result.slots;
	}
	return { slots: current, remaining, needsSlot: remaining.length > 0 };
}

export function clearSlot(slots: QuadSlots, index: SlotIndex): QuadSlots {
	const next = [...slotsToArray(slots)];
	next[index - 1] = null;
	return arrayToSlots(next);
}

export function reorderSlots(slots: QuadSlots, from: SlotIndex, to: SlotIndex): QuadSlots {
	const next = [...slotsToArray(slots)];
	const tmp = next[from - 1];
	next[from - 1] = next[to - 1];
	next[to - 1] = tmp ?? null;
	return arrayToSlots(next);
}
