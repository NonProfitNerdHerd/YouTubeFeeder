export type AudioMode = 'oneActive' | 'allMuted';

export function applyUseAudio(activeSlot: number, slotCount = 4): boolean[] {
	return Array.from({ length: slotCount }, (_, i) => i !== activeSlot);
}

export function muteAll(slotCount = 4): boolean[] {
	return Array.from({ length: slotCount }, () => true);
}

export function initialMutes(mode: AudioMode, slotCount = 4): boolean[] {
	if (mode === 'allMuted') return muteAll(slotCount);
	return muteAll(slotCount);
}
