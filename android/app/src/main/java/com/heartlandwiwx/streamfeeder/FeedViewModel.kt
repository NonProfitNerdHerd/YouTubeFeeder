package com.heartlandwiwx.streamfeeder

import android.app.Application
import android.content.res.Configuration
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.heartlandwiwx.streamfeeder.data.ApiClient
import com.heartlandwiwx.streamfeeder.data.ApiException
import com.heartlandwiwx.streamfeeder.data.AppTheme
import com.heartlandwiwx.streamfeeder.data.CategoryRecord
import com.heartlandwiwx.streamfeeder.data.ChannelRecord
import com.heartlandwiwx.streamfeeder.data.CurrentUser
import com.heartlandwiwx.streamfeeder.data.InboxItem
import com.heartlandwiwx.streamfeeder.data.InboxWatchFields
import com.heartlandwiwx.streamfeeder.data.LiveSourceRecord
import com.heartlandwiwx.streamfeeder.data.SessionStore
import com.heartlandwiwx.streamfeeder.data.WatchedFilter
import com.heartlandwiwx.streamfeeder.data.WatchlistRecord
import com.heartlandwiwx.streamfeeder.data.PROGRESS_PERSIST_MS
import com.heartlandwiwx.streamfeeder.data.createPlaybackSampler
import com.heartlandwiwx.streamfeeder.data.meetsWatchThreshold
import com.heartlandwiwx.streamfeeder.data.samplePlayback
import com.heartlandwiwx.streamfeeder.data.setSamplerPlaying
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant

enum class FeedView(val api: String, val label: String) {
    Inbox("inbox", "Inbox"),
    Watchlist("watchlist", "Watchlist"),
    Snoozed("snoozed", "Snoozed"),
    Streams("inbox", "Subscriptions"),
    Categories("inbox", "By Category"),
    Deleted("deleted", "Deleted"),
    Settings("settings", "Settings"),
    LiveGrid("live", "Grid"),
    LiveStreams("live", "Streams"),
    LiveCategories("live", "Categories");

    val isLocal: Boolean
        get() = this == Settings || this == LiveGrid || this == LiveStreams || this == LiveCategories

    val isFeedSection: Boolean
        get() = this == Inbox || this == Categories || this == Streams || this == Snoozed || this == Deleted

    val isLiveSection: Boolean
        get() = this == LiveGrid || this == LiveStreams || this == LiveCategories
}

data class FeedUiState(
    val booting: Boolean = true,
    val signedIn: Boolean = false,
    val user: CurrentUser? = null,
    val items: List<InboxItem> = emptyList(),
    val categories: List<CategoryRecord> = emptyList(),
    val channels: List<ChannelRecord> = emptyList(),
    val watchlists: List<WatchlistRecord> = emptyList(),
    val view: FeedView = FeedView.Inbox,
    val categoryId: String? = null,
    val channelId: String? = null,
    val watchlistId: String? = null,
    val browsingChannelId: String? = null,
    val selected: InboxItem? = null,
    val pendingSnoozeItem: InboxItem? = null,
    val snoozeExitVideoId: String? = null,
    val snoozeExitUntilMillis: Long? = null,
    val editingChannel: ChannelRecord? = null,
    val undoArchiveVideoId: String? = null,
    val undoWatchlistVideoId: String? = null,
    val undoWatchlistId: String? = null,
    val syncing: Boolean = false,
    val status: String? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val message: String? = null,
    val watchedFilter: WatchedFilter = WatchedFilter.All,
    val unwatchedCount: Int = 0,
    val theme: AppTheme = AppTheme.Dark,
    val liveSources: List<LiveSourceRecord> = emptyList(),
    val liveCategories: List<CategoryRecord> = emptyList(),
    val liveRefreshing: Boolean = false,
    val playthroughActive: Boolean = false,
    val playthroughQueue: List<InboxItem> = emptyList(),
)

class FeedViewModel(app: Application) : AndroidViewModel(app) {
    private val sessions = SessionStore(app)
    private var token: String? = null
    private val api = ApiClient { token }

    private val _state = MutableStateFlow(FeedUiState())
    val state: StateFlow<FeedUiState> = _state.asStateFlow()
    private var sampler = createPlaybackSampler()
    private var samplerVideoId: String? = null
    private var lastPosition = 0.0
    private var lastSentSeconds = 0.0
    private var playbackEnded = false
    private var persistJob: Job? = null

    init {
        viewModelScope.launch {
            val storedTheme = sessions.themeFlow.first()
            val theme = storedTheme ?: defaultTheme()
            token = sessions.tokenFlow.first()
            if (token.isNullOrBlank()) {
                _state.update { it.copy(booting = false, signedIn = false, theme = theme) }
            } else {
                _state.update { it.copy(theme = theme) }
                refreshAll(showBoot = true)
            }
        }
    }

    fun loginUrl(): String = api.loginUrl()

    fun setTheme(theme: AppTheme) {
        viewModelScope.launch {
            sessions.saveTheme(theme)
            _state.update { it.copy(theme = theme) }
        }
    }

    private fun defaultTheme(): AppTheme {
        val night = getApplication<Application>().resources.configuration.uiMode and
            Configuration.UI_MODE_NIGHT_MASK
        return if (night == Configuration.UI_MODE_NIGHT_YES) AppTheme.Dark else AppTheme.Light
    }

    fun onOAuthToken(tokenValue: String) {
        viewModelScope.launch {
            token = tokenValue
            sessions.saveToken(tokenValue)
            refreshAll(showBoot = true)
        }
    }

    fun onOAuthError(message: String) {
        _state.update { it.copy(booting = false, signedIn = false, error = message) }
    }

    fun onAppResume() {
        if (!_state.value.signedIn) return
        viewModelScope.launch {
            try {
                val newest = api.syncStatus().newestInboxPublishedAt ?: return@launch
                val current = _state.value.items.firstOrNull()?.publishedAt
                if (inboxHeadIsStale(current, newest)) refreshFeed()
            } catch (_: Exception) {
            }
        }
    }

    private fun inboxHeadIsStale(current: String?, server: String): Boolean {
        if (current.isNullOrBlank()) return true
        return try {
            Instant.parse(server).isAfter(Instant.parse(current))
        } catch (_: Exception) {
            server > current
        }
    }

    fun selectView(view: FeedView) {
        _state.update {
            it.copy(
                view = view,
                selected = null,
                browsingChannelId = null,
                pendingSnoozeItem = null,
                snoozeExitVideoId = null,
                snoozeExitUntilMillis = null,
                editingChannel = null,
                playthroughActive = false,
                playthroughQueue = emptyList(),
                categoryId = if (view.isFeedSection || view.isLocal) null else it.categoryId,
                items = if (view == FeedView.Streams || view == FeedView.Categories || view.isLocal) {
                    emptyList()
                } else {
                    it.items
                },
            )
        }
        if (view.isLiveSection) {
            loadLive()
            return
        }
        if (view.isLocal) return
        if (view != FeedView.Streams && view != FeedView.Categories) {
            refreshFeed()
        } else {
            refreshMeta()
        }
    }

    fun selectCategory(id: String?) {
        val view = _state.value.view
        _state.update {
            it.copy(
                categoryId = id,
                selected = null,
                items = if (view == FeedView.Categories && id == null) emptyList() else it.items,
            )
        }
        if (
            view == FeedView.Inbox ||
            view == FeedView.Snoozed ||
            view == FeedView.Deleted ||
            (view == FeedView.Categories && id != null)
        ) {
            refreshFeed()
        }
    }

    fun renameCategory(id: String, name: String) {
        viewModelScope.launch {
            try {
                api.renameCategory(id, name.trim())
                refreshMeta()
                _state.update { it.copy(message = "Category updated") }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not rename category") }
            }
        }
    }

    fun selectWatchlist(id: String?) {
        _state.update { it.copy(watchlistId = id, selected = null) }
        refreshFeed()
    }

    fun openStream(channelId: String) {
        _state.update { it.copy(browsingChannelId = channelId, selected = null) }
        refreshFeed()
    }

    fun closeStream() {
        _state.update { it.copy(browsingChannelId = null, items = emptyList(), editingChannel = null) }
    }

    fun openItem(item: InboxItem) {
        if (_state.value.playthroughActive) stopPlaythrough()
        _state.update { it.copy(selected = item) }
    }

    fun closeItem() {
        flushPlayback()
        stopPlaythrough()
        _state.update { it.copy(selected = null) }
    }

    fun startPlaythrough() {
        val state = _state.value
        val queue = state.items.filter { it.embeddable }
        if (queue.isEmpty()) return
        val start = queue.firstOrNull { it.videoId == state.selected?.videoId } ?: queue.first()
        _state.update { it.copy(playthroughActive = true, playthroughQueue = queue, selected = start) }
    }

    fun stopPlaythrough() {
        if (!_state.value.playthroughActive && _state.value.playthroughQueue.isEmpty()) return
        _state.update { it.copy(playthroughActive = false, playthroughQueue = emptyList()) }
    }

    fun selectWatchedFilter(filter: WatchedFilter) {
        if (filter == _state.value.watchedFilter) return
        _state.update { it.copy(watchedFilter = filter) }
        refreshFeed()
    }

    fun clearMessage() {
        _state.update {
            it.copy(
                message = null,
                error = null,
                undoArchiveVideoId = null,
                undoWatchlistVideoId = null,
                undoWatchlistId = null,
            )
        }
    }

    fun refresh() {
        refreshAll(showBoot = false)
    }

    fun refreshLiveStatuses() {
        if (_state.value.liveRefreshing) return
        viewModelScope.launch {
            _state.update { it.copy(liveRefreshing = true, error = null) }
            try {
                val (sources, status) = api.refreshLiveStatuses()
                _state.update {
                    it.copy(liveRefreshing = false, liveSources = sources, message = status)
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(liveRefreshing = false, error = e.message ?: "Could not refresh live statuses")
                }
            }
        }
    }

    private fun loadLive() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val sources = api.liveSources()
                val categories = api.liveCategories()
                _state.update {
                    it.copy(loading = false, liveSources = sources, liveCategories = categories)
                }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = e.message ?: "Could not load live sources") }
            }
        }
    }

    fun deleteSelected() {
        val item = _state.value.selected ?: return
        archiveVideo(item, leaveDetail = true)
    }

    fun restoreSelected() {
        val item = _state.value.selected ?: return
        mutate(item.videoId, JSONObject().put("action", "restore"), "Restored", clearSelected = true)
    }

    fun unsnoozeSelected() {
        val item = _state.value.selected ?: return
        mutate(item.videoId, JSONObject().put("action", "unsnooze"), "Unsnoozed", clearSelected = true)
    }

    fun snoozeSelected(untilEpochMillis: Long) {
        val item = _state.value.selected ?: return
        startSnoozeExit(item, untilEpochMillis)
    }

    fun archiveItem(item: InboxItem) {
        archiveVideo(item, leaveDetail = false)
    }

    fun archiveVideos(videoIds: List<String>) {
        if (videoIds.isEmpty()) return
        val idSet = videoIds.toSet()
        _state.update {
            val next = if (it.selected?.videoId in idSet) nextAfterRemoval(it.items, idSet) else it.selected
            it.copy(
                items = it.items.filterNot { row -> row.videoId in idSet },
                selected = next,
                undoArchiveVideoId = null,
                undoWatchlistVideoId = null,
                undoWatchlistId = null,
            )
        }
        viewModelScope.launch {
            var ok = 0
            for (id in videoIds) {
                try {
                    api.patchInbox(id, JSONObject().put("action", "delete"))
                    ok++
                } catch (_: Exception) {
                }
            }
            _state.update {
                it.copy(
                    error = if (ok < videoIds.size) "Some videos could not be archived" else null,
                )
            }
            if (ok < videoIds.size) refreshFeed()
            if (_state.value.view == FeedView.Watchlist) refreshMeta()
        }
    }

    fun moveVideosToWatchlist(listId: String, videoIds: List<String>) {
        if (videoIds.isEmpty()) return
        val listName = _state.value.watchlists.firstOrNull { it.id == listId }?.name ?: "watchlist"
        val idSet = videoIds.toSet()
        _state.update {
            val next = if (it.selected?.videoId in idSet) nextAfterRemoval(it.items, idSet) else it.selected
            it.copy(
                items = it.items.filterNot { row -> row.videoId in idSet },
                selected = next,
                undoArchiveVideoId = null,
                undoWatchlistVideoId = null,
                undoWatchlistId = null,
            )
        }
        viewModelScope.launch {
            var ok = 0
            for (id in videoIds) {
                try {
                    api.addToWatchlist(listId, id)
                    api.patchInbox(id, JSONObject().put("action", "delete"))
                    ok++
                } catch (_: Exception) {
                }
            }
            _state.update {
                it.copy(
                    message = if (ok == 1) "Moved 1 video to $listName" else "Moved $ok videos to $listName",
                    error = if (ok < videoIds.size) "Some videos could not be moved" else null,
                )
            }
            refreshMeta()
            if (ok < videoIds.size) refreshFeed()
        }
    }

    fun snoozeVideos(videoIds: List<String>, untilEpochMillis: Long) {
        if (videoIds.isEmpty()) return
        val until = Instant.ofEpochMilli(untilEpochMillis).toString()
        val idSet = videoIds.toSet()
        _state.update {
            val next = if (it.selected?.videoId in idSet) nextAfterRemoval(it.items, idSet) else it.selected
            it.copy(
                items = it.items.filterNot { row -> row.videoId in idSet },
                selected = next,
                undoArchiveVideoId = null,
                undoWatchlistVideoId = null,
                undoWatchlistId = null,
            )
        }
        viewModelScope.launch {
            var ok = 0
            for (id in videoIds) {
                try {
                    api.patchInbox(id, JSONObject().put("action", "snooze").put("until", until))
                    ok++
                } catch (_: Exception) {
                }
            }
            _state.update {
                it.copy(
                    message = if (ok == 1) "Snoozed 1 video" else "Snoozed $ok videos",
                    error = if (ok < videoIds.size) "Some videos could not be snoozed" else null,
                )
            }
            if (ok < videoIds.size) refreshFeed()
        }
    }

    fun requestSnooze(item: InboxItem) {
        _state.update { it.copy(pendingSnoozeItem = item) }
    }

    fun cancelPendingSnooze() {
        _state.update { it.copy(pendingSnoozeItem = null) }
    }

    fun confirmPendingSnooze(untilEpochMillis: Long) {
        val item = _state.value.pendingSnoozeItem ?: return
        startSnoozeExit(item, untilEpochMillis)
    }

    fun completeSnoozeExit() {
        val s = _state.value
        val videoId = s.snoozeExitVideoId ?: return
        val untilMillis = s.snoozeExitUntilMillis ?: return
        val item = s.items.firstOrNull { it.videoId == videoId }
        _state.update { it.copy(snoozeExitVideoId = null, snoozeExitUntilMillis = null) }
        if (item != null) {
            snoozeItem(item, untilMillis)
        } else {
            val until = Instant.ofEpochMilli(untilMillis).toString()
            mutate(
                videoId,
                JSONObject().put("action", "snooze").put("until", until),
                "Snoozed",
                clearSelected = false,
                silent = true,
            )
        }
    }

    private fun startSnoozeExit(item: InboxItem, untilEpochMillis: Long) {
        if (_state.value.snoozeExitVideoId != null) return
        _state.update {
            it.copy(
                pendingSnoozeItem = null,
                selected = if (it.selected?.videoId == item.videoId) null else it.selected,
                snoozeExitVideoId = item.videoId,
                snoozeExitUntilMillis = untilEpochMillis,
            )
        }
    }

    fun snoozeItem(item: InboxItem, untilEpochMillis: Long) {
        val until = Instant.ofEpochMilli(untilEpochMillis).toString()
        _state.update {
            val next = if (it.selected?.videoId == item.videoId) {
                nextAfterRemoval(it.items, item.videoId)
            } else {
                it.selected
            }
            it.copy(
                items = it.items.filterNot { row -> row.videoId == item.videoId },
                selected = next,
            )
        }
        mutate(
            item.videoId,
            JSONObject().put("action", "snooze").put("until", until),
            "Snoozed",
            clearSelected = false,
            silent = true,
        )
    }

    fun undoArchive() {
        val videoId = _state.value.undoArchiveVideoId ?: return
        viewModelScope.launch {
            try {
                api.patchInbox(videoId, JSONObject().put("action", "restore"))
                _state.update { it.copy(message = "Restored", undoArchiveVideoId = null) }
                refreshFeed()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not undo", undoArchiveVideoId = null) }
            }
        }
    }

    fun addSelectedToWatchlist(listId: String) {
        val item = _state.value.selected ?: return
        val listName = _state.value.watchlists.firstOrNull { it.id == listId }?.name ?: "watchlist"
        viewModelScope.launch {
            try {
                api.addToWatchlist(listId, item.videoId)
                _state.update {
                    it.copy(
                        message = "Added to $listName",
                        undoWatchlistVideoId = item.videoId,
                        undoWatchlistId = listId,
                        undoArchiveVideoId = null,
                    )
                }
                refreshMeta()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not add to watchlist") }
            }
        }
    }

    fun undoWatchlistAdd() {
        val videoId = _state.value.undoWatchlistVideoId ?: return
        val listId = _state.value.undoWatchlistId ?: return
        viewModelScope.launch {
            try {
                api.removeFromWatchlist(listId, videoId)
                _state.update {
                    it.copy(
                        message = "Removed from watchlist",
                        undoWatchlistVideoId = null,
                        undoWatchlistId = null,
                    )
                }
                refreshMeta()
                refreshFeed()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not undo", undoWatchlistVideoId = null, undoWatchlistId = null) }
            }
        }
    }

    fun toggleWatched() {
        val item = _state.value.selected ?: return
        viewModelScope.launch {
            try {
                val body = JSONObject().put("action", if (item.watchedAt == null) "watch" else "unwatch")
                applyWatch(item.videoId, watchFieldsFrom(api.patchInbox(item.videoId, body)))
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not update watched status") }
            }
        }
    }

    fun markAllWatched() {
        viewModelScope.launch {
            try {
                val s = _state.value
                api.watchAllInbox(
                    view = inboxApiView(s),
                    categoryId = s.categoryId,
                    watchlistId = s.watchlistId,
                    channelId = s.browsingChannelId,
                    watched = s.watchedFilter.api,
                )
                val now = Instant.now().toString()
                _state.update { state ->
                    val mapped = state.items.map { item ->
                        if (item.watchedAt != null) item else item.copy(watchedAt = now)
                    }
                    state.copy(
                        items = mapped.filter { matchesFilter(it.watchedAt, state.watchedFilter) },
                        unwatchedCount = 0,
                        selected = state.selected?.let { sel ->
                            if (sel.watchedAt != null) sel else sel.copy(watchedAt = now)
                        },
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not mark videos watched") }
            }
        }
    }

    fun onPlayerEvent(videoId: String, type: String, currentTime: Double, rate: Double, duration: Double?) {
        if (samplerVideoId != videoId) {
            flushPlayback()
            val seed = _state.value.selected?.takeIf { it.videoId == videoId }?.playbackSeconds ?: 0.0
            samplerVideoId = videoId
            sampler = createPlaybackSampler(seed)
            lastSentSeconds = seed
            lastPosition = currentTime
            playbackEnded = false
        }
        lastPosition = currentTime
        when (type) {
            "playing" -> {
                playbackEnded = false
                sampler = setSamplerPlaying(sampler, true)
                sampler = samplePlayback(sampler, currentTime, System.currentTimeMillis(), rate)
            }
            "time" -> {
                sampler = samplePlayback(sampler, currentTime, System.currentTimeMillis(), rate)
                val itemDuration = _state.value.selected?.durationSeconds ?: duration
                if (meetsWatchThreshold(sampler.playbackSeconds, itemDuration, false)) {
                    persistProgress(videoId, sampler.playbackSeconds, currentTime, ended = false)
                } else {
                    schedulePersist(videoId)
                }
            }
            "paused", "buffering" -> {
                sampler = setSamplerPlaying(sampler, false)
                persistProgress(videoId, sampler.playbackSeconds, currentTime, ended = false)
            }
            "ended" -> {
                playbackEnded = true
                sampler = setSamplerPlaying(sampler, false)
                persistProgress(videoId, sampler.playbackSeconds, currentTime, ended = true)
                advancePlaythrough(videoId)
            }
        }
    }

    private fun advancePlaythrough(currentId: String) {
        val state = _state.value
        if (!state.playthroughActive) return
        val queue = state.playthroughQueue
        val index = queue.indexOfFirst { it.videoId == currentId }
        val next = if (index < 0) queue.firstOrNull() else queue.getOrNull(index + 1)
        if (next == null) {
            stopPlaythrough()
            return
        }
        samplerVideoId = null
        _state.update { it.copy(selected = next) }
    }
        val id = samplerVideoId ?: return
        persistProgress(id, sampler.playbackSeconds, lastPosition, playbackEnded)
    }

    private fun schedulePersist(videoId: String) {
        persistJob?.cancel()
        persistJob = viewModelScope.launch {
            delay(PROGRESS_PERSIST_MS)
            persistProgress(videoId, sampler.playbackSeconds, lastPosition, playbackEnded)
        }
    }

    private fun persistProgress(
        videoId: String,
        playbackSeconds: Double,
        lastPositionSeconds: Double,
        ended: Boolean,
    ) {
        if (playbackSeconds <= 0.0 && !ended) return
        if (!ended && playbackSeconds <= lastSentSeconds + 0.05) return
        lastSentSeconds = playbackSeconds
        persistJob?.cancel()
        viewModelScope.launch {
            try {
                val body = JSONObject()
                    .put("action", "progress")
                    .put("playbackSeconds", playbackSeconds)
                    .put("lastPositionSeconds", lastPositionSeconds)
                    .put("ended", ended)
                applyWatch(videoId, watchFieldsFrom(api.patchInbox(videoId, body)))
            } catch (_: Exception) {
            }
        }
    }

    private fun applyWatch(videoId: String, fields: InboxWatchFields) {
        _state.update { state ->
            val previous = state.items.find { it.videoId == videoId } ?: state.selected?.takeIf { it.videoId == videoId }
            val mapped = state.items.map { item ->
                if (item.videoId != videoId) item
                else item.copy(
                    watchedAt = fields.watchedAt,
                    playbackSeconds = fields.playbackSeconds,
                    lastPositionSeconds = fields.lastPositionSeconds,
                )
            }
            val unwatched = when {
                previous?.watchedAt == null && fields.watchedAt != null -> (state.unwatchedCount - 1).coerceAtLeast(0)
                previous?.watchedAt != null && fields.watchedAt == null -> state.unwatchedCount + 1
                else -> state.unwatchedCount
            }
            state.copy(
                items = mapped.filter { matchesFilter(it.watchedAt, state.watchedFilter) },
                unwatchedCount = unwatched,
                selected = state.selected?.let { sel ->
                    if (sel.videoId != videoId) sel
                    else sel.copy(
                        watchedAt = fields.watchedAt,
                        playbackSeconds = fields.playbackSeconds,
                        lastPositionSeconds = fields.lastPositionSeconds,
                    )
                },
            )
        }
    }

    private fun watchFieldsFrom(obj: JSONObject) = InboxWatchFields(
        watchedAt = if (obj.has("watchedAt") && !obj.isNull("watchedAt")) {
            obj.optString("watchedAt").ifBlank { null }
        } else {
            null
        },
        playbackSeconds = obj.optDouble("playbackSeconds", 0.0),
        lastPositionSeconds = obj.optDouble("lastPositionSeconds", 0.0),
        watchUpdatedAt = if (obj.has("watchUpdatedAt") && !obj.isNull("watchUpdatedAt")) {
            obj.optString("watchUpdatedAt").ifBlank { null }
        } else {
            null
        },
    )

    private fun matchesFilter(watchedAt: String?, filter: WatchedFilter): Boolean = when (filter) {
        WatchedFilter.All -> true
        WatchedFilter.Watched -> watchedAt != null
        WatchedFilter.Unwatched -> watchedAt == null
    }

    private fun inboxApiView(state: FeedUiState): String = when (state.view) {
        FeedView.Watchlist -> "watchlist"
        FeedView.Snoozed -> "snoozed"
        FeedView.Deleted -> "deleted"
        else -> "inbox"
    }

    fun saveNotes(notes: String) {
        val item = _state.value.selected ?: return
        viewModelScope.launch {
            try {
                api.patchInbox(item.videoId, JSONObject().put("action", "notes").put("notes", notes))
                _state.update { state ->
                    state.copy(
                        selected = state.selected?.copy(notes = notes),
                        items = state.items.map { if (it.videoId == item.videoId) it.copy(notes = notes) else it },
                        message = "Notes saved",
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not save notes") }
            }
        }
    }

    fun createWatchlist(name: String) {
        viewModelScope.launch {
            try {
                val created = api.createWatchlist(name.trim())
                refreshMeta()
                _state.update { it.copy(watchlistId = created.id, message = "Watchlist created") }
                refreshFeed()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not create watchlist") }
            }
        }
    }

    fun createCategory(name: String) {
        viewModelScope.launch {
            try {
                api.createCategory(name.trim())
                refreshMeta()
                _state.update { it.copy(message = "Category created") }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not create category") }
            }
        }
    }

    fun deleteCategory(id: String) {
        viewModelScope.launch {
            try {
                api.deleteCategory(id)
                _state.update {
                    it.copy(
                        categoryId = if (it.categoryId == id) null else it.categoryId,
                        message = "Category deleted",
                    )
                }
                refreshMeta()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not delete category") }
            }
        }
    }

    fun openEditChannel(channel: ChannelRecord) {
        _state.update { it.copy(editingChannel = channel) }
    }

    fun closeEditChannel() {
        _state.update { it.copy(editingChannel = null) }
    }

    fun saveChannelEdit(followInInbox: Boolean, maxVideosToPull: Int, categoryIds: List<String>) {
        val channel = _state.value.editingChannel ?: return
        viewModelScope.launch {
            try {
                api.updateChannel(channel.channelId, followInInbox, maxVideosToPull.coerceIn(0, 500), categoryIds)
                _state.update { it.copy(editingChannel = null, message = "Stream saved") }
                refreshMeta()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not save stream") }
            }
        }
    }

    fun syncSubscriptions() {
        viewModelScope.launch {
            _state.update { it.copy(syncing = true, error = null, status = "Syncing subscriptions…") }
            try {
                val count = api.syncSubscriptions()
                refreshMeta()
                _state.update { it.copy(syncing = false, status = null, message = "Updated $count subscriptions") }
            } catch (e: Exception) {
                _state.update { it.copy(syncing = false, status = null, error = e.message ?: "Subscription sync failed") }
            }
        }
    }

    fun catchUpBrowsingChannel() {
        val channelId = _state.value.browsingChannelId ?: return
        val channel = _state.value.channels.firstOrNull { it.channelId == channelId } ?: return
        if (channel.maxVideosToPull < 1) {
            _state.update { it.copy(error = "Set max videos to pull above 0 on Edit, then catch up.") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(syncing = true, error = null, status = "Catching up ${channel.title}…") }
            try {
                val added = api.catchUpChannel(channel.channelId, channel.maxVideosToPull) { pulled, want ->
                    _state.update { it.copy(status = "Catching up ${channel.title}… $pulled / $want") }
                }
                refreshFeed()
                _state.update {
                    it.copy(syncing = false, status = null, message = "Added $added videos from ${channel.title}")
                }
            } catch (e: Exception) {
                _state.update { it.copy(syncing = false, status = null, error = e.message ?: "Catch up failed") }
            }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            api.logout()
            token = null
            sessions.clear()
            _state.value = FeedUiState(booting = false, signedIn = false, theme = _state.value.theme)
        }
    }

    private fun archiveVideo(item: InboxItem, leaveDetail: Boolean) {
        _state.update {
            val shouldAdvance = leaveDetail || it.selected?.videoId == item.videoId
            val next = if (shouldAdvance) nextAfterRemoval(it.items, item.videoId) else it.selected
            it.copy(
                items = it.items.filterNot { row -> row.videoId == item.videoId },
                selected = next,
                undoArchiveVideoId = null,
                undoWatchlistVideoId = null,
                undoWatchlistId = null,
            )
        }
        viewModelScope.launch {
            try {
                api.patchInbox(item.videoId, JSONObject().put("action", "delete"))
                if (_state.value.view == FeedView.Watchlist) refreshMeta()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not archive") }
                refreshFeed()
            }
        }
    }

    private fun mutate(
        videoId: String,
        body: JSONObject,
        okMessage: String,
        clearSelected: Boolean = true,
        silent: Boolean = false,
    ) {
        val action = body.optString("action")
        val removesFromList = action == "delete" || action == "restore" || action == "snooze" || action == "unsnooze"
        if (removesFromList) {
            _state.update {
                val shouldAdvance = clearSelected || it.selected?.videoId == videoId
                val next = if (shouldAdvance) nextAfterRemoval(it.items, videoId) else it.selected
                it.copy(
                    items = it.items.filterNot { row -> row.videoId == videoId },
                    selected = next,
                    message = if (silent) it.message else okMessage,
                )
            }
        }
        viewModelScope.launch {
            try {
                api.patchInbox(videoId, body)
                if (!removesFromList) {
                    _state.update {
                        it.copy(
                            message = if (silent) null else okMessage,
                            selected = if (clearSelected) null else it.selected,
                        )
                    }
                } else if (!silent) {
                    // Keep optimistic selection; refresh list in background.
                    refreshFeed()
                }
                if (_state.value.view == FeedView.Watchlist || action == "delete") {
                    refreshMeta()
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Action failed") }
                refreshFeed()
            }
        }
    }

    private fun nextAfterRemoval(items: List<InboxItem>, removedId: String): InboxItem? =
        nextAfterRemoval(items, setOf(removedId))

    private fun nextAfterRemoval(items: List<InboxItem>, removedIds: Set<String>): InboxItem? {
        val index = items.indexOfFirst { it.videoId in removedIds }
        if (index < 0) return items.firstOrNull { it.videoId !in removedIds }
        items.drop(index + 1).firstOrNull { it.videoId !in removedIds }?.let { return it }
        return items.take(index).lastOrNull { it.videoId !in removedIds }
    }

    private fun refreshAll(showBoot: Boolean) {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, booting = showBoot, error = null) }
            try {
                val user = api.me()
                val categories = api.categories()
                val channels = api.channels()
                val watchlists = api.watchlists()
                _state.update {
                    it.copy(
                        user = user,
                        categories = categories,
                        channels = channels,
                        watchlists = watchlists,
                        watchlistId = it.watchlistId ?: watchlists.firstOrNull()?.id,
                        signedIn = true,
                    )
                }
                val items = if (
                    _state.value.view.isLocal ||
                    (_state.value.view == FeedView.Streams && _state.value.browsingChannelId == null) ||
                    (_state.value.view == FeedView.Categories && _state.value.categoryId == null)
                ) {
                    emptyList()
                } else {
                    loadInbox()
                }
                _state.update {
                    it.copy(booting = false, loading = false, items = items)
                }
            } catch (e: ApiException) {
                if (e.code == 401) {
                    token = null
                    sessions.clear()
                    _state.update { FeedUiState(booting = false, signedIn = false, error = "Sign in required", theme = it.theme) }
                } else {
                    _state.update { it.copy(booting = false, loading = false, error = e.message) }
                }
            } catch (e: Exception) {
                _state.update { it.copy(booting = false, loading = false, error = e.message ?: "Load failed") }
            }
        }
    }

    private fun refreshFeed() {
        viewModelScope.launch {
            if (
                _state.value.view.isLocal ||
                (_state.value.view == FeedView.Streams && _state.value.browsingChannelId == null) ||
                (_state.value.view == FeedView.Categories && _state.value.categoryId == null)
            ) {
                _state.update { it.copy(loading = false, items = emptyList()) }
                return@launch
            }
            _state.update { it.copy(loading = true, error = null) }
            try {
                val items = loadInbox()
                _state.update { it.copy(loading = false, items = items) }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = e.message ?: "Could not load feed") }
            }
        }
    }

    private fun refreshMeta() {
        viewModelScope.launch {
            try {
                val categories = api.categories()
                val channels = api.channels()
                val watchlists = api.watchlists()
                _state.update {
                    it.copy(categories = categories, channels = channels, watchlists = watchlists)
                }
            } catch (_: Exception) {
            }
        }
    }

    private suspend fun loadInbox(): List<InboxItem> {
        val s = _state.value
        val watched = s.watchedFilter.api
        val page = when (s.view) {
            FeedView.Watchlist -> api.inbox(view = "watchlist", watchlistId = s.watchlistId, watched = watched)
            FeedView.Streams -> {
                val channelId = s.browsingChannelId ?: return emptyList()
                api.inbox(view = "inbox", channelId = channelId, watched = watched)
            }
            FeedView.Categories -> {
                val categoryId = s.categoryId ?: return emptyList()
                api.inbox(view = "inbox", categoryId = categoryId, watched = watched)
            }
            FeedView.Inbox -> api.inbox(view = "inbox", categoryId = s.categoryId, watched = watched)
            FeedView.Snoozed, FeedView.Deleted -> api.inbox(view = s.view.api, categoryId = s.categoryId, watched = watched)
            FeedView.Settings, FeedView.LiveGrid, FeedView.LiveStreams, FeedView.LiveCategories -> return emptyList()
        }
        _state.update { it.copy(unwatchedCount = page.unwatchedCount) }
        return page.items
    }
}
