import { describe, expect, it } from 'vitest';
import { playthroughNextId, playthroughQueue, playthroughStartId } from '../../src/lib/playthrough';

describe('playthrough queue', () => {
	it('skips non-embeddable videos and starts from the selected row', () => {
		const items = [
			{ videoId: 'skipme00001', embeddable: false },
			{ videoId: 'abcdefghijk', embeddable: true },
			{ videoId: 'lmnopqrstuv', embeddable: true },
		];
		const queue = playthroughQueue(items);
		expect(queue.map((item) => item.videoId)).toEqual(['abcdefghijk', 'lmnopqrstuv']);
		const ids = queue.map((item) => item.videoId);
		expect(playthroughStartId(ids, 'skipme00001')).toBe('abcdefghijk');
		expect(playthroughStartId(ids, 'lmnopqrstuv')).toBe('lmnopqrstuv');
		expect(playthroughNextId(ids, 'abcdefghijk')).toBe('lmnopqrstuv');
		expect(playthroughNextId(ids, 'lmnopqrstuv')).toBeNull();
	});
});
