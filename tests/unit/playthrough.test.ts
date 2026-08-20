import { describe, expect, it } from 'vitest';
import {
	playthroughNextId,
	playthroughQueue,
	playthroughQueueFromSelected,
	playthroughStartId,
} from '../../src/lib/playthrough';

describe('playthrough queue', () => {
	const items = [
		{ videoId: 'skipme00001', embeddable: false },
		{ videoId: 'abcdefghijk', embeddable: true },
		{ videoId: 'lmnopqrstuv', embeddable: true },
		{ videoId: 'wxyz0123456', embeddable: true },
	];

	it('skips non-embeddable videos', () => {
		const queue = playthroughQueue(items);
		expect(queue.map((item) => item.videoId)).toEqual(['abcdefghijk', 'lmnopqrstuv', 'wxyz0123456']);
	});

	it('starts from the top when mode is top', () => {
		const ids = playthroughQueue(items).map((item) => item.videoId);
		expect(playthroughStartId(ids, 'lmnopqrstuv', 'top')).toBe('abcdefghijk');
		expect(playthroughStartId(ids, null, 'top')).toBe('abcdefghijk');
	});

	it('starts from the selected row when mode is selected', () => {
		const ids = playthroughQueue(items).map((item) => item.videoId);
		expect(playthroughStartId(ids, 'skipme00001', 'selected')).toBe('abcdefghijk');
		expect(playthroughStartId(ids, 'lmnopqrstuv', 'selected')).toBe('lmnopqrstuv');
	});

	it('slices the queue from the selected embeddable video', () => {
		expect(playthroughQueueFromSelected(items, 'lmnopqrstuv').map((item) => item.videoId)).toEqual([
			'lmnopqrstuv',
			'wxyz0123456',
		]);
		expect(playthroughQueueFromSelected(items, 'skipme00001')).toEqual([]);
		expect(playthroughQueueFromSelected(items, null)).toEqual([]);
	});

	it('advances to the next id and ends at the last', () => {
		const ids = playthroughQueue(items).map((item) => item.videoId);
		expect(playthroughNextId(ids, 'abcdefghijk')).toBe('lmnopqrstuv');
		expect(playthroughNextId(ids, 'wxyz0123456')).toBeNull();
	});
});
