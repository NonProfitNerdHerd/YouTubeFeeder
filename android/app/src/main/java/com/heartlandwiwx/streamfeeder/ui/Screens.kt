package com.heartlandwiwx.streamfeeder.ui

import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlaylistAdd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.heartlandwiwx.streamfeeder.BuildConfig
import com.heartlandwiwx.streamfeeder.FeedUiState
import com.heartlandwiwx.streamfeeder.FeedView
import com.heartlandwiwx.streamfeeder.data.InboxItem

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
    onOpen: (InboxItem) -> Unit,
    onClose: () -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
    onDelete: () -> Unit,
    onRestore: () -> Unit,
    onSnooze: (Long) -> Unit,
    onUnsnooze: () -> Unit,
    onAddWatchlist: (String) -> Unit,
    onClearMessage: () -> Unit,
) {
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
        )
        return
    }

    var menuOpen by remember { mutableStateOf(false) }
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
                actions = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "Menu")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("Sign out") },
                            onClick = {
                                menuOpen = false
                                onSignOut()
                            },
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
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
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FeedView.entries.forEach { view ->
                    FilterChip(
                        selected = state.view == view,
                        onClick = { onSelectView(view) },
                        label = { Text(view.label) },
                    )
                }
            }

            if (state.view == FeedView.Watchlist) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    state.watchlists.forEach { list ->
                        AssistChip(
                            onClick = { onSelectWatchlist(list.id) },
                            label = { Text("${list.name} (${list.videoCount})") },
                        )
                    }
                }
            } else if (state.categories.isNotEmpty()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(
                        selected = state.categoryId == null,
                        onClick = { onSelectCategory(null) },
                        label = { Text("All") },
                    )
                    state.categories.forEach { cat ->
                        FilterChip(
                            selected = state.categoryId == cat.id,
                            onClick = { onSelectCategory(cat.id) },
                            label = { Text(cat.name) },
                        )
                    }
                }
            }

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
                        contentPadding = PaddingValues(12.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(state.items, key = { it.videoId }) { item ->
                            FeedRow(item = item, onClick = { onOpen(item) })
                        }
                    }
                }
            }
        }
    }

    if (!state.message.isNullOrBlank()) {
        AlertDialog(
            onDismissRequest = onClearMessage,
            confirmButton = { TextButton(onClick = onClearMessage) { Text("OK") } },
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
private fun FeedRow(item: InboxItem, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AsyncImage(
            model = item.thumbnailUrl,
            contentDescription = null,
            modifier = Modifier
                .width(140.dp)
                .height(80.dp)
                .clip(RoundedCornerShape(8.dp)),
            contentScale = ContentScale.Crop,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                item.title,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                fontWeight = if (item.unread) FontWeight.SemiBold else FontWeight.Normal,
            )
            Text(
                item.channelTitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            item.publishedAt?.let {
                Text(
                    it.take(10),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DetailScreen(
    item: InboxItem,
    watchlists: List<com.heartlandwiwx.streamfeeder.data.WatchlistRecord>,
    view: FeedView,
    onBack: () -> Unit,
    onDelete: () -> Unit,
    onRestore: () -> Unit,
    onSnooze: (Long) -> Unit,
    onUnsnooze: () -> Unit,
    onAddWatchlist: (String) -> Unit,
) {
    val context = LocalContext.current
    var snoozeOpen by remember { mutableStateOf(false) }
    var watchOpen by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Video", maxLines = 1, overflow = TextOverflow.Ellipsis) },
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
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AsyncImage(
                model = item.thumbnailUrl,
                contentDescription = null,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(200.dp)
                    .clip(RoundedCornerShape(12.dp)),
                contentScale = ContentScale.Crop,
            )
            Text(item.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text(item.channelTitle, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(
                onClick = {
                    val uri = Uri.parse("https://www.youtube.com/watch?v=${item.videoId}")
                    context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Watch on YouTube")
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (view == FeedView.Deleted) {
                    Button(onClick = onRestore) { Text("Restore") }
                } else {
                    IconButton(onClick = onDelete) {
                        Icon(Icons.Default.Delete, contentDescription = "Delete")
                    }
                }
                if (view == FeedView.Snoozed) {
                    Button(onClick = onUnsnooze) { Text("Unsnooze") }
                } else if (view != FeedView.Deleted) {
                    IconButton(onClick = { snoozeOpen = true }) {
                        Icon(Icons.Default.Snooze, contentDescription = "Snooze")
                    }
                }
                if (view != FeedView.Deleted) {
                    IconButton(onClick = { watchOpen = true }) {
                        Icon(Icons.Default.PlaylistAdd, contentDescription = "Add to watchlist")
                    }
                }
            }
        }
    }

    if (snoozeOpen) {
        AlertDialog(
            onDismissRequest = { snoozeOpen = false },
            title = { Text("Snooze") },
            text = {
                Column {
                    TextButton(onClick = { snoozeOpen = false; onSnooze(1) }) { Text("1 hour") }
                    TextButton(onClick = { snoozeOpen = false; onSnooze(24) }) { Text("Tomorrow") }
                    TextButton(onClick = { snoozeOpen = false; onSnooze(168) }) { Text("1 week") }
                }
            },
            confirmButton = {
                TextButton(onClick = { snoozeOpen = false }) { Text("Cancel") }
            },
        )
    }
    if (watchOpen) {
        AlertDialog(
            onDismissRequest = { watchOpen = false },
            title = { Text("Add to watchlist") },
            text = {
                if (watchlists.isEmpty()) {
                    Text("Create a watchlist on the website first.")
                } else {
                    Column {
                        watchlists.forEach { list ->
                            TextButton(onClick = {
                                watchOpen = false
                                onAddWatchlist(list.id)
                            }) {
                                Text(list.name)
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
