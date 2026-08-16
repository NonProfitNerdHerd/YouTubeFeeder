package com.heartlandwiwx.streamfeeder

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.heartlandwiwx.streamfeeder.data.ApiClient
import com.heartlandwiwx.streamfeeder.data.ApiException
import com.heartlandwiwx.streamfeeder.data.CategoryRecord
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
    Snoozed("snoozed", "Snoozed"),
    Deleted("deleted", "Deleted"),
    Watchlist("watchlist", "Watchlists"),
}

data class FeedUiState(
    val booting: Boolean = true,
    val signedIn: Boolean = false,
    val user: CurrentUser? = null,
    val items: List<InboxItem> = emptyList(),
    val categories: List<CategoryRecord> = emptyList(),
    val watchlists: List<WatchlistRecord> = emptyList(),
    val view: FeedView = FeedView.Inbox,
    val categoryId: String? = null,
    val watchlistId: String? = null,
    val selected: InboxItem? = null,
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
        _state.update { it.copy(view = view, selected = null) }
        refreshFeed()
    }

    fun selectCategory(id: String?) {
        _state.update { it.copy(categoryId = id, selected = null) }
        refreshFeed()
    }

    fun selectWatchlist(id: String?) {
        _state.update { it.copy(watchlistId = id, selected = null) }
        refreshFeed()
    }

    fun openItem(item: InboxItem) {
        _state.update { it.copy(selected = item) }
    }

    fun closeItem() {
        _state.update { it.copy(selected = null) }
    }

    fun clearMessage() {
        _state.update { it.copy(message = null, error = null) }
    }

    fun refresh() {
        refreshAll(showBoot = false)
    }

    fun deleteSelected() {
        val item = _state.value.selected ?: return
        mutate(item.videoId, JSONObject().put("action", "delete"), "Deleted")
    }

    fun restoreSelected() {
        val item = _state.value.selected ?: return
        mutate(item.videoId, JSONObject().put("action", "restore"), "Restored")
    }

    fun unsnoozeSelected() {
        val item = _state.value.selected ?: return
        mutate(item.videoId, JSONObject().put("action", "unsnooze"), "Unsnoozed")
    }

    fun snoozeSelected(hours: Long) {
        val item = _state.value.selected ?: return
        val until = Instant.now().plus(hours, ChronoUnit.HOURS).toString()
        mutate(item.videoId, JSONObject().put("action", "snooze").put("until", until), "Snoozed")
    }

    fun addSelectedToWatchlist(listId: String) {
        val item = _state.value.selected ?: return
        viewModelScope.launch {
            try {
                api.addToWatchlist(listId, item.videoId)
                _state.update { it.copy(message = "Added to watchlist", selected = null) }
                refreshAll(showBoot = false)
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Could not add to watchlist") }
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

    private fun mutate(videoId: String, body: JSONObject, okMessage: String) {
        viewModelScope.launch {
            try {
                api.patchInbox(videoId, body)
                _state.update { it.copy(message = okMessage, selected = null) }
                refreshFeed()
                if (_state.value.view == FeedView.Watchlist || body.optString("action") == "delete") {
                    refreshMeta()
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Action failed") }
            }
        }
    }

    private fun refreshAll(showBoot: Boolean) {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, booting = showBoot, error = null) }
            try {
                val user = api.me()
                val categories = api.categories()
                val watchlists = api.watchlists()
                val items = loadInbox()
                _state.update {
                    it.copy(
                        booting = false,
                        loading = false,
                        signedIn = true,
                        user = user,
                        categories = categories,
                        watchlists = watchlists,
                        items = items,
                        watchlistId = it.watchlistId ?: watchlists.firstOrNull()?.id,
                    )
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
                val watchlists = api.watchlists()
                _state.update { it.copy(watchlists = watchlists) }
            } catch (_: Exception) {
            }
        }
    }

    private suspend fun loadInbox(): List<InboxItem> {
        val s = _state.value
        return api.inbox(
            view = s.view.api,
            categoryId = if (s.view == FeedView.Watchlist) null else s.categoryId,
            watchlistId = if (s.view == FeedView.Watchlist) s.watchlistId else null,
        )
    }
}
