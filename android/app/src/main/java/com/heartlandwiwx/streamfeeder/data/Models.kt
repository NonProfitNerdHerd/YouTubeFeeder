package com.heartlandwiwx.streamfeeder.data

data class CurrentUser(
    val id: String,
    val displayName: String,
    val connected: Boolean,
)

data class InboxItem(
    val videoId: String,
    val channelId: String,
    val channelTitle: String,
    val title: String,
    val descriptionExcerpt: String,
    val thumbnailUrl: String,
    val publishedAt: String?,
    val embeddable: Boolean,
    val unread: Boolean,
    val hidden: Boolean,
    val snoozedUntil: String?,
    val notes: String,
    val durationSeconds: Double? = null,
    val watchedAt: String? = null,
    val playbackSeconds: Double = 0.0,
    val lastPositionSeconds: Double = 0.0,
)

data class InboxWatchFields(
    val watchedAt: String?,
    val playbackSeconds: Double,
    val lastPositionSeconds: Double,
    val watchUpdatedAt: String?,
)

enum class WatchedFilter(val api: String, val label: String) {
    All("all", "All"),
    Unwatched("unwatched", "Unwatched"),
    Watched("watched", "Watched"),
}

enum class AppTheme(val storage: String, val label: String, val description: String) {
    Light("light", "Light", "White background"),
    Dark("dark", "Dark", "Dim background"),
    Sepia("sepia", "Sepia", "Warm, reduced blue light");

    companion object {
        fun fromStorage(value: String?): AppTheme? = entries.find { it.storage == value }
    }
}

data class InboxPage(
    val items: List<InboxItem>,
    val count: Int,
    val unwatchedCount: Int,
    val hasMore: Boolean = false,
)

data class FeedSyncStatus(
    val newestInboxPublishedAt: String?,
    val overdueCount: Int = 0,
    val quotaLimited: Boolean = false,
)

data class CategoryRecord(
    val id: String,
    val name: String,
)

data class ChannelRecord(
    val channelId: String,
    val title: String,
    val thumbnailUrl: String,
    val followInInbox: Boolean,
    val maxVideosToPull: Int,
    val inboxVideoCount: Int,
    val categoryIds: List<String>,
)

data class WatchlistRecord(
    val id: String,
    val name: String,
    val videoCount: Int,
)

data class LiveVideoRecord(
    val videoId: String,
    val title: String,
    val status: String?,
    val embeddable: Boolean?,
)

data class LiveSourceRecord(
    val id: String,
    val displayName: String,
    val enabled: Boolean,
    val sourceMode: String,
    val verifyState: String,
    val verifyError: String?,
    val lastStatusCheckAt: String?,
    val liveVideoId: String?,
    val liveVideos: List<LiveVideoRecord>,
    val categoryIds: List<String>,
) {
    fun playableLive(): List<LiveVideoRecord> =
        liveVideos.filter { it.status == "live" && it.embeddable != false }

    fun blockedLive(): List<LiveVideoRecord> =
        liveVideos.filter { it.status == "non_embeddable" }

    fun upcoming(): List<LiveVideoRecord> =
        liveVideos.filter { it.status == "upcoming" }

    fun liveCount(): Int = playableLive().size + blockedLive().size

    fun embedVideoId(): String? = playableLive().firstOrNull()?.videoId ?: liveVideoId

    fun statusLabel(): String = when {
        sourceMode == "disabled" -> "Disabled"
        verifyState == "error" -> "Unknown"
        liveCount() > 0 -> "Live"
        upcoming().isNotEmpty() -> "Upcoming"
        else -> "Offline"
    }
}

enum class DiscoverFilter(val api: String, val label: String) {
    All("all", "All"),
    Podcasts("podcasts", "Podcasts"),
    Youtube("youtube", "YouTube"),
}

enum class DiscoverBrowseTab(val api: String, val label: String) {
    ForYou("forYou", "For You"),
    Popular("popular", "Popular"),
    Recent("recent", "Recently followed"),
}

enum class DiscoverResultsMode {
    Search,
    Browse,
}

data class DiscoveryResult(
    val provider: String,
    val type: String,
    val externalId: String,
    val title: String,
    val description: String? = null,
    val imageUrl: String? = null,
    val publisher: String? = null,
    val feedUrl: String? = null,
    val parentExternalId: String? = null,
    val parentTitle: String? = null,
    val subscribed: Boolean = false,
    val watchUrl: String? = null,
    val recommendationReason: String? = null,
    val recommendationToken: String? = null,
) {
    val resultKey: String get() = "$provider:$type:$externalId"
}

data class DiscoverSearchPage(
    val query: String,
    val filter: DiscoverFilter,
    val results: List<DiscoveryResult>,
    val warnings: List<String>,
    val hasMore: Boolean,
    val nextOffset: Int,
)

data class DiscoverBrowsePage(
    val results: List<DiscoveryResult>,
    val hasMore: Boolean,
    val total: Int,
    val message: String? = null,
)

data class DiscoverFollowSetup(
    val channelId: String,
    val title: String,
    val description: String?,
    val thumbnailUrl: String?,
    val recommendationToken: String?,
)

class ApiException(val code: Int, message: String) : Exception(message)
