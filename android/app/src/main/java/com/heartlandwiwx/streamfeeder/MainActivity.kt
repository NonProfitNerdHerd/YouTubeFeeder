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
            StreamFeederTheme {
                val state by viewModel.state.collectAsState()
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
                        )
                    }
                }
            }
        }
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
