package com.heartlandwiwx.streamfeeder

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.heartlandwiwx.streamfeeder.data.ApiClient
import com.heartlandwiwx.streamfeeder.data.ApiException
import com.heartlandwiwx.streamfeeder.data.CategoryRecord
import com.heartlandwiwx.streamfeeder.data.ChannelRecord
import com.heartlandwiwx.streamfeeder.data.CurrentUser
import com.heartlandwiwx.streamfeeder.data.InboxItem
import com.heartlandwiwx.streamfeeder.data.SessionStore
import com.heartlandwiwx.streamfeeder.data.WatchlistRecord
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import java.time.temporal.ChronoUnit

enum class FeedView(val api: String, val label: String) {
    Inbox("inbox", "Inbox"),
    Watchlist("watchlist", "Watchlist"),
    Snoozed("snoozed", "Snoozed"),
    Categories("inbox", "Categories"),
    Streams("inbox", "Streams"),
    Deleted("deleted", "Deleted"),
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
    val editingChannel: ChannelRecord? = null,
    val undoArchiveVideoId: String? = null,
    val undoWatchlistVideoId: String? = null,
    val undoWatchlistId: String? = null,
    val syncing: Boolean = false,
    val status: String? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val message: String? = null,
)

class FeedViewModel(app: Application) : AndroidViewModel(app) {
    private val sessions = SessionStore(app)
    private var token: String? = null
    private val api = ApiClient { token }

    private val _state = MutableStateFlow(FeedUiState())
    val state: StateFlow<FeedUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            token = sessions.tokenFlow.first()
            if (token.isNullOrBlank()) {
                _state.update { it.copy(booting = false, signedIn = false) }
            } else {
                refreshAll(showBoot = true)
            }
        }
    }

    fun loginUrl(): String = api.loginUrl()

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

    fun selectView(view: FeedView) {
        _state.update {
            it.copy(
                view = view,
                selected = null,
                browsingChannelId = null,
                pendingSnoozeItem = null,
                editingChannel = null,
                items = if (view == FeedView.Categories || view == FeedView.Streams) emptyList() else it.items,
            )
        }
        if (view != FeedView.Categories && view != FeedView.Streams) {
            refreshFeed()
        } else if (view == FeedView.Streams) {
            refreshMeta()
        } else {
            refreshMeta()
        }
    }

    fun selectCategory(id: String?) {
        _state.update { it.copy(categoryId = id, selected = null) }
        if (_state.value.view == FeedView.Inbox) {
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
        _state.update { it.copy(selected = item) }
    }

    fun closeItem() {
        _state.update { it.copy(selected = null) }
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

    fun snoozeSelected(hours: Long) {
        val item = _state.value.selected ?: return
        val until = Instant.now().plus(hours, ChronoUnit.HOURS).toString()
        mutate(item.videoId, JSONObject().put("action", "snooze").put("until", until), "Snoozed", clearSelected = true)
    }

    fun archiveItem(item: InboxItem) {
        archiveVideo(item, leaveDetail = false)
    }

    fun requestSnooze(item: InboxItem) {
        _state.update { it.copy(pendingSnoozeItem = item) }
    }

    fun cancelPendingSnooze() {
        _state.update { it.copy(pendingSnoozeItem = null) }
    }

    fun confirmPendingSnooze(hours: Long) {
        val item = _state.value.pendingSnoozeItem ?: return
        _state.update { it.copy(pendingSnoozeItem = null) }
        snoozeItem(item, hours)
    }

    fun snoozeItem(item: InboxItem, hours: Long = 24) {
        val until = Instant.now().plus(hours, ChronoUnit.HOURS).toString()
        _state.update { it.copy(items = it.items.filterNot { row -> row.videoId == item.videoId }) }
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
            _state.value = FeedUiState(booting = false, signedIn = false)
        }
    }

    private fun archiveVideo(item: InboxItem, leaveDetail: Boolean) {
        _state.update {
            it.copy(
                items = it.items.filterNot { row -> row.videoId == item.videoId },
                selected = if (leaveDetail) null else it.selected,
                message = "Archived",
                undoArchiveVideoId = item.videoId,
                undoWatchlistVideoId = null,
                undoWatchlistId = null,
            )
        }
        viewModelScope.launch {
            try {
                api.patchInbox(item.videoId, JSONObject().put("action", "delete"))
                if (_state.value.view == FeedView.Watchlist) refreshMeta()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not archive", undoArchiveVideoId = null) }
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
        viewModelScope.launch {
            try {
                api.patchInbox(videoId, body)
                _state.update {
                    it.copy(
                        message = if (silent) null else okMessage,
                        selected = if (clearSelected) null else it.selected,
                    )
                }
                if (!silent) refreshFeed()
                if (_state.value.view == FeedView.Watchlist || body.optString("action") == "delete") {
                    refreshMeta()
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Action failed") }
                refreshFeed()
            }
        }
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
                val items = if (_state.value.view == FeedView.Categories ||
                    (_state.value.view == FeedView.Streams && _state.value.browsingChannelId == null)
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
                    _state.update { FeedUiState(booting = false, signedIn = false, error = "Sign in required") }
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
            if (_state.value.view == FeedView.Categories ||
                (_state.value.view == FeedView.Streams && _state.value.browsingChannelId == null)
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
        return when (s.view) {
            FeedView.Watchlist -> api.inbox(view = "watchlist", watchlistId = s.watchlistId)
            FeedView.Streams -> {
                val channelId = s.browsingChannelId ?: return emptyList()
                api.inbox(view = "inbox", channelId = channelId)
            }
            FeedView.Categories -> emptyList()
            FeedView.Inbox -> api.inbox(view = "inbox", categoryId = s.categoryId)
            else -> api.inbox(view = s.view.api)
        }
    }
}
