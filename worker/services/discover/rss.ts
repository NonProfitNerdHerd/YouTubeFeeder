import type { ParsedRssItem } from '../../db/podcasts';

function decodeEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function tagValue(block: string, tag: string): string {
	const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
	const match = block.match(re);
	return match ? decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim()) : '';
}

function attrValue(block: string, tag: string, attr: string): string {
	const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["']`, 'i');
	return block.match(re)?.[1] ?? '';
}

function parseDuration(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^\d+$/.test(trimmed)) return Number(trimmed);
	const hms = trimmed.match(/(?:(\d+):)?(\d+):(\d+)/);
	if (hms) {
		const h = Number(hms[1] ?? 0);
		const m = Number(hms[2]);
		const s = Number(hms[3]);
		return h * 3600 + m * 60 + s;
	}
	return null;
}

function parseRssItems(xml: string): ParsedRssItem[] {
	const items: ParsedRssItem[] = [];
	const re = /<item[\s>][\s\S]*?<\/item>/gi;
	const seen = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = re.exec(xml))) {
		const block = match[0];
		const title = tagValue(block, 'title') || 'Untitled episode';
		const guid = tagValue(block, 'guid') || tagValue(block, 'link') || title;
		if (seen.has(guid)) continue;
		seen.add(guid);

		const pubDate = tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated');
		const publishedAt = pubDate ? new Date(pubDate).toISOString() : null;
		const audioUrl = attrValue(block, 'enclosure', 'url') || tagValue(block, 'link');
		const durationRaw = tagValue(block, 'itunes:duration') || tagValue(block, 'duration');

		items.push({
			guid,
			title,
			description: tagValue(block, 'description').slice(0, 500),
			imageUrl: attrValue(block, 'media:content', 'url') || attrValue(block, 'itunes:image', 'href'),
			audioUrl,
			publishedAt: publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? publishedAt : null,
			durationSeconds: parseDuration(durationRaw),
		});
	}
	return items;
}

export async function fetchAndParseRss(
	feedUrl: string,
	headers: { etag?: string | null; lastModified?: string | null },
): Promise<{ items: ParsedRssItem[]; etag: string | null; lastModified: string | null }> {
	const reqHeaders: Record<string, string> = { 'User-Agent': 'VortiQuest/1.0' };
	if (headers.etag) reqHeaders['If-None-Match'] = headers.etag;
	if (headers.lastModified) reqHeaders['If-Modified-Since'] = headers.lastModified;

	const res = await fetch(feedUrl, { headers: reqHeaders, redirect: 'follow' });
	if (res.status === 304) return { items: [], etag: headers.etag ?? null, lastModified: headers.lastModified ?? null };

	if (!res.ok) throw new Error(`rss_fetch_${res.status}`);

	const xml = await res.text();
	const items = parseRssItems(xml);
	return {
		items,
		etag: res.headers.get('etag'),
		lastModified: res.headers.get('last-modified'),
	};
}

export const parseRssItemsForTest = parseRssItems;
