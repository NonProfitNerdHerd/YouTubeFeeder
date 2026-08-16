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
    val thumbnailUrl: String,
    val publishedAt: String?,
    val embeddable: Boolean,
    val unread: Boolean,
    val hidden: Boolean,
    val snoozedUntil: String?,
    val notes: String,
)

data class CategoryRecord(
    val id: String,
    val name: String,
)

data class WatchlistRecord(
    val id: String,
    val name: String,
    val videoCount: Int,
)

class ApiException(val code: Int, message: String) : Exception(message)
