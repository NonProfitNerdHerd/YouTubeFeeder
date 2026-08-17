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

class ApiException(val code: Int, message: String) : Exception(message)
