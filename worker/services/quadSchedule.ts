import { getQuadSettings } from '../db/quadSettings';
import { d1QuadStore } from '../db/quadStore';
import { confirmLiveStatuses, discoverLiveStreams } from './quadRefresh';
import { createYoutubeClient } from './youtube';

export async function runScheduledQuadRefresh(env: Env, userId: string, accessToken: string): Promise<void> {
	const settings = await getQuadSettings(env.DB, userId);
	if (!settings.pollingEnabled) return;
	const store = d1QuadStore(env.DB);
	const yt = createYoutubeClient(accessToken);
	await confirmLiveStatuses(store, yt, userId, { scheduled: true });
	await discoverLiveStreams(store, yt, userId, { scheduled: true });
}
