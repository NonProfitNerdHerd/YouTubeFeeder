import { listCategoryChannelCorpus, listRecentInboxContentForChannels } from '../../db/queries';

export const VIDEOS_PER_CHANNEL = 6;

export interface ChannelDocument {
	channelId: string;
	text: string;
}

export interface InterestCorpus {
	label: string;
	channelCount: number;
	videosSampled: number;
	channelDocuments: ChannelDocument[];
}

export async function buildInterestCorpus(
	db: D1Database,
	userId: string,
	categoryId: string,
	categoryName: string,
	videosPerChannel = VIDEOS_PER_CHANNEL,
): Promise<InterestCorpus> {
	const channels = await listCategoryChannelCorpus(db, userId, categoryId);
	const channelIds = channels.map((row) => row.channelId);
	const videos = await listRecentInboxContentForChannels(db, userId, channelIds, videosPerChannel);

	const channelDocuments: ChannelDocument[] = [];
	for (const channel of channels) {
		const channelVideos = videos.filter((row) => row.channelId === channel.channelId);
		const parts = [channel.title, channel.description];
		for (const video of channelVideos) {
			parts.push(video.title, video.descriptionExcerpt);
		}
		channelDocuments.push({
			channelId: channel.channelId,
			text: parts.filter(Boolean).join(' '),
		});
	}

	const labelDoc: ChannelDocument = {
		channelId: '__category__',
		text: categoryName,
	};

	return {
		label: categoryName,
		channelCount: channels.length,
		videosSampled: videos.length,
		channelDocuments: [labelDoc, ...channelDocuments],
	};
}
