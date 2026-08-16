package com.heartlandwiwx.streamfeeder.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlaylistAdd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.mediarouter.app.MediaRouteButton
import coil.compose.AsyncImage
import com.google.android.gms.cast.framework.CastButtonFactory
import com.google.android.gms.cast.framework.CastContext
import com.heartlandwiwx.streamfeeder.BuildConfig
import com.heartlandwiwx.streamfeeder.FeedUiState
import com.heartlandwiwx.streamfeeder.FeedView
import com.heartlandwiwx.streamfeeder.data.CategoryRecord
import com.heartlandwiwx.streamfeeder.data.ChannelRecord
import com.heartlandwiwx.streamfeeder.data.InboxItem
import com.heartlandwiwx.streamfeeder.data.WatchlistRecord
import com.pierfrancescosoffritti.androidyoutubeplayer.chromecast.chromecastsender.ChromecastYouTubePlayerContext
import com.pierfrancescosoffritti.androidyoutubeplayer.chromecast.chromecastsender.io.infrastructure.ChromecastConnectionListener
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.YouTubePlayer
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.listeners.AbstractYouTubePlayerListener

private val PlayerBaseUrl = "https://youtube-feeder-worker.ike-j-rebout.workers.dev/"

@Composable
fun LoginScreen(loginUrl: String, error: String?, onClearError: () -> Unit) {
    val context = LocalContext.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("StreamFeeder", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(
            "Sign in with the same Google account as the website to see your feed.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = {
            CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(loginUrl))
        }) {
            Text("Sign in with Google")
        }
        Text(
            "v${BuildConfig.VERSION_NAME}",
            modifier = Modifier.padding(top = 16.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (!error.isNullOrBlank()) {
            Spacer(Modifier.height(16.dp))
            Text(error, color = MaterialTheme.colorScheme.error)
            TextButton(onClick = onClearError) { Text("Dismiss") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedScreen(
    state: FeedUiState,
    onSelectView: (FeedView) -> Unit,
    onSelectCategory: (String?) -> Unit,
    onSelectWatchlist: (String?) -> Unit,
    onOpenStream: (String) -> Unit,
    onCloseStream: () -> Unit,
    onOpen: (InboxItem) -> Unit,
    onClose: () -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
    onDelete: () -> Unit,
    onRestore: () -> Unit,
    onSnooze: (Long) -> Unit,
    onUnsnooze: () -> Unit,
    onAddWatchlist: (String) -> Unit,
    onSaveNotes: (String) -> Unit,
    onArchiveItem: (InboxItem) -> Unit,
    onRequestSnooze: (InboxItem) -> Unit,
    onConfirmPendingSnooze: (Long) -> Unit,
    onCancelPendingSnooze: () -> Unit,
    onUndoArchive: () -> Unit,
    onUndoWatchlist: () -> Unit,
    onCreateWatchlist: (String) -> Unit,
    onCreateCategory: (String) -> Unit,
    onRenameCategory: (String, String) -> Unit,
    onDeleteCategory: (String) -> Unit,
    onSyncSubscriptions: () -> Unit,
    onCatchUp: () -> Unit,
    onOpenEditChannel: (ChannelRecord) -> Unit,
    onCloseEditChannel: () -> Unit,
    onSaveChannelEdit: (Boolean, Int, List<String>) -> Unit,
    onClearMessage: () -> Unit,
) {
    var navOpen by remember { mutableStateOf(false) }
    val browsingChannel = state.channels.firstOrNull { it.channelId == state.browsingChannelId }

    BackHandler(enabled = state.selected != null) { onClose() }
    BackHandler(enabled = browsingChannel != null && state.selected == null) { onCloseStream() }
    BackHandler(enabled = navOpen && state.selected == null && browsingChannel == null) { navOpen = false }
    BackHandler(enabled = state.pendingSnoozeItem != null) { onCancelPendingSnooze() }
    BackHandler(enabled = state.editingChannel != null) { onCloseEditChannel() }

    val selected = state.selected
    if (selected != null) {
        DetailScreen(
            item = selected,
            watchlists = state.watchlists,
            view = state.view,
            onBack = onClose,
            onDelete = onDelete,
            onRestore = onRestore,
            onSnooze = onSnooze,
            onUnsnooze = onUnsnooze,
            onAddWatchlist = onAddWatchlist,
            onSaveNotes = onSaveNotes,
        )
        MessageDialogs(state, onClearMessage, onUndoArchive, onUndoWatchlist)
        return
    }

    if (navOpen) {
        FullScreenNav(
            current = state.view,
            displayName = state.user?.displayName.orEmpty(),
            onClose = { navOpen = false },
            onSelect = { view ->
                navOpen = false
                onSelectView(view)
            },
        )
        return
    }

    if (state.view == FeedView.Streams && browsingChannel != null) {
        StreamDetailScreen(
            channel = browsingChannel,
            categories = state.categories,
            items = state.items,
            loading = state.loading,
            syncing = state.syncing,
            status = state.status,
            onBack = onCloseStream,
            onCatchUp = onCatchUp,
            onEdit = { onOpenEditChannel(browsingChannel) },
            onOpen = onOpen,
            onArchiveItem = onArchiveItem,
            onRequestSnooze = onRequestSnooze,
        )
        EditChannelDialog(state, onCloseEditChannel, onSaveChannelEdit)
        PendingSnoozeDialog(state, onConfirmPendingSnooze, onCancelPendingSnooze)
        MessageDialogs(state, onClearMessage, onUndoArchive, onUndoWatchlist)
        return
    }

    var overflowOpen by remember { mutableStateOf(false) }
    var watchlistMenuOpen by remember { mutableStateOf(false) }
    var categoryMenuOpen by remember { mutableStateOf(false) }
    var createWatchlistOpen by remember { mutableStateOf(false) }
    var createCategoryOpen by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("StreamFeeder")
                        Text(
                            state.user?.displayName ?: "",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = { navOpen = true }) {
                        Icon(Icons.Default.Menu, contentDescription = "Open menu")
                    }
                },
                actions = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(onClick = { overflowOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "More")
                    }
                    DropdownMenu(expanded = overflowOpen, onDismissRequest = { overflowOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("Sign out") },
                            onClick = {
                                overflowOpen = false
                                onSignOut()
                            },
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    state.view.label,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (state.view == FeedView.Watchlist) {
                    IconButton(onClick = { createWatchlistOpen = true }) {
                        Icon(Icons.Default.Add, contentDescription = "Create watchlist")
                    }
                }
                if (state.view == FeedView.Categories) {
                    IconButton(onClick = { createCategoryOpen = true }) {
                        Icon(Icons.Default.Add, contentDescription = "Create category")
                    }
                }
            }

            when (state.view) {
                FeedView.Watchlist -> {
                    val selectedWatchlistName = state.watchlists
                        .firstOrNull { it.id == state.watchlistId }
                        ?.let { "${it.name} (${it.videoCount})" }
                        ?: "Select watchlist"
                    FilterDropdown(
                        expanded = watchlistMenuOpen,
                        onExpandedChange = { watchlistMenuOpen = it },
                        label = "Watchlist",
                        value = selectedWatchlistName,
                    ) {
                        state.watchlists.forEach { list ->
                            DropdownMenuItem(
                                text = { Text("${list.name} (${list.videoCount})") },
                                onClick = {
                                    watchlistMenuOpen = false
                                    onSelectWatchlist(list.id)
                                },
                            )
                        }
                    }
                    VideoList(state, onOpen, onArchiveItem, onRequestSnooze, swipe = true)
                }
                FeedView.Categories -> {
                    CategoriesPanel(
                        categories = state.categories,
                        onRename = onRenameCategory,
                        onDelete = onDeleteCategory,
                    )
                }
                FeedView.Streams -> {
                    StreamsListPanel(
                        channels = state.channels,
                        categories = state.categories,
                        syncing = state.syncing,
                        status = state.status,
                        onSync = onSyncSubscriptions,
                        onOpen = onOpenStream,
                    )
                }
                else -> {
                    if (state.view == FeedView.Inbox) {
                        val selectedCategoryName = state.categories
                            .firstOrNull { it.id == state.categoryId }
                            ?.name
                            ?: "All categories"
                        FilterDropdown(
                            expanded = categoryMenuOpen,
                            onExpandedChange = { categoryMenuOpen = it },
                            label = "Category",
                            value = selectedCategoryName,
                        ) {
                            DropdownMenuItem(
                                text = { Text("All categories") },
                                onClick = {
                                    categoryMenuOpen = false
                                    onSelectCategory(null)
                                },
                            )
                            state.categories.forEach { cat ->
                                DropdownMenuItem(
                                    text = { Text(cat.name) },
                                    onClick = {
                                        categoryMenuOpen = false
                                        onSelectCategory(cat.id)
                                    },
                                )
                            }
                        }
                    }
                    VideoList(state, onOpen, onArchiveItem, onRequestSnooze, swipe = state.view == FeedView.Inbox)
                }
            }
        }
    }

    if (createWatchlistOpen) {
        NamePromptDialog(
            title = "New watchlist",
            confirmLabel = "Create",
            onDismiss = { createWatchlistOpen = false },
            onConfirm = {
                createWatchlistOpen = false
                onCreateWatchlist(it)
            },
        )
    }
    if (createCategoryOpen) {
        NamePromptDialog(
            title = "New category",
            confirmLabel = "Add",
            onDismiss = { createCategoryOpen = false },
            onConfirm = {
                createCategoryOpen = false
                onCreateCategory(it)
            },
        )
    }

    EditChannelDialog(state, onCloseEditChannel, onSaveChannelEdit)
    PendingSnoozeDialog(state, onConfirmPendingSnooze, onCancelPendingSnooze)
    MessageDialogs(state, onClearMessage, onUndoArchive, onUndoWatchlist)
}

@Composable
private fun VideoList(
    state: FeedUiState,
    onOpen: (InboxItem) -> Unit,
    onArchiveItem: (InboxItem) -> Unit,
    onRequestSnooze: (InboxItem) -> Unit,
    swipe: Boolean,
) {
    when {
        state.loading && state.items.isEmpty() -> {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }
        state.items.isEmpty() -> {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No videos in this view.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        else -> {
            LazyColumn(
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                items(state.items, key = { it.videoId }) { item ->
                    if (swipe) {
                        SwipeFeedRow(
                            item = item,
                            onOpen = { onOpen(item) },
                            onArchive = { onArchiveItem(item) },
                            onSnooze = { onRequestSnooze(item) },
                        )
                    } else {
                        FeedRow(item = item, onClick = { onOpen(item) })
                    }
                }
            }
        }
    }
}

@Composable
private fun CategoriesPanel(
    categories: List<CategoryRecord>,
    onRename: (String, String) -> Unit,
    onDelete: (String) -> Unit,
) {
    var editing by remember { mutableStateOf<CategoryRecord?>(null) }
    var deleting by remember { mutableStateOf<CategoryRecord?>(null) }

    if (categories.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Add a category, then tag streams under Edit.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items(categories, key = { it.id }) { cat ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp, horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(cat.name, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                IconButton(onClick = { editing = cat }) {
                    Icon(Icons.Default.Edit, contentDescription = "Edit category")
                }
            }
        }
    }

    editing?.let { cat ->
        NamePromptDialog(
            title = "Edit category",
            confirmLabel = "Save",
            initialValue = cat.name,
            showDelete = true,
            onDismiss = { editing = null },
            onConfirm = { name ->
                editing = null
                onRename(cat.id, name)
            },
            onDelete = {
                editing = null
                deleting = cat
            },
        )
    }
    deleting?.let { cat ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete category") },
            text = {
                Text("Are you sure you would like to delete this category, this action cannot be undone")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        deleting = null
                        onDelete(cat.id)
                    },
                ) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { deleting = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun StreamsListPanel(
    channels: List<ChannelRecord>,
    categories: List<CategoryRecord>,
    syncing: Boolean,
    status: String?,
    onSync: () -> Unit,
    onOpen: (String) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Button(
            onClick = onSync,
            enabled = !syncing,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(if (syncing) "Syncing…" else "Sync Subscriptions")
        }
        if (!status.isNullOrBlank()) {
            Text(
                status,
                modifier = Modifier.padding(horizontal = 16.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (channels.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No streams yet. Sync subscriptions.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(channels, key = { it.channelId }) { ch ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable { onOpen(ch.channelId) }
                            .padding(8.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AsyncImage(
                            model = ch.thumbnailUrl,
                            contentDescription = null,
                            modifier = Modifier
                                .size(48.dp)
                                .clip(RoundedCornerShape(24.dp)),
                            contentScale = ContentScale.Crop,
                        )
                        Column(modifier = Modifier.weight(1f)) {
                            Text(ch.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                "${if (ch.followInInbox) "Following" else "Not following"} · pull ${ch.maxVideosToPull}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            val names = categories.filter { it.id in ch.categoryIds }.joinToString(", ") { it.name }
                            if (names.isNotBlank()) {
                                Text(names, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StreamDetailScreen(
    channel: ChannelRecord,
    categories: List<CategoryRecord>,
    items: List<InboxItem>,
    loading: Boolean,
    syncing: Boolean,
    status: String?,
    onBack: () -> Unit,
    onCatchUp: () -> Unit,
    onEdit: () -> Unit,
    onOpen: (InboxItem) -> Unit,
    onArchiveItem: (InboxItem) -> Unit,
    onRequestSnooze: (InboxItem) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(channel.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AsyncImage(
                    model = channel.thumbnailUrl,
                    contentDescription = null,
                    modifier = Modifier
                        .size(64.dp)
                        .clip(RoundedCornerShape(32.dp)),
                    contentScale = ContentScale.Crop,
                )
                Text(channel.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            }
            Row(
                modifier = Modifier.padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(onClick = onCatchUp, enabled = !syncing) {
                    Text(if (syncing) "Working…" else "Catch up")
                }
                Button(onClick = onEdit) { Text("Edit") }
            }
            val names = categories.filter { it.id in channel.categoryIds }.joinToString(", ") { it.name }
            Text(
                if (names.isBlank()) "No categories" else names,
                modifier = Modifier.padding(16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!status.isNullOrBlank()) {
                Text(
                    status,
                    modifier = Modifier.padding(horizontal = 16.dp),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            when {
                loading && items.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                items.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("No videos for this stream.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                else -> {
                    LazyColumn(
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        items(items, key = { it.videoId }) { item ->
                            SwipeFeedRow(
                                item = item,
                                onOpen = { onOpen(item) },
                                onArchive = { onArchiveItem(item) },
                                onSnooze = { onRequestSnooze(item) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EditChannelDialog(
    state: FeedUiState,
    onClose: () -> Unit,
    onSave: (Boolean, Int, List<String>) -> Unit,
) {
    val channel = state.editingChannel ?: return
    var follow by remember(channel.channelId) { mutableStateOf(channel.followInInbox) }
    var maxPull by remember(channel.channelId) { mutableStateOf(channel.maxVideosToPull.toString()) }
    var selectedCats by remember(channel.channelId) { mutableStateOf(channel.categoryIds.toSet()) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Edit ${channel.title}") },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = follow, onCheckedChange = { follow = it })
                    Text("Follow in inbox (always pull new videos)")
                }
                OutlinedTextField(
                    value = maxPull,
                    onValueChange = { maxPull = it.filter { ch -> ch.isDigit() }.take(3) },
                    label = { Text("Max existing videos to pull") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("Categories", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp))
                if (state.categories.isEmpty()) {
                    Text("Add a category in Categories first.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                state.categories.forEach { cat ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = cat.id in selectedCats,
                            onCheckedChange = { checked ->
                                selectedCats = if (checked) selectedCats + cat.id else selectedCats - cat.id
                            },
                        )
                        Text(cat.name)
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSave(follow, maxPull.toIntOrNull() ?: 0, selectedCats.toList())
            }) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onClose) { Text("Cancel") }
        },
    )
}

@Composable
private fun PendingSnoozeDialog(
    state: FeedUiState,
    onConfirm: (Long) -> Unit,
    onCancel: () -> Unit,
) {
    if (state.pendingSnoozeItem == null) return
    SnoozeDurationDialog(onPick = onConfirm, onDismiss = onCancel)
}

@Composable
private fun MessageDialogs(
    state: FeedUiState,
    onClearMessage: () -> Unit,
    onUndoArchive: () -> Unit,
    onUndoWatchlist: () -> Unit,
) {
    if (!state.message.isNullOrBlank()) {
        val canUndoArchive = state.message == "Archived" && !state.undoArchiveVideoId.isNullOrBlank()
        val canUndoWatchlist = !state.undoWatchlistVideoId.isNullOrBlank() && state.message.startsWith("Added to ")
        AlertDialog(
            onDismissRequest = onClearMessage,
            confirmButton = { TextButton(onClick = onClearMessage) { Text("OK") } },
            dismissButton = when {
                canUndoArchive -> ({ TextButton(onClick = onUndoArchive) { Text("Undo") } })
                canUndoWatchlist -> ({ TextButton(onClick = onUndoWatchlist) { Text("Undo") } })
                else -> null
            },
            text = { Text(state.message) },
        )
    }
    if (!state.error.isNullOrBlank()) {
        AlertDialog(
            onDismissRequest = onClearMessage,
            confirmButton = { TextButton(onClick = onClearMessage) { Text("OK") } },
            title = { Text("Something went wrong") },
            text = { Text(state.error) },
        )
    }
}

@Composable
private fun NamePromptDialog(
    title: String,
    confirmLabel: String,
    initialValue: String = "",
    showDelete: Boolean = false,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
    onDelete: (() -> Unit)? = null,
) {
    var value by remember(initialValue) { mutableStateOf(initialValue) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (showDelete && onDelete != null) {
                    TextButton(onClick = onDelete) {
                        Text("Delete", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = value.isNotBlank(),
                onClick = { onConfirm(value.trim()) },
            ) { Text(confirmLabel) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

@Composable
private fun SnoozeDurationDialog(onPick: (Long) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Snooze") },
        text = {
            Column {
                TextButton(onClick = { onPick(1) }) { Text("1 hour") }
                TextButton(onClick = { onPick(24) }) { Text("Tomorrow") }
                TextButton(onClick = { onPick(168) }) { Text("1 week") }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilterDropdown(
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    label: String,
    value: String,
    content: @Composable () -> Unit,
) {
    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = onExpandedChange,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = {},
            readOnly = true,
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(),
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { onExpandedChange(false) }) {
            content()
        }
    }
}

@Composable
private fun FullScreenNav(
    current: FeedView,
    displayName: String,
    onClose: () -> Unit,
    onSelect: (FeedView) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 20.dp, vertical = 16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text("StreamFeeder", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(displayName, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = onClose) {
                Icon(Icons.Default.Menu, contentDescription = "Close menu")
            }
        }
        Spacer(Modifier.height(28.dp))
        FeedView.entries.forEach { view ->
            val selected = view == current
            Text(
                text = view.label,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(
                        if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f) else Color.Transparent,
                    )
                    .clickable { onSelect(view) }
                    .padding(horizontal = 16.dp, vertical = 18.dp),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeFeedRow(
    item: InboxItem,
    onOpen: () -> Unit,
    onArchive: () -> Unit,
    onSnooze: () -> Unit,
) {
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            when (value) {
                SwipeToDismissBoxValue.StartToEnd -> {
                    onArchive()
                    true
                }
                SwipeToDismissBoxValue.EndToStart -> {
                    onSnooze()
                    false
                }
                else -> false
            }
        },
    )
    SwipeToDismissBox(
        state = dismissState,
        backgroundContent = {
            val direction = dismissState.dismissDirection
            val color = when (direction) {
                SwipeToDismissBoxValue.StartToEnd -> Color(0xFF2E7D32)
                SwipeToDismissBoxValue.EndToStart -> Color(0xFFF9A825)
                else -> Color.Transparent
            }
            val label = when (direction) {
                SwipeToDismissBoxValue.StartToEnd -> "Archive"
                SwipeToDismissBoxValue.EndToStart -> "Snooze"
                else -> ""
            }
            val alignment = when (direction) {
                SwipeToDismissBoxValue.StartToEnd -> Alignment.CenterStart
                SwipeToDismissBoxValue.EndToStart -> Alignment.CenterEnd
                else -> Alignment.Center
            }
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(color, RoundedCornerShape(8.dp))
                    .padding(horizontal = 16.dp),
                contentAlignment = alignment,
            ) {
                Text(label, color = Color.White, fontWeight = FontWeight.SemiBold)
            }
        },
    ) {
        FeedRow(item = item, onClick = onOpen)
    }
}

@Composable
private fun FeedRow(item: InboxItem, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp, horizontal = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        AsyncImage(
            model = item.thumbnailUrl,
            contentDescription = null,
            modifier = Modifier
                .width(88.dp)
                .height(50.dp)
                .clip(RoundedCornerShape(6.dp)),
            contentScale = ContentScale.Crop,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                item.title,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                fontWeight = if (item.unread) FontWeight.SemiBold else FontWeight.Normal,
                style = MaterialTheme.typography.bodyMedium.copy(lineHeight = 16.sp),
            )
            val date = item.publishedAt?.take(10).orEmpty()
            val meta = listOf(item.channelTitle, date).filter { it.isNotBlank() }.joinToString(" · ")
            Text(
                meta,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                lineHeight = 14.sp,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DetailScreen(
    item: InboxItem,
    watchlists: List<WatchlistRecord>,
    view: FeedView,
    onBack: () -> Unit,
    onDelete: () -> Unit,
    onRestore: () -> Unit,
    onSnooze: (Long) -> Unit,
    onUnsnooze: () -> Unit,
    onAddWatchlist: (String) -> Unit,
    onSaveNotes: (String) -> Unit,
) {
    var snoozeOpen by remember { mutableStateOf(false) }
    var watchOpen by remember { mutableStateOf(false) }
    var notes by remember(item.videoId, item.notes) { mutableStateOf(item.notes) }
    val context = LocalContext.current

    DisposableEffect(item.videoId) {
        var castPlayerContext: ChromecastYouTubePlayerContext? = null
        try {
            val sessionManager = CastContext.getSharedInstance(context).sessionManager
            castPlayerContext = ChromecastYouTubePlayerContext(
                sessionManager,
                object : ChromecastConnectionListener {
                    override fun onChromecastConnecting() = Unit
                    override fun onChromecastConnected(chromecastYouTubePlayerContext: ChromecastYouTubePlayerContext) {
                        chromecastYouTubePlayerContext.initialize(object : AbstractYouTubePlayerListener() {
                            override fun onReady(youTubePlayer: YouTubePlayer) {
                                youTubePlayer.loadVideo(item.videoId, 0f)
                            }
                        })
                    }
                    override fun onChromecastDisconnected() = Unit
                },
            )
        } catch (_: Exception) {
            castPlayerContext = null
        }
        onDispose {
            castPlayerContext?.release()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            YoutubePlayer(videoId = item.videoId, embeddable = item.embeddable, thumbnailUrl = item.thumbnailUrl)
            CastRow()
            Text(item.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text(item.channelTitle, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (view == FeedView.Deleted) {
                    Button(onClick = onRestore) { Text("Restore") }
                } else {
                    IconButton(onClick = { watchOpen = true }) {
                        Icon(Icons.Default.PlaylistAdd, contentDescription = "Add to watchlist")
                    }
                    if (view == FeedView.Snoozed) {
                        Button(onClick = onUnsnooze) { Text("Unsnooze") }
                    } else {
                        IconButton(onClick = { snoozeOpen = true }) {
                            Icon(Icons.Default.Snooze, contentDescription = "Snooze")
                        }
                    }
                    IconButton(onClick = onDelete) {
                        Icon(Icons.Default.Delete, contentDescription = "Archive")
                    }
                }
            }
            if (item.descriptionExcerpt.isNotBlank()) {
                Text(item.descriptionExcerpt, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            OutlinedTextField(
                value = notes,
                onValueChange = { notes = it.take(4000) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Notes") },
                minLines = 3,
                maxLines = 8,
            )
            Button(
                onClick = { onSaveNotes(notes) },
                modifier = Modifier.fillMaxWidth(),
                enabled = notes != item.notes,
            ) {
                Text("Save notes")
            }
        }
    }

    if (snoozeOpen) {
        SnoozeDurationDialog(
            onPick = {
                snoozeOpen = false
                onSnooze(it)
            },
            onDismiss = { snoozeOpen = false },
        )
    }
    if (watchOpen) {
        AlertDialog(
            onDismissRequest = { watchOpen = false },
            title = { Text("Add to watchlist") },
            text = {
                if (watchlists.isEmpty()) {
                    Text("Create a watchlist first.")
                } else {
                    LazyColumn(modifier = Modifier.heightIn(max = 360.dp)) {
                        items(watchlists, key = { it.id }) { list ->
                            TextButton(
                                onClick = {
                                    watchOpen = false
                                    onAddWatchlist(list.id)
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(list.name, modifier = Modifier.fillMaxWidth())
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { watchOpen = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun CastRow() {
    var routeButton by remember { mutableStateOf<MediaRouteButton?>(null) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { routeButton?.performClick() }
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        AndroidView(
            factory = { ctx ->
                MediaRouteButton(ctx).also { button ->
                    CastButtonFactory.setUpMediaRouteButton(ctx.applicationContext, button)
                    routeButton = button
                }
            },
            modifier = Modifier.size(40.dp),
        )
        Text(
            "Cast to TV",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun YoutubePlayer(videoId: String, embeddable: Boolean, thumbnailUrl: String) {
    if (!embeddable) {
        AsyncImage(
            model = thumbnailUrl,
            contentDescription = null,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .clip(RoundedCornerShape(12.dp)),
            contentScale = ContentScale.Crop,
        )
        Text(
            "This video can’t be embedded.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }
    val activity = LocalContext.current as? Activity
    val html = remember(videoId) {
        """
        <!DOCTYPE html><html><head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
          <meta name="referrer" content="strict-origin-when-cross-origin"/>
          <style>html,body{margin:0;padding:0;background:#000;height:100%;}iframe{border:0;width:100%;height:100%;}</style>
        </head><body>
          <iframe src="https://www.youtube.com/embed/$videoId?playsinline=1&rel=0&modestbranding=1"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
        </body></html>
        """.trimIndent()
    }
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                webViewClient = WebViewClient()
                webChromeClient = object : WebChromeClient() {
                    private var customView: View? = null
                    private var customViewCallback: CustomViewCallback? = null
                    private var originalSystemUiVisibility = 0
                    private var fullscreenContainer: FrameLayout? = null

                    override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                        if (customView != null) {
                            onHideCustomView()
                            return
                        }
                        val act = activity ?: return
                        customView = view
                        customViewCallback = callback
                        val decor = act.window.decorView as FrameLayout
                        originalSystemUiVisibility = decor.systemUiVisibility
                        val container = FrameLayout(act).apply {
                            setBackgroundColor(android.graphics.Color.BLACK)
                            addView(
                                view,
                                FrameLayout.LayoutParams(
                                    ViewGroup.LayoutParams.MATCH_PARENT,
                                    ViewGroup.LayoutParams.MATCH_PARENT,
                                ),
                            )
                        }
                        fullscreenContainer = container
                        decor.addView(
                            container,
                            FrameLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT,
                            ),
                        )
                        act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        @Suppress("DEPRECATION")
                        decor.systemUiVisibility = (
                            View.SYSTEM_UI_FLAG_FULLSCREEN
                                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            )
                    }

                    override fun onHideCustomView() {
                        val act = activity ?: return
                        val decor = act.window.decorView as FrameLayout
                        fullscreenContainer?.let { decor.removeView(it) }
                        fullscreenContainer = null
                        customView = null
                        @Suppress("DEPRECATION")
                        decor.systemUiVisibility = originalSystemUiVisibility
                        act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        customViewCallback?.onCustomViewHidden()
                        customViewCallback = null
                    }
                }
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = true
                tag = videoId
                loadDataWithBaseURL(PlayerBaseUrl, html, "text/html", "utf-8", null)
            }
        },
        update = { webView ->
            if (webView.tag as? String != videoId) {
                webView.tag = videoId
                webView.loadDataWithBaseURL(PlayerBaseUrl, html, "text/html", "utf-8", null)
            }
        },
        onRelease = {
            it.stopLoading()
            it.destroy()
        },
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(12.dp)),
    )
}
