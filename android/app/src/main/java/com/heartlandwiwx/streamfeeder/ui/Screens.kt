package com.heartlandwiwx.streamfeeder.ui

import android.annotation.SuppressLint
import android.net.Uri
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlaylistAdd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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
import coil.compose.AsyncImage
import com.heartlandwiwx.streamfeeder.BuildConfig
import com.heartlandwiwx.streamfeeder.FeedUiState
import com.heartlandwiwx.streamfeeder.FeedView
import com.heartlandwiwx.streamfeeder.data.InboxItem
import com.heartlandwiwx.streamfeeder.data.WatchlistRecord

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
    onSnoozeItem: (InboxItem) -> Unit,
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
            onSaveNotes = onSaveNotes,
        )
        return
    }

    var navOpen by remember { mutableStateOf(false) }
    var overflowOpen by remember { mutableStateOf(false) }
    var categoryMenuOpen by remember { mutableStateOf(false) }
    var watchlistMenuOpen by remember { mutableStateOf(false) }

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
            Text(
                state.view.label,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )

            if (state.view == FeedView.Watchlist) {
                val selectedWatchlistName = state.watchlists
                    .firstOrNull { it.id == state.watchlistId }
                    ?.let { "${it.name} (${it.videoCount})" }
                    ?: "Select watchlist"
                ExposedDropdownMenuBox(
                    expanded = watchlistMenuOpen,
                    onExpandedChange = { watchlistMenuOpen = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                ) {
                    OutlinedTextField(
                        value = selectedWatchlistName,
                        onValueChange = {},
                        readOnly = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .menuAnchor(),
                        label = { Text("Watchlist") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = watchlistMenuOpen) },
                    )
                    ExposedDropdownMenu(
                        expanded = watchlistMenuOpen,
                        onDismissRequest = { watchlistMenuOpen = false },
                    ) {
                        if (state.watchlists.isEmpty()) {
                            DropdownMenuItem(
                                text = { Text("No watchlists yet") },
                                onClick = { watchlistMenuOpen = false },
                            )
                        } else {
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
                    }
                }
            } else if (state.categories.isNotEmpty()) {
                val selectedCategoryName =
                    state.categories.firstOrNull { it.id == state.categoryId }?.name ?: "All categories"
                ExposedDropdownMenuBox(
                    expanded = categoryMenuOpen,
                    onExpandedChange = { categoryMenuOpen = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                ) {
                    OutlinedTextField(
                        value = selectedCategoryName,
                        onValueChange = {},
                        readOnly = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .menuAnchor(),
                        label = { Text("Category") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = categoryMenuOpen) },
                    )
                    ExposedDropdownMenu(
                        expanded = categoryMenuOpen,
                        onDismissRequest = { categoryMenuOpen = false },
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
                    val swipeEnabled = state.view == FeedView.Inbox || state.view == FeedView.Watchlist
                    LazyColumn(
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        items(state.items, key = { it.videoId }) { item ->
                            if (swipeEnabled) {
                                SwipeFeedRow(
                                    item = item,
                                    onOpen = { onOpen(item) },
                                    onArchive = { onArchiveItem(item) },
                                    onSnooze = { onSnoozeItem(item) },
                                )
                            } else {
                                FeedRow(item = item, onClick = { onOpen(item) })
                            }
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
                Icon(Icons.Default.Close, contentDescription = "Close menu")
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
                        if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
                        else Color.Transparent,
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
                    true
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
                lineHeight = 16.sp,
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
            Text(item.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text(item.channelTitle, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (view == FeedView.Deleted) {
                    Button(onClick = onRestore) { Text("Restore") }
                } else {
                    IconButton(onClick = onDelete) {
                        Icon(Icons.Default.Delete, contentDescription = "Archive")
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
            "This video can’t be embedded. Open it on YouTube from your browser if needed.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }
    val html = remember(videoId) {
        """
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
          <meta name="referrer" content="strict-origin-when-cross-origin"/>
          <style>html,body{margin:0;padding:0;background:#000;height:100%;}iframe{border:0;width:100%;height:100%;}</style>
        </head>
        <body>
          <iframe
            src="https://www.youtube.com/embed/$videoId?playsinline=1&rel=0&modestbranding=1"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
            referrerpolicy="strict-origin-when-cross-origin"></iframe>
        </body>
        </html>
        """.trimIndent()
    }
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                webViewClient = WebViewClient()
                webChromeClient = WebChromeClient()
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = true
                settings.cacheMode = WebSettings.LOAD_DEFAULT
                loadDataWithBaseURL(PlayerBaseUrl, html, "text/html", "utf-8", null)
            }
        },
        update = { webView ->
            val tag = webView.tag as? String
            if (tag != videoId) {
                webView.tag = videoId
                webView.loadDataWithBaseURL(PlayerBaseUrl, html, "text/html", "utf-8", null)
            }
        },
        onRelease = { webView ->
            webView.stopLoading()
            webView.destroy()
        },
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(12.dp)),
    )
}
