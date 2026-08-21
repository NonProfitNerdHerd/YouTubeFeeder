package com.heartlandwiwx.streamfeeder

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.heartlandwiwx.streamfeeder.ui.FeedScreen
import com.heartlandwiwx.streamfeeder.ui.LoginScreen
import com.heartlandwiwx.streamfeeder.ui.StreamFeederTheme

class MainActivity : AppCompatActivity() {
    private val viewModel: FeedViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleAuthIntent(intent)
        setContent {
            val state by viewModel.state.collectAsState()
            StreamFeederTheme(theme = state.theme) {
                when {
                    state.booting -> {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    }
                    !state.signedIn -> {
                        LoginScreen(
                            loginUrl = viewModel.loginUrl(),
                            error = state.error,
                            onClearError = viewModel::clearMessage,
                        )
                    }
                    else -> {
                        FeedScreen(
                            state = state,
                            onSelectView = viewModel::selectView,
                            onSelectCategory = viewModel::selectCategory,
                            onSelectWatchlist = viewModel::selectWatchlist,
                            onOpenStream = viewModel::openStream,
                            onCloseStream = viewModel::closeStream,
                            onOpen = viewModel::openItem,
                            onClose = viewModel::closeItem,
                            onSignOut = viewModel::signOut,
                            onDelete = viewModel::deleteSelected,
                            onRestore = viewModel::restoreSelected,
                            onSnooze = viewModel::snoozeSelected,
                            onUnsnooze = viewModel::unsnoozeSelected,
                            onAddWatchlist = viewModel::addSelectedToWatchlist,
                            onSaveNotes = viewModel::saveNotes,
                            onArchiveItem = viewModel::archiveItem,
                            onArchiveVideos = viewModel::archiveVideos,
                            onSnoozeVideos = viewModel::snoozeVideos,
                            onMoveVideosToWatchlist = viewModel::moveVideosToWatchlist,
                            onRequestSnooze = viewModel::requestSnooze,
                            onConfirmPendingSnooze = viewModel::confirmPendingSnooze,
                            onCancelPendingSnooze = viewModel::cancelPendingSnooze,
                            onCompleteSnoozeExit = viewModel::completeSnoozeExit,
                            onUndoArchive = viewModel::undoArchive,
                            onUndoWatchlist = viewModel::undoWatchlistAdd,
                            onCreateWatchlist = viewModel::createWatchlist,
                            onCreateCategory = viewModel::createCategory,
                            onRenameCategory = viewModel::renameCategory,
                            onDeleteCategory = viewModel::deleteCategory,
                            onCatchUp = viewModel::catchUpBrowsingChannel,
                            onOpenEditChannel = viewModel::openEditChannel,
                            onCloseEditChannel = viewModel::closeEditChannel,
                            onSaveChannelEdit = viewModel::saveChannelEdit,
                            onClearMessage = viewModel::clearMessage,
                            onSelectWatchedFilter = viewModel::selectWatchedFilter,
                            onMarkAllWatched = viewModel::markAllWatched,
                            onToggleWatched = viewModel::toggleWatched,
                            onSelectTheme = viewModel::setTheme,
                            onRefreshLive = viewModel::refreshLiveStatuses,
                            onRefreshOneLiveSource = viewModel::refreshOneLiveSource,
                            onPlayerEvent = viewModel::onPlayerEvent,
                            onFlushPlayback = viewModel::flushPlayback,
                            onPlaythrough = viewModel::startPlaythrough,
                            onPlaythroughFrom = viewModel::startPlaythroughFrom,
                            onStopPlaythrough = viewModel::stopPlaythrough,
                            onPlaythroughNext = viewModel::playthroughNext,
                            onPlaythroughPrevious = viewModel::playthroughPrevious,
                            onPlaythroughArchive = viewModel::playthroughArchiveAndAdvance,
                            onLoadMore = viewModel::loadMoreFeed,
                            onCloseDiscoverResults = viewModel::closeDiscoverResults,
                            onSetDiscoverQuery = viewModel::setDiscoverQuery,
                            onOpenDiscoverBrowse = viewModel::openDiscoverBrowse,
                            onRunDiscoverSearch = viewModel::runDiscoverSearch,
                            onSelectDiscoverFilter = viewModel::selectDiscoverFilter,
                            onLoadMoreDiscover = viewModel::loadMoreDiscover,
                            onRequestDiscoverFollow = viewModel::requestDiscoverFollow,
                            onCancelDiscoverFollow = viewModel::cancelDiscoverFollow,
                            onConfirmDiscoverFollow = viewModel::confirmDiscoverFollow,
                            onUnfollowDiscoverYoutube = viewModel::unfollowDiscoverYoutube,
                            onSubscribeDiscoverPodcast = viewModel::subscribeDiscoverPodcast,
                            onSubmitDiscoverNotInterested = viewModel::submitDiscoverNotInterested,
                            onUndoDiscoverFeedback = viewModel::undoDiscoverFeedback,
                        )
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        viewModel.onAppResume()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthIntent(intent)
    }

    private fun handleAuthIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "streamfeeder" || data.host != "oauth") return
        val error = data.getQueryParameter("error")
        val token = data.getQueryParameter("token")
        when {
            !error.isNullOrBlank() -> viewModel.onOAuthError(error)
            !token.isNullOrBlank() -> viewModel.onOAuthToken(token)
        }
    }
}
