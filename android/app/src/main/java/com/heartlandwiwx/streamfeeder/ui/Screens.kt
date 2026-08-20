package com.heartlandwiwx.streamfeeder.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebChromeClient.CustomViewCallback
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.PlaylistAdd
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Snooze
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
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
import com.heartlandwiwx.streamfeeder.data.LiveSourceRecord
import com.heartlandwiwx.streamfeeder.data.LiveVideoRecord
import com.heartlandwiwx.streamfeeder.data.AppTheme
import com.heartlandwiwx.streamfeeder.data.WatchedFilter
import com.heartlandwiwx.streamfeeder.data.WatchlistRecord
import com.pierfrancescosoffritti.androidyoutubeplayer.chromecast.chromecastsender.ChromecastYouTubePlayerContext
import com.pierfrancescosoffritti.androidyoutubeplayer.chromecast.chromecastsender.io.infrastructure.ChromecastConnectionListener
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.YouTubePlayer
import com.pierfrancescosoffritti.androidyoutubeplayer.core.player.listeners.AbstractYouTubePlayerListener
import org.json.JSONObject
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private val PlayerBaseUrl = "https://youtube-feeder-worker.ike-j-rebout.workers.dev/"

private val LiveGridSizes = listOf(1, 4, 6, 8, 12)

private fun liveGridColumns(size: Int): Int = when (size) {
    1 -> 1
    4 -> 2
    6 -> 3
    else -> 4
}

private fun parseLiveSlotValue(value: String?): Pair<String?, String?> {
    if (value.isNullOrBlank()) return null to null
    val sep = value.indexOf("::")
    return if (sep == -1) value to null else value.substring(0, sep) to value.substring(sep + 2)
}

private fun liveSlotAssignment(sourceId: String, videoId: String): String = "$sourceId::$videoId"

private fun FeedView.pageTitle(): String =
    if (isLiveSection) "Live · $label" else label

private fun openOnYouTube(context: android.content.Context, videoId: String) {
    val app = Intent(Intent.ACTION_VIEW, Uri.parse("vnd.youtube:$videoId"))
    val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/watch?v=$videoId"))
    try {
        context.startActivity(app)
    } catch (_: ActivityNotFoundException) {
        context.startActivity(web)
    }
}

@Composable
fun LoginScreen(loginUrl: String, error: String?, onClearError: () -> Unit) {
    val context = LocalContext.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            "VortiQuest",
            style = MaterialTheme.typography.headlineLarge,
            fontFamily = BrandFont,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onBackground,
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
    onSignOut: () -> Unit,
    onDelete: () -> Unit,
    onRestore: () -> Unit,
    onSnooze: (Long) -> Unit,
    onUnsnooze: () -> Unit,
    onAddWatchlist: (String) -> Unit,
    onSaveNotes: (String) -> Unit,
    onArchiveItem: (InboxItem) -> Unit,
    onArchiveVideos: (List<String>) -> Unit,
    onSnoozeVideos: (List<String>, Long) -> Unit,
    onMoveVideosToWatchlist: (String, List<String>) -> Unit,
    onRequestSnooze: (InboxItem) -> Unit,
    onConfirmPendingSnooze: (Long) -> Unit,
    onCancelPendingSnooze: () -> Unit,
    onCompleteSnoozeExit: () -> Unit,
    onUndoArchive: () -> Unit,
    onUndoWatchlist: () -> Unit,
    onCreateWatchlist: (String) -> Unit,
    onCreateCategory: (String) -> Unit,
    onRenameCategory: (String, String) -> Unit,
    onDeleteCategory: (String) -> Unit,
    onCatchUp: () -> Unit,
    onOpenEditChannel: (ChannelRecord) -> Unit,
    onCloseEditChannel: () -> Unit,
    onSaveChannelEdit: (Boolean, Int, List<String>) -> Unit,
    onClearMessage: () -> Unit,
    onSelectWatchedFilter: (WatchedFilter) -> Unit,
    onMarkAllWatched: () -> Unit,
    onToggleWatched: () -> Unit,
    onSelectTheme: (AppTheme) -> Unit,
    onRefreshLive: () -> Unit,
    onRefreshOneLiveSource: (String) -> Unit,
    onPlayerEvent: (videoId: String, type: String, currentTime: Double, rate: Double, duration: Double?) -> Unit,
    onFlushPlayback: () -> Unit,
    onPlaythrough: () -> Unit = {},
    onStopPlaythrough: () -> Unit = {},
    onLoadMore: () -> Unit = {},
) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val navOpen = drawerState.isOpen
    val browsingChannel = state.channels.firstOrNull { it.channelId == state.browsingChannelId }
    val configuration = LocalConfiguration.current
    val useMasterDetail = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE &&
        configuration.smallestScreenWidthDp >= 600
    val listMasterDetailViews = setOf(
        FeedView.Inbox,
        FeedView.Snoozed,
        FeedView.Deleted,
        FeedView.Watchlist,
        FeedView.Categories,
    )
    val useListMasterDetail = useMasterDetail && state.view in listMasterDetailViews
    val useStreamsMasterDetail = useMasterDetail && state.view == FeedView.Streams

    var selectedVideoIds by remember { mutableStateOf(setOf<String>()) }
    var confirmArchiveOpen by remember { mutableStateOf(false) }
    var watchlistBulkOpen by remember { mutableStateOf(false) }
    var bulkSnoozeOpen by remember { mutableStateOf(false) }
    val selectionMode = selectedVideoIds.isNotEmpty()
    var liveGridSize by remember { mutableStateOf(4) }
    var liveSlotFeeds by remember { mutableStateOf(List(12) { null as String? }) }
    var liveFullscreenSlot by remember { mutableStateOf<Int?>(null) }
    var liveActiveSlot by remember { mutableStateOf(0) }
    var liveGridImmersive by remember { mutableStateOf(false) }
    var browsingLiveSourceId by remember { mutableStateOf<String?>(null) }
    var browsingLiveCategoryId by remember { mutableStateOf<String?>(null) }

    fun playLiveVideo(sourceId: String, videoId: String) {
        browsingLiveSourceId = null
        liveGridSize = 1
        liveSlotFeeds = List(12) { null as String? }.toMutableList().also {
            it[0] = liveSlotAssignment(sourceId, videoId)
        }
        liveActiveSlot = 0
        liveFullscreenSlot = null
        liveGridImmersive = false
        onSelectView(FeedView.LiveGrid)
    }

    fun openLiveSource(source: LiveSourceRecord) {
        val playable = source.playableLive()
        when {
            playable.size == 1 -> playLiveVideo(source.id, playable.first().videoId)
            playable.size > 1 -> browsingLiveSourceId = source.id
            source.blockedLive().isNotEmpty() || source.upcoming().isNotEmpty() -> {
                browsingLiveSourceId = source.id
            }
        }
    }

    LaunchedEffect(state.view) {
        selectedVideoIds = emptySet()
        confirmArchiveOpen = false
        watchlistBulkOpen = false
        bulkSnoozeOpen = false
        if (state.view != FeedView.LiveStreams && state.view != FeedView.LiveCategories) {
            browsingLiveSourceId = null
        }
        if (state.view != FeedView.LiveCategories) {
            browsingLiveCategoryId = null
        }
        if (state.view != FeedView.LiveGrid) {
            liveFullscreenSlot = null
            liveGridImmersive = false
        }
    }

    val overlaysClear = state.pendingSnoozeItem == null && state.editingChannel == null &&
        !confirmArchiveOpen && !watchlistBulkOpen && !bulkSnoozeOpen
    val browsingCategory = state.view == FeedView.Categories && state.categoryId != null
    val browsingLiveSource =
        (state.view == FeedView.LiveStreams || state.view == FeedView.LiveCategories) &&
            browsingLiveSourceId != null
    val browsingLiveCategory =
        state.view == FeedView.LiveCategories &&
            browsingLiveCategoryId != null &&
            browsingLiveSourceId == null
    val inLiveCategoryDrilldown =
        state.view == FeedView.LiveCategories && browsingLiveCategoryId != null
    val atRootInbox = state.view == FeedView.Inbox &&
        !navOpen &&
        state.selected == null &&
        browsingChannel == null &&
        !selectionMode &&
        overlaysClear &&
        liveFullscreenSlot == null &&
        !liveGridImmersive
    val canReturnToInbox = state.view != FeedView.Inbox &&
        !navOpen &&
        state.selected == null &&
        browsingChannel == null &&
        !browsingCategory &&
        !browsingLiveSource &&
        !inLiveCategoryDrilldown &&
        !selectionMode &&
        overlaysClear &&
        liveFullscreenSlot == null &&
        !liveGridImmersive

    BackHandler(enabled = state.selected != null) { onClose() }
    BackHandler(enabled = browsingChannel != null && state.selected == null) { onCloseStream() }
    BackHandler(enabled = browsingCategory && state.selected == null && !navOpen && overlaysClear && !selectionMode) {
        onSelectCategory(null)
    }
    BackHandler(enabled = browsingLiveSource && !navOpen && overlaysClear) {
        browsingLiveSourceId = null
    }
    BackHandler(enabled = browsingLiveCategory && !navOpen && overlaysClear) {
        browsingLiveCategoryId = null
    }
    BackHandler(enabled = navOpen && state.selected == null && browsingChannel == null) {
        scope.launch { drawerState.close() }
    }
    BackHandler(enabled = state.pendingSnoozeItem != null) { onCancelPendingSnooze() }
    BackHandler(enabled = state.editingChannel != null) { onCloseEditChannel() }
    BackHandler(enabled = bulkSnoozeOpen) { bulkSnoozeOpen = false }
    BackHandler(enabled = selectionMode && state.selected == null && !navOpen && !bulkSnoozeOpen) {
        selectedVideoIds = emptySet()
    }
    BackHandler(enabled = canReturnToInbox) { onSelectView(FeedView.Inbox) }
    BackHandler(enabled = atRootInbox) { /* stay in app on Inbox */ }
    BackHandler(enabled = liveFullscreenSlot != null) { liveFullscreenSlot = null }
    BackHandler(enabled = liveGridImmersive && liveFullscreenSlot == null) { liveGridImmersive = false }

    val selected = state.selected
    if (state.playthroughActive && selected != null) {
        BackHandler(enabled = true) { onClose() }
        PlaythroughOverlay(
            item = selected,
            onExit = onClose,
            onPlayerEvent = onPlayerEvent,
            onFlushPlayback = onFlushPlayback,
        )
        MessageDialogs(state, onClearMessage, onUndoArchive, onUndoWatchlist)
        return
    }

    if (selected != null && !useListMasterDetail && !useStreamsMasterDetail) {
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
            onToggleWatched = onToggleWatched,
            onPlayerEvent = onPlayerEvent,
            onFlushPlayback = onFlushPlayback,
        )
        MessageDialogs(state, onClearMessage, onUndoArchive, onUndoWatchlist)
        return
    }

    if (state.view == FeedView.Streams && browsingChannel != null && !useStreamsMasterDetail) {
        StreamDetailScreen(
            channel = browsingChannel,
            categories = state.categories,
            items = state.items,
            loading = state.loading,
            syncing = state.syncing,
            status = state.status,
            snoozeExitVideoId = state.snoozeExitVideoId,
            playthroughActive = state.playthroughActive,
            onBack = onCloseStream,
            onCatchUp = onCatchUp,
            onEdit = { onOpenEditChannel(browsingChannel) },
            onOpen = onOpen,
            onArchiveItem = onArchiveItem,
            onRequestSnooze = onRequestSnooze,
            onCompleteSnoozeExit = onCompleteSnoozeExit,
            onPlaythrough = onPlaythrough,
            onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
            hasMore = state.feedHasMore,
            loadingMore = state.feedLoadingMore,
        )
        EditChannelDialog(state, onCloseEditChannel, onSaveChannelEdit)
        PendingSnoozeDialog(state, onConfirmPendingSnooze, onCancelPendingSnooze)
        MessageDialogs(state, onClearMessage, onUndoArchive, onUndoWatchlist)
        return
    }

    val fullscreenSlot = liveFullscreenSlot
    if (fullscreenSlot != null) {
        LiveSlotCard(
            number = fullscreenSlot + 1,
            selected = liveSlotFeeds[fullscreenSlot],
            sources = state.liveSources,
            onSelect = { name ->
                liveSlotFeeds = liveSlotFeeds.toMutableList().also { it[fullscreenSlot] = name }
            },
            focused = true,
            onFocus = { liveActiveSlot = fullscreenSlot },
            onExitFullscreen = { liveFullscreenSlot = null },
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black)
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(8.dp),
        )
        return
    }

    if (liveGridImmersive) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
        ) {
            LiveGridPane(
                modifier = Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .navigationBarsPadding(),
                gridSize = liveGridSize,
                slotFeeds = liveSlotFeeds,
                onSlotFeedChange = { index, name ->
                    liveSlotFeeds = liveSlotFeeds.toMutableList().also { it[index] = name }
                    liveActiveSlot = index
                },
                activeSlot = liveActiveSlot,
                onActivate = { liveActiveSlot = it },
                onFullscreen = null,
                sources = state.liveSources,
                compact = true,
            )
            IconButton(
                onClick = { liveGridImmersive = false },
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .statusBarsPadding()
                    .padding(4.dp),
            ) {
                Icon(
                    Icons.Default.FullscreenExit,
                    contentDescription = "Exit full screen grid",
                    tint = Color.White,
                )
            }
        }
        return
    }

    var watchlistMenuOpen by remember { mutableStateOf(false) }
    var categoryMenuOpen by remember { mutableStateOf(false) }
    var createWatchlistOpen by remember { mutableStateOf(false) }
    var createCategoryOpen by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (selectionMode && state.view == FeedView.Inbox) {
                        Text("${selectedVideoIds.size} selected")
                    } else {
                        Column {
                            Text(
                                "VortiQuest",
                                fontFamily = BrandFont,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                state.user?.displayName ?: "",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                navigationIcon = {
                    if (selectionMode && state.view == FeedView.Inbox) {
                        IconButton(onClick = { selectedVideoIds = emptySet() }) {
                            Icon(Icons.Default.Close, contentDescription = "Cancel selection")
                        }
                    } else {
                        IconButton(onClick = {
                            scope.launch {
                                if (drawerState.isClosed) drawerState.open() else drawerState.close()
                            }
                        }) {
                            Icon(Icons.Default.Menu, contentDescription = "Open menu")
                        }
                    }
                },
                actions = {
                    if (selectionMode && state.view == FeedView.Inbox) {
                        IconButton(onClick = { confirmArchiveOpen = true }) {
                            Icon(Icons.Default.Delete, contentDescription = "Archive selected")
                        }
                        IconButton(onClick = { bulkSnoozeOpen = true }) {
                            Icon(Icons.Default.AccessTime, contentDescription = "Snooze selected")
                        }
                        IconButton(onClick = { watchlistBulkOpen = true }) {
                            Icon(Icons.Default.PlaylistAdd, contentDescription = "Add to watchlist")
                        }
                    } else if (state.view.isLiveSection) {
                        if (state.view == FeedView.LiveGrid) {
                            IconButton(onClick = { liveGridImmersive = true }) {
                                Icon(Icons.Default.GridView, contentDescription = "Full screen grid")
                            }
                        }
                        if (state.liveRefreshing || state.liveRefreshingSourceId != null) {
                            Box(
                                modifier = Modifier.size(48.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(22.dp),
                                    strokeWidth = 2.dp,
                                )
                            }
                        } else {
                            IconButton(
                                onClick = onRefreshLive,
                                enabled = !state.loading,
                            ) {
                                Icon(Icons.Default.Refresh, contentDescription = "Refresh live statuses")
                            }
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    titleContentColor = MaterialTheme.colorScheme.onSurface,
                ),
            )
        },
    ) { padding ->
        ModalNavigationDrawer(
            drawerState = drawerState,
            modifier = Modifier.padding(padding),
            drawerContent = {
                ModalDrawerSheet(
                    windowInsets = WindowInsets(0.dp),
                    drawerContainerColor = MaterialTheme.colorScheme.surface,
                ) {
                    AppDrawer(
                        current = state.view,
                        currentWatchlistId = state.watchlistId,
                        watchlists = state.watchlists,
                        onSelect = { view ->
                            scope.launch { drawerState.close() }
                            onSelectView(view)
                        },
                        onSelectWatchlist = { id ->
                            scope.launch { drawerState.close() }
                            onSelectView(FeedView.Watchlist)
                            onSelectWatchlist(id)
                        },
                        onSignOut = {
                            scope.launch { drawerState.close() }
                            onSignOut()
                        },
                    )
                }
            },
        ) {
        when {
            useListMasterDetail -> {
                Row(
                    modifier = Modifier.fillMaxSize(),
                ) {
                    Column(
                        modifier = Modifier
                            .weight(0.3f)
                            .fillMaxHeight(),
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (state.view == FeedView.Categories && state.categoryId != null) {
                                IconButton(onClick = { onSelectCategory(null) }) {
                                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to categories")
                                }
                                Text(
                                    state.categories.firstOrNull { it.id == state.categoryId }?.name
                                        ?: FeedView.Categories.label,
                                    modifier = Modifier.weight(1f),
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            } else {
                                Text(
                                    state.view.pageTitle(),
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
                        }
                        when (state.view) {
                            FeedView.Inbox -> {
                                InboxListPane(
                                    state = state,
                                    categoryMenuOpen = categoryMenuOpen,
                                    onCategoryMenuOpenChange = { categoryMenuOpen = it },
                                    onSelectCategory = onSelectCategory,
                                    onOpen = onOpen,
                                    onArchiveItem = onArchiveItem,
                                    onRequestSnooze = onRequestSnooze,
                                    selectionMode = selectionMode,
                                    selectedVideoIds = selectedVideoIds,
                                    detailVideoId = selected?.videoId,
                                    onToggleSelect = { id ->
                                        selectedVideoIds =
                                            if (id in selectedVideoIds) selectedVideoIds - id else selectedVideoIds + id
                                    },
                                    onEnterSelection = { id -> selectedVideoIds = selectedVideoIds + id },
                                    onPlaythrough = onPlaythrough,
                                    onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
                                )
                            }
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
                                VideoList(
                                    state = state,
                                    onOpen = onOpen,
                                    onArchiveItem = onArchiveItem,
                                    onRequestSnooze = onRequestSnooze,
                                    onCompleteSnoozeExit = onCompleteSnoozeExit,
                                    swipe = true,
                                    detailVideoId = selected?.videoId,
                                    onPlaythrough = onPlaythrough,
                                    onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
                                )
                            }
                            FeedView.Categories -> {
                                if (state.categoryId == null) {
                                    CategoriesPanel(
                                        categories = state.categories,
                                        channels = state.channels,
                                        onSelect = onSelectCategory,
                                        onRename = onRenameCategory,
                                        onDelete = onDeleteCategory,
                                    )
                                } else {
                                    VideoList(
                                        state = state,
                                        onOpen = onOpen,
                                        onArchiveItem = onArchiveItem,
                                        onRequestSnooze = onRequestSnooze,
                                        onCompleteSnoozeExit = onCompleteSnoozeExit,
                                        swipe = true,
                                        detailVideoId = selected?.videoId,
                                        onPlaythrough = onPlaythrough,
                                        onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
                                    )
                                }
                            }
                            else -> {
                                VideoList(
                                    state = state,
                                    onOpen = onOpen,
                                    onArchiveItem = onArchiveItem,
                                    onRequestSnooze = onRequestSnooze,
                                    onCompleteSnoozeExit = onCompleteSnoozeExit,
                                    swipe = false,
                                    detailVideoId = selected?.videoId,
                                    onPlaythrough = onPlaythrough,
                                    onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
                                )
                            }
                        }
                    }
                    VerticalDivider()
                    Box(
                        modifier = Modifier
                            .weight(0.7f)
                            .fillMaxHeight(),
                    ) {
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
                                onToggleWatched = onToggleWatched,
                                onPlayerEvent = onPlayerEvent,
                                onFlushPlayback = onFlushPlayback,
                                embedded = true,
                            )
                        } else {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text(
                                    if (state.view == FeedView.Categories && state.categoryId == null) {
                                        "Select a category"
                                    } else {
                                        "Select a video"
                                    },
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
            useStreamsMasterDetail -> {
                Row(
                    modifier = Modifier.fillMaxSize(),
                ) {
                    Column(
                        modifier = Modifier
                            .weight(0.2f)
                            .fillMaxHeight(),
                    ) {
                        Text(
                            FeedView.Streams.label,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        StreamsListPanel(
                            channels = state.channels,
                            categories = state.categories,
                            status = state.status,
                            selectedChannelId = browsingChannel?.channelId,
                            onOpen = onOpenStream,
                        )
                    }
                    VerticalDivider()
                    Box(
                        modifier = Modifier
                            .weight(0.3f)
                            .fillMaxHeight(),
                    ) {
                        if (browsingChannel != null) {
                            StreamVideosPane(
                                channel = browsingChannel,
                                categories = state.categories,
                                items = state.items,
                                loading = state.loading,
                                syncing = state.syncing,
                                status = state.status,
                                detailVideoId = selected?.videoId,
                                snoozeExitVideoId = state.snoozeExitVideoId,
                                onCatchUp = onCatchUp,
                                onEdit = { onOpenEditChannel(browsingChannel) },
                                onOpen = onOpen,
                                onArchiveItem = onArchiveItem,
                                onRequestSnooze = onRequestSnooze,
                                onCompleteSnoozeExit = onCompleteSnoozeExit,
                                playthroughActive = state.playthroughActive,
                                onPlaythrough = onPlaythrough,
                                onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
                                hasMore = state.feedHasMore,
                                loadingMore = state.feedLoadingMore,
                            )
                        } else {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text("Select a stream", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                    VerticalDivider()
                    Box(
                        modifier = Modifier
                            .weight(0.5f)
                            .fillMaxHeight(),
                    ) {
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
                                onToggleWatched = onToggleWatched,
                                onPlayerEvent = onPlayerEvent,
                                onFlushPlayback = onFlushPlayback,
                                embedded = true,
                            )
                        } else {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text("Select a video", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            else -> {
                Column(
                    modifier = Modifier.fillMaxSize(),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (state.view == FeedView.Categories && state.categoryId != null) {
                            IconButton(onClick = { onSelectCategory(null) }) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to categories")
                            }
                            Text(
                                state.categories.firstOrNull { it.id == state.categoryId }?.name
                                    ?: FeedView.Categories.label,
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        } else if (browsingLiveSource) {
                            IconButton(onClick = { browsingLiveSourceId = null }) {
                                Icon(
                                    Icons.AutoMirrored.Filled.ArrowBack,
                                    contentDescription = if (inLiveCategoryDrilldown) {
                                        "Back to category"
                                    } else {
                                        "Back to streams"
                                    },
                                )
                            }
                            Text(
                                state.liveSources.firstOrNull { it.id == browsingLiveSourceId }?.displayName
                                    ?: "Live videos",
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            val browseId = browsingLiveSourceId
                            if (browseId != null) {
                                if (state.liveRefreshingSourceId == browseId) {
                                    Box(
                                        modifier = Modifier.size(48.dp),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        CircularProgressIndicator(
                                            modifier = Modifier.size(22.dp),
                                            strokeWidth = 2.dp,
                                        )
                                    }
                                } else {
                                    IconButton(
                                        onClick = { onRefreshOneLiveSource(browseId) },
                                        enabled = !state.liveRefreshing && !state.loading,
                                    ) {
                                        Icon(Icons.Default.Refresh, contentDescription = "Refresh this source")
                                    }
                                }
                            }
                        } else if (browsingLiveCategory) {
                            IconButton(onClick = { browsingLiveCategoryId = null }) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to live categories")
                            }
                            Text(
                                state.liveCategories.firstOrNull { it.id == browsingLiveCategoryId }?.name
                                    ?: "Category",
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        } else {
                            Text(
                                state.view.pageTitle(),
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                            )
                            if (state.view == FeedView.LiveGrid) {
                                LiveGridSizeButtons(
                                    gridSize = liveGridSize,
                                    onGridSizeChange = { liveGridSize = it },
                                )
                            }
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
                            VideoList(
                                state,
                                onOpen,
                                onArchiveItem,
                                onRequestSnooze,
                                onCompleteSnoozeExit,
                                swipe = true,
                                onPlaythrough = onPlaythrough,
                                onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
                            )
                        }
                        FeedView.Categories -> {
                            if (state.categoryId == null) {
                                CategoriesPanel(
                                    categories = state.categories,
                                    channels = state.channels,
                                    onSelect = onSelectCategory,
                                    onRename = onRenameCategory,
                                    onDelete = onDeleteCategory,
                                )
                            } else {
                                VideoList(
                                state,
                                onOpen,
                                onArchiveItem,
                                onRequestSnooze,
                                onCompleteSnoozeExit,
                                swipe = true,
                                onPlaythrough = onPlaythrough,
                                onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
                            )
                            }
                        }
                        FeedView.Streams -> {
                            StreamsListPanel(
                                channels = state.channels,
                                categories = state.categories,
                                status = state.status,
                                onOpen = onOpenStream,
                            )
                        }
                        FeedView.Settings -> {
                            SettingsPane(
                                theme = state.theme,
                                displayName = state.user?.displayName,
                                onSelectTheme = onSelectTheme,
                            )
                        }
                        FeedView.LiveGrid -> LiveGridPane(
                            modifier = Modifier.weight(1f),
                            gridSize = liveGridSize,
                            slotFeeds = liveSlotFeeds,
                            onSlotFeedChange = { index, name ->
                                liveSlotFeeds = liveSlotFeeds.toMutableList().also { it[index] = name }
                                liveActiveSlot = index
                            },
                            activeSlot = liveActiveSlot,
                            onActivate = { liveActiveSlot = it },
                            onFullscreen = {
                                liveActiveSlot = it
                                liveFullscreenSlot = it
                            },
                            sources = state.liveSources,
                        )
                        FeedView.LiveStreams -> LiveStreamsPane(
                            sources = state.liveSources,
                            loading = state.loading,
                            refreshing = state.liveRefreshing,
                            refreshingSourceId = state.liveRefreshingSourceId,
                            browsingSourceId = browsingLiveSourceId,
                            onOpenSource = { openLiveSource(it) },
                            onPlayVideo = { sourceId, videoId -> playLiveVideo(sourceId, videoId) },
                            onRefreshSource = onRefreshOneLiveSource,
                        )
                        FeedView.LiveCategories -> LiveCategoriesPane(
                            categories = state.liveCategories,
                            sources = state.liveSources,
                            loading = state.loading,
                            refreshing = state.liveRefreshing,
                            refreshingSourceId = state.liveRefreshingSourceId,
                            browsingCategoryId = browsingLiveCategoryId,
                            browsingSourceId = browsingLiveSourceId,
                            onSelectCategory = { browsingLiveCategoryId = it },
                            onOpenSource = { openLiveSource(it) },
                            onPlayVideo = { sourceId, videoId -> playLiveVideo(sourceId, videoId) },
                            onRefreshSource = onRefreshOneLiveSource,
                        )
                        else -> {
                            if (state.view == FeedView.Inbox) {
                                InboxListPane(
                                    state = state,
                                    categoryMenuOpen = categoryMenuOpen,
                                    onCategoryMenuOpenChange = { categoryMenuOpen = it },
                                    onSelectCategory = onSelectCategory,
                                    onOpen = onOpen,
                                    onArchiveItem = onArchiveItem,
                                    onRequestSnooze = onRequestSnooze,
                                    selectionMode = selectionMode,
                                    selectedVideoIds = selectedVideoIds,
                                    detailVideoId = null,
                                    onToggleSelect = { id ->
                                        selectedVideoIds =
                                            if (id in selectedVideoIds) selectedVideoIds - id else selectedVideoIds + id
                                    },
                                    onEnterSelection = { id -> selectedVideoIds = selectedVideoIds + id },
                                    onPlaythrough = onPlaythrough,
                                    onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
                                )
                            } else {
                                VideoList(
                                    state,
                                    onOpen,
                                    onArchiveItem,
                                    onRequestSnooze,
                                    onCompleteSnoozeExit,
                                    swipe = false,
                                    onPlaythrough = onPlaythrough,
                                    onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
                                )
                            }
                        }
                    }
                }
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
    if (confirmArchiveOpen) {
        AlertDialog(
            onDismissRequest = { confirmArchiveOpen = false },
            title = { Text("Archive videos") },
            text = { Text("Are you sure you want to archive these") },
            confirmButton = {
                TextButton(
                    onClick = {
                        val ids = selectedVideoIds.toList()
                        confirmArchiveOpen = false
                        selectedVideoIds = emptySet()
                        onArchiveVideos(ids)
                    },
                ) { Text("Confirm") }
            },
            dismissButton = {
                TextButton(onClick = { confirmArchiveOpen = false }) { Text("Cancel") }
            },
        )
    }
    if (bulkSnoozeOpen) {
        SnoozeDurationDialog(
            onPick = { until ->
                val ids = selectedVideoIds.toList()
                bulkSnoozeOpen = false
                selectedVideoIds = emptySet()
                onSnoozeVideos(ids, until)
            },
            onDismiss = { bulkSnoozeOpen = false },
        )
    }
    if (watchlistBulkOpen) {
        BulkWatchlistDialog(
            watchlists = state.watchlists,
            onDismiss = { watchlistBulkOpen = false },
            onConfirm = { listId ->
                val ids = selectedVideoIds.toList()
                watchlistBulkOpen = false
                selectedVideoIds = emptySet()
                onMoveVideosToWatchlist(listId, ids)
            },
        )
    }

    EditChannelDialog(state, onCloseEditChannel, onSaveChannelEdit)
    PendingSnoozeDialog(state, onConfirmPendingSnooze, onCancelPendingSnooze)
    MessageDialogs(state, onClearMessage, onUndoArchive, onUndoWatchlist)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InboxListPane(
    state: FeedUiState,
    categoryMenuOpen: Boolean,
    onCategoryMenuOpenChange: (Boolean) -> Unit,
    onSelectCategory: (String?) -> Unit,
    onOpen: (InboxItem) -> Unit,
    onArchiveItem: (InboxItem) -> Unit,
    onRequestSnooze: (InboxItem) -> Unit,
    selectionMode: Boolean,
    selectedVideoIds: Set<String>,
    detailVideoId: String?,
    onToggleSelect: (String) -> Unit,
    onEnterSelection: (String) -> Unit,
    onCompleteSnoozeExit: () -> Unit = {},
    onPlaythrough: () -> Unit = {},
    onStopPlaythrough: () -> Unit = {},
    onLoadMore: () -> Unit = {},
) {
    val uncategorizedId = "__uncategorized__"
    val selectedCategoryName = when (state.categoryId) {
        null -> "All categories"
        uncategorizedId -> "No category"
        else -> state.categories.firstOrNull { it.id == state.categoryId }?.name ?: "All categories"
    }
    FilterDropdown(
        expanded = categoryMenuOpen,
        onExpandedChange = onCategoryMenuOpenChange,
        label = "Category",
        value = selectedCategoryName,
    ) {
        DropdownMenuItem(
            text = { Text("All categories") },
            onClick = {
                onCategoryMenuOpenChange(false)
                onSelectCategory(null)
            },
        )
        DropdownMenuItem(
            text = { Text("No category") },
            onClick = {
                onCategoryMenuOpenChange(false)
                onSelectCategory(uncategorizedId)
            },
        )
        state.categories.forEach { cat ->
            DropdownMenuItem(
                text = { Text(cat.name) },
                onClick = {
                    onCategoryMenuOpenChange(false)
                    onSelectCategory(cat.id)
                },
            )
        }
    }
    VideoList(
        state = state,
        onOpen = onOpen,
        onArchiveItem = onArchiveItem,
        onRequestSnooze = onRequestSnooze,
        onCompleteSnoozeExit = onCompleteSnoozeExit,
        swipe = !selectionMode,
        selectionMode = selectionMode,
        selectedIds = selectedVideoIds,
        detailVideoId = detailVideoId,
        onToggleSelect = onToggleSelect,
        onEnterSelection = onEnterSelection,
        onPlaythrough = onPlaythrough,
        onStopPlaythrough = onStopPlaythrough,
            onLoadMore = onLoadMore,
    )
}

@Composable
private fun LoadMoreOnEnd(
    listState: LazyListState,
    enabled: Boolean,
    loading: Boolean,
    onLoadMore: () -> Unit,
) {
    val shouldLoad by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            val total = listState.layoutInfo.totalItemsCount
            total > 0 && last >= total - 8
        }
    }
    LaunchedEffect(shouldLoad, enabled, loading) {
        if (shouldLoad && enabled && !loading) onLoadMore()
    }
}

@Composable
private fun VideoList(
    state: FeedUiState,
    onOpen: (InboxItem) -> Unit,
    onArchiveItem: (InboxItem) -> Unit,
    onRequestSnooze: (InboxItem) -> Unit,
    onCompleteSnoozeExit: () -> Unit = {},
    swipe: Boolean,
    selectionMode: Boolean = false,
    selectedIds: Set<String> = emptySet(),
    detailVideoId: String? = null,
    onToggleSelect: (String) -> Unit = {},
    onEnterSelection: (String) -> Unit = {},
    onPlaythrough: () -> Unit = {},
    onStopPlaythrough: () -> Unit = {},
    onLoadMore: () -> Unit = {},
) {
    Column(modifier = Modifier.fillMaxSize()) {
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
            val listState = rememberLazyListState()
            LaunchedEffect(state.view, state.categoryId, state.watchlistId, state.browsingChannelId) {
                listState.scrollToItem(0)
            }
            if (state.items.any { it.embeddable }) {
                PlaythroughBar(
                    active = state.playthroughActive,
                    onClick = { if (state.playthroughActive) onStopPlaythrough() else onPlaythrough() },
                )
            }
            LoadMoreOnEnd(listState, state.feedHasMore, state.feedLoadingMore, onLoadMore)
            LazyColumn(
                state = listState,
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                items(state.items, key = { it.videoId }) { item ->
                    val multiSelected = item.videoId in selectedIds
                    val detailSelected = !selectionMode && detailVideoId == item.videoId
                    val exiting = state.snoozeExitVideoId == item.videoId
                    if (swipe && !selectionMode) {
                        SwipeFeedRow(
                            item = item,
                            onOpen = { onOpen(item) },
                            onArchive = { onArchiveItem(item) },
                            onSnooze = { onRequestSnooze(item) },
                            onLongPress = { onEnterSelection(item.videoId) },
                            highlighted = detailSelected,
                            exiting = exiting,
                            onExitFinished = onCompleteSnoozeExit,
                        )
                    } else {
                        FeedRow(
                            item = item,
                            selected = multiSelected,
                            highlighted = detailSelected,
                            selectionMode = selectionMode,
                            onClick = {
                                if (selectionMode) onToggleSelect(item.videoId) else onOpen(item)
                            },
                            onLongPress = { onEnterSelection(item.videoId) },
                            exiting = exiting,
                            onExitFinished = onCompleteSnoozeExit,
                        )
                    }
                }
                if (state.feedLoadingMore) {
                    item("inbox-loading-more") {
                        Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(24.dp))
                        }
                    }
                }
            }
        }
        }
    }
}

@Composable
private fun BulkWatchlistDialog(
    watchlists: List<WatchlistRecord>,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var pickedId by remember { mutableStateOf(watchlists.firstOrNull()?.id) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add to watchlist") },
        text = {
            if (watchlists.isEmpty()) {
                Text("Create a watchlist first.")
            } else {
                LazyColumn(modifier = Modifier.heightIn(max = 360.dp)) {
                    items(watchlists, key = { it.id }) { list ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .toggleable(
                                    value = pickedId == list.id,
                                    role = Role.RadioButton,
                                    onValueChange = { pickedId = list.id },
                                )
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = pickedId == list.id,
                                onClick = { pickedId = list.id },
                            )
                            Text(list.name, modifier = Modifier.padding(start = 8.dp))
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !pickedId.isNullOrBlank(),
                onClick = { pickedId?.let(onConfirm) },
            ) { Text("Confirm") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

@Composable
private fun CategoriesPanel(
    categories: List<CategoryRecord>,
    channels: List<ChannelRecord>,
    onSelect: (String) -> Unit,
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
            val tagged = channels.filter { cat.id in it.categoryIds }
            val streamCount = tagged.size
            val videoCount = tagged.sumOf { it.inboxVideoCount }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .clickable { onSelect(cat.id) }
                    .padding(vertical = 8.dp, horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    buildAnnotatedString {
                        append(cat.name)
                        withStyle(
                            SpanStyle(
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                fontSize = 13.sp,
                            ),
                        ) {
                            append("\n$videoCount video${if (videoCount == 1) "" else "s"} - $streamCount channel${if (streamCount == 1) "" else "s"}")
                        }
                    },
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                IconButton(
                    onClick = { editing = cat },
                    modifier = Modifier.size(32.dp),
                ) {
                    Icon(
                        Icons.Default.Edit,
                        contentDescription = "Edit category",
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f),
                    )
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
    status: String?,
    onOpen: (String) -> Unit,
    selectedChannelId: String? = null,
) {
    var categoryMenuOpen by remember { mutableStateOf(false) }
    var filterCategoryId by remember { mutableStateOf<String?>(null) }
    val uncategorizedId = "__uncategorized__"
    val filteredChannels = remember(channels, filterCategoryId) {
        when (filterCategoryId) {
            null -> channels
            uncategorizedId -> channels.filter { it.categoryIds.isEmpty() }
            else -> channels.filter { filterCategoryId in it.categoryIds }
        }
    }
    val filterLabel = when (filterCategoryId) {
        null -> "All categories"
        uncategorizedId -> "No category"
        else -> categories.firstOrNull { it.id == filterCategoryId }?.name ?: "All categories"
    }

    Column(Modifier.fillMaxSize()) {
        FilterDropdown(
            expanded = categoryMenuOpen,
            onExpandedChange = { categoryMenuOpen = it },
            label = "Category",
            value = filterLabel,
        ) {
            DropdownMenuItem(
                text = { Text("All categories") },
                onClick = {
                    categoryMenuOpen = false
                    filterCategoryId = null
                },
            )
            DropdownMenuItem(
                text = { Text("No category") },
                onClick = {
                    categoryMenuOpen = false
                    filterCategoryId = uncategorizedId
                },
            )
            categories.forEach { cat ->
                DropdownMenuItem(
                    text = { Text(cat.name) },
                    onClick = {
                        categoryMenuOpen = false
                        filterCategoryId = cat.id
                    },
                )
            }
        }
        if (!status.isNullOrBlank()) {
            Text(
                status,
                modifier = Modifier.padding(horizontal = 16.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (filteredChannels.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    if (channels.isEmpty()) "No subscriptions yet."
                    else "No streams in this category.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            val listState = rememberLazyListState()
            LaunchedEffect(filterCategoryId) {
                listState.scrollToItem(0)
            }
            LazyColumn(
                state = listState,
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(filteredChannels, key = { it.channelId }) { ch ->
                    val selected = ch.channelId == selectedChannelId
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                                else Color.Transparent,
                            )
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
                                "${ch.inboxVideoCount} video${if (ch.inboxVideoCount == 1) "" else "s"} - ${if (ch.followInInbox) "Following" else "Not following"}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            val names = categories.filter { it.id in ch.categoryIds }.joinToString(", ") { it.name }
                            Text(
                                names.ifBlank { "No category" },
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StreamVideosPane(
    channel: ChannelRecord,
    categories: List<CategoryRecord>,
    items: List<InboxItem>,
    loading: Boolean,
    syncing: Boolean,
    status: String?,
    detailVideoId: String?,
    snoozeExitVideoId: String?,
    onCatchUp: () -> Unit,
    onEdit: () -> Unit,
    onOpen: (InboxItem) -> Unit,
    onArchiveItem: (InboxItem) -> Unit,
    onRequestSnooze: (InboxItem) -> Unit,
    onCompleteSnoozeExit: () -> Unit,
    playthroughActive: Boolean = false,
    onPlaythrough: () -> Unit = {},
    onStopPlaythrough: () -> Unit = {},
    hasMore: Boolean = false,
    loadingMore: Boolean = false,
    onLoadMore: () -> Unit = {},
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Text(
            channel.title,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Row(
            modifier = Modifier.padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            TextButton(onClick = onCatchUp, enabled = !syncing) {
                Text(if (syncing) "Working…" else "Catch up")
            }
            TextButton(onClick = onEdit) { Text("Edit") }
        }
        val names = categories.filter { it.id in channel.categoryIds }.joinToString(", ") { it.name }
        if (names.isNotBlank()) {
            Text(
                names,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (!status.isNullOrBlank()) {
            Text(
                status,
                modifier = Modifier.padding(horizontal = 12.dp),
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
                    Text("No videos", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            else -> {
                if (items.any { it.embeddable }) {
                    PlaythroughBar(
                        active = playthroughActive,
                        onClick = { if (playthroughActive) onStopPlaythrough() else onPlaythrough() },
                    )
                }
                val listState = rememberLazyListState()
                LoadMoreOnEnd(listState, hasMore, loadingMore, onLoadMore)
                LazyColumn(
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    items(items, key = { it.videoId }) { item ->
                        FeedRow(
                            item = item,
                            onClick = { onOpen(item) },
                            showChannelInMeta = false,
                            highlighted = detailVideoId == item.videoId,
                            exiting = snoozeExitVideoId == item.videoId,
                            onExitFinished = onCompleteSnoozeExit,
                        )
                    }
                    if (loadingMore) {
                        item("stream-loading-more") {
                            Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(Modifier.size(24.dp))
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
    snoozeExitVideoId: String?,
    playthroughActive: Boolean = false,
    onBack: () -> Unit,
    onCatchUp: () -> Unit,
    onEdit: () -> Unit,
    onOpen: (InboxItem) -> Unit,
    onArchiveItem: (InboxItem) -> Unit,
    onRequestSnooze: (InboxItem) -> Unit,
    onCompleteSnoozeExit: () -> Unit,
    onPlaythrough: () -> Unit = {},
    onStopPlaythrough: () -> Unit = {},
    hasMore: Boolean = false,
    loadingMore: Boolean = false,
    onLoadMore: () -> Unit = {},
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
                    if (items.any { it.embeddable }) {
                        PlaythroughBar(
                            active = playthroughActive,
                            onClick = { if (playthroughActive) onStopPlaythrough() else onPlaythrough() },
                        )
                    }
                    val listState = rememberLazyListState()
                    LoadMoreOnEnd(listState, hasMore, loadingMore, onLoadMore)
                    LazyColumn(
                        state = listState,
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(items, key = { it.videoId }) { item ->
                            SwipeFeedRow(
                                item = item,
                                onOpen = { onOpen(item) },
                                onArchive = { onArchiveItem(item) },
                                onSnooze = { onRequestSnooze(item) },
                                showChannelInMeta = false,
                                exiting = snoozeExitVideoId == item.videoId,
                                onExitFinished = onCompleteSnoozeExit,
                            )
                        }
                        if (loadingMore) {
                            item("stream-detail-loading-more") {
                                Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(Modifier.size(24.dp))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PlaythroughBar(active: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onClick) {
            Icon(
                Icons.Default.PlayArrow,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(if (active) "Exit playthrough" else "Playthrough")
        }
    }
}

@Composable
private fun PlaythroughOverlay(
    item: InboxItem,
    onExit: () -> Unit,
    onPlayerEvent: (videoId: String, type: String, currentTime: Double, rate: Double, duration: Double?) -> Unit,
    onFlushPlayback: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        YoutubePlayer(
            videoId = item.videoId,
            embeddable = item.embeddable,
            thumbnailUrl = item.thumbnailUrl,
            autoplay = true,
            onPlayerEvent = onPlayerEvent,
            onFlushPlayback = onFlushPlayback,
            modifier = Modifier.fillMaxSize(),
        )
        IconButton(
            onClick = onExit,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .statusBarsPadding()
                .padding(8.dp),
        ) {
            Icon(Icons.Default.Close, contentDescription = "Exit playthrough", tint = Color.White)
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
                    Text("Add a category in By Category first.", color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    @Suppress("UNUSED_PARAMETER") onUndoArchive: () -> Unit,
    onUndoWatchlist: () -> Unit,
) {
    val message = state.message
    if (!message.isNullOrBlank() && message != "Archived" && !message.startsWith("Archived ")) {
        val canUndoWatchlist = !state.undoWatchlistVideoId.isNullOrBlank() && message.startsWith("Added to ")
        AlertDialog(
            onDismissRequest = onClearMessage,
            confirmButton = { TextButton(onClick = onClearMessage) { Text("OK") } },
            dismissButton = if (canUndoWatchlist) {
                { TextButton(onClick = onUndoWatchlist) { Text("Undo") } }
            } else {
                null
            },
            text = { Text(message) },
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SnoozeDurationDialog(onPick: (Long) -> Unit, onDismiss: () -> Unit) {
    var step by remember { mutableStateOf(SnoozePickerStep.Presets) }
    val zone = java.time.ZoneId.systemDefault()
    val now = java.time.ZonedDateTime.now(zone)
    val initialDateMillis = now.toLocalDate()
        .atStartOfDay(java.time.ZoneOffset.UTC)
        .toInstant()
        .toEpochMilli()
    val datePickerState = rememberDatePickerState(
        initialSelectedDateMillis = initialDateMillis,
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long): Boolean {
                val todayUtc = java.time.LocalDate.now(zone)
                    .atStartOfDay(java.time.ZoneOffset.UTC)
                    .toInstant()
                    .toEpochMilli()
                return utcTimeMillis >= todayUtc
            }
        },
    )
    val timePickerState = rememberTimePickerState(
        initialHour = (now.hour + 1).coerceAtMost(23),
        initialMinute = 0,
        is24Hour = false,
    )

    when (step) {
        SnoozePickerStep.Presets -> {
            AlertDialog(
                onDismissRequest = onDismiss,
                title = { Text("Snooze") },
                text = {
                    Column {
                        TextButton(onClick = { onPick(snoozeHoursFromNow(3)) }) { Text("3 hours") }
                        TextButton(onClick = { onPick(snoozeThisEvening()) }) { Text("This Evening") }
                        TextButton(onClick = { onPick(snoozeHoursFromNow(24)) }) { Text("Tomorrow") }
                        TextButton(onClick = { onPick(snoozeNextWeekMondayMorning()) }) { Text("Next Week") }
                        TextButton(onClick = { step = SnoozePickerStep.Date }) { Text("Choose date & time") }
                    }
                },
                confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
            )
        }
        SnoozePickerStep.Date -> {
            DatePickerDialog(
                onDismissRequest = onDismiss,
                confirmButton = {
                    TextButton(
                        onClick = {
                            if (datePickerState.selectedDateMillis != null) {
                                step = SnoozePickerStep.Time
                            }
                        },
                    ) { Text("Next") }
                },
                dismissButton = {
                    TextButton(onClick = { step = SnoozePickerStep.Presets }) { Text("Back") }
                },
            ) {
                DatePicker(state = datePickerState)
            }
        }
        SnoozePickerStep.Time -> {
            AlertDialog(
                onDismissRequest = onDismiss,
                title = { Text("Choose time") },
                text = {
                    TimePicker(state = timePickerState)
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            val dateMillis = datePickerState.selectedDateMillis ?: return@TextButton
                            val localDate = java.time.Instant.ofEpochMilli(dateMillis)
                                .atZone(java.time.ZoneOffset.UTC)
                                .toLocalDate()
                            val until = localDate
                                .atTime(timePickerState.hour, timePickerState.minute)
                                .atZone(zone)
                                .toInstant()
                                .toEpochMilli()
                            if (until <= System.currentTimeMillis()) return@TextButton
                            onPick(until)
                        },
                    ) { Text("Snooze") }
                },
                dismissButton = {
                    TextButton(onClick = { step = SnoozePickerStep.Date }) { Text("Back") }
                },
            )
        }
    }
}

private enum class SnoozePickerStep { Presets, Date, Time }

private fun snoozeHoursFromNow(hours: Long): Long =
    java.time.Instant.now().plus(hours, java.time.temporal.ChronoUnit.HOURS).toEpochMilli()

/** Today at 6 PM local, or tomorrow 6 PM if already past 6 PM. */
private fun snoozeThisEvening(): Long {
    val zone = java.time.ZoneId.systemDefault()
    val now = java.time.ZonedDateTime.now(zone)
    var target = now.toLocalDate().atTime(18, 0).atZone(zone)
    if (!target.isAfter(now)) {
        target = target.plusDays(1)
    }
    return target.toInstant().toEpochMilli()
}

/** Next Monday at 7 AM local (today if Monday and still before 7 AM). */
private fun snoozeNextWeekMondayMorning(): Long {
    val zone = java.time.ZoneId.systemDefault()
    val now = java.time.ZonedDateTime.now(zone)
    var day = now.toLocalDate()
    while (day.dayOfWeek != java.time.DayOfWeek.MONDAY) {
        day = day.plusDays(1)
    }
    var target = day.atTime(7, 0).atZone(zone)
    if (!target.isAfter(now)) {
        target = day.plusWeeks(1).atTime(7, 0).atZone(zone)
    }
    return target.toInstant().toEpochMilli()
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
private fun AppDrawer(
    current: FeedView,
    currentWatchlistId: String?,
    watchlists: List<WatchlistRecord>,
    onSelect: (FeedView) -> Unit,
    onSelectWatchlist: (String) -> Unit,
    onSignOut: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxHeight()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        NavTopItem(
            label = "Feeds",
            selected = current.isFeedSection,
            onClick = null,
        )
        NavSubItem(
            label = FeedView.Inbox.label,
            selected = current == FeedView.Inbox,
            onClick = { onSelect(FeedView.Inbox) },
        )
        NavSubItem(
            label = FeedView.Categories.label,
            selected = current == FeedView.Categories,
            onClick = { onSelect(FeedView.Categories) },
        )
        NavSubItem(
            label = FeedView.Streams.label,
            selected = current == FeedView.Streams,
            onClick = { onSelect(FeedView.Streams) },
        )
        NavSubItem(
            label = FeedView.Snoozed.label,
            selected = current == FeedView.Snoozed,
            onClick = { onSelect(FeedView.Snoozed) },
        )
        NavSubItem(
            label = FeedView.Deleted.label,
            selected = current == FeedView.Deleted,
            onClick = { onSelect(FeedView.Deleted) },
        )
        NavTopItem(
            label = FeedView.Watchlist.label,
            selected = current == FeedView.Watchlist,
            onClick = { onSelect(FeedView.Watchlist) },
        )
        watchlists.forEach { list ->
            NavSubItem(
                label = "${list.name} (${list.videoCount})",
                selected = current == FeedView.Watchlist && currentWatchlistId == list.id,
                onClick = { onSelectWatchlist(list.id) },
            )
        }
        NavTopItem(
            label = "Live",
            selected = current.isLiveSection,
            onClick = null,
        )
        NavSubItem(
            label = FeedView.LiveGrid.label,
            selected = current == FeedView.LiveGrid,
            onClick = { onSelect(FeedView.LiveGrid) },
        )
        NavSubItem(
            label = FeedView.LiveStreams.label,
            selected = current == FeedView.LiveStreams,
            onClick = { onSelect(FeedView.LiveStreams) },
        )
        NavSubItem(
            label = FeedView.LiveCategories.label,
            selected = current == FeedView.LiveCategories,
            onClick = { onSelect(FeedView.LiveCategories) },
        )
        NavTopItem(
            label = FeedView.Settings.label,
            selected = current == FeedView.Settings,
            onClick = { onSelect(FeedView.Settings) },
        )
        NavSubItem(
            label = "Sign Out",
            selected = false,
            onClick = onSignOut,
        )
    }
}

@Composable
private fun SettingsPane(
    theme: AppTheme,
    displayName: String?,
    onSelectTheme: (AppTheme) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (!displayName.isNullOrBlank()) {
            Text(
                "Signed in as $displayName",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
        }
        Text(
            "Appearance",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            "Choose a background. Sepia is a warm reading theme that reduces blue light.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        AppTheme.entries.forEach { option ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .clickable { onSelectTheme(option) }
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(
                    selected = theme == option,
                    onClick = { onSelectTheme(option) },
                )
                Column(modifier = Modifier.padding(start = 4.dp)) {
                    Text(option.label, style = MaterialTheme.typography.titleMedium)
                    Text(
                        option.description,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Text(
            "v${BuildConfig.VERSION_NAME}",
            modifier = Modifier.padding(top = 16.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun LiveGridSizeButtons(
    gridSize: Int,
    onGridSizeChange: (Int) -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        LiveGridSizes.forEach { size ->
            Text(
                "$size",
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable { onGridSizeChange(size) }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = if (gridSize == size) FontWeight.SemiBold else FontWeight.Normal,
                color = if (gridSize == size) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
    }
}

@Composable
private fun LiveGridPane(
    modifier: Modifier = Modifier,
    gridSize: Int,
    slotFeeds: List<String?>,
    onSlotFeedChange: (Int, String?) -> Unit,
    activeSlot: Int,
    onActivate: (Int) -> Unit,
    onFullscreen: ((Int) -> Unit)?,
    sources: List<LiveSourceRecord>,
    compact: Boolean = false,
) {
    val columns = liveGridColumns(gridSize)
    val rows = gridSize / columns
    val gap = if (compact) 2.dp else 6.dp
    Column(
        modifier = modifier
            .fillMaxWidth()
            .then(if (compact) Modifier else Modifier.padding(horizontal = 8.dp, vertical = 4.dp)),
        verticalArrangement = Arrangement.spacedBy(gap),
    ) {
        repeat(rows) { row ->
            Row(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(gap),
            ) {
                repeat(columns) { col ->
                    val index = row * columns + col
                    LiveSlotCard(
                        number = index + 1,
                        selected = slotFeeds[index],
                        sources = sources,
                        onSelect = { onSlotFeedChange(index, it) },
                        focused = activeSlot == index,
                        onFocus = { onActivate(index) },
                        onFullscreen = onFullscreen?.let { expand -> { expand(index) } },
                        compact = compact,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun LiveSlotCard(
    number: Int,
    selected: String?,
    sources: List<LiveSourceRecord>,
    onSelect: (String?) -> Unit,
    modifier: Modifier = Modifier,
    focused: Boolean = false,
    onFocus: () -> Unit = {},
    onFullscreen: (() -> Unit)? = null,
    onExitFullscreen: (() -> Unit)? = null,
    compact: Boolean = false,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val (selectedSourceId, selectedVideoId) = parseLiveSlotValue(selected)
    val selectedSource = sources.firstOrNull { it.id == selectedSourceId }
    val liveVideos = selectedSource?.playableLive().orEmpty()
    val selectedVideo = selectedVideoId?.let { id -> liveVideos.firstOrNull { it.videoId == id } }
        ?: liveVideos.firstOrNull()
    val selectedLabel = selectedVideo?.title ?: selectedSource?.displayName ?: "Select feed"
    val embedId = selectedVideo?.videoId ?: selectedSource?.embedVideoId()
    Column(
        modifier = modifier
            .fillMaxHeight()
            .clip(RoundedCornerShape(if (compact) 2.dp else 10.dp))
            .background(Color.Black)
            .then(if (compact) Modifier else Modifier.padding(6.dp)),
    ) {
        if (!compact) {
            Row(verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.weight(1f)) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.92f))
                        .clickable { menuOpen = true }
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        selectedLabel,
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall,
                    )
                    Icon(
                        Icons.Default.ArrowDropDown,
                        contentDescription = "Choose live feed",
                        modifier = Modifier.size(18.dp),
                    )
                }
                DropdownMenu(
                    expanded = menuOpen,
                    onDismissRequest = { menuOpen = false },
                    modifier = Modifier.heightIn(max = 360.dp),
                ) {
                    DropdownMenuItem(
                        text = { Text("Empty") },
                        onClick = {
                            onSelect(null)
                            menuOpen = false
                        },
                    )
                    sources.filter { it.enabled }.forEach { source ->
                        val lives = source.playableLive()
                        if (lives.isEmpty()) {
                            DropdownMenuItem(
                                text = { Text("${source.displayName} · ${source.statusLabel()}") },
                                enabled = false,
                                onClick = {},
                            )
                        } else {
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        "${source.displayName} (${lives.size} live)",
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                },
                                enabled = false,
                                onClick = {},
                            )
                            lives.forEach { video ->
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            video.title,
                                            modifier = Modifier.padding(start = 8.dp),
                                            maxLines = 2,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    },
                                    onClick = {
                                        onSelect(liveSlotAssignment(source.id, video.videoId))
                                        onFocus()
                                        menuOpen = false
                                    },
                                )
                            }
                        }
                    }
                }
            }
            if (onFullscreen != null) {
                IconButton(onClick = onFullscreen, modifier = Modifier.size(32.dp)) {
                    Icon(
                        Icons.Default.Fullscreen,
                        contentDescription = "Full screen",
                        tint = Color.White,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            if (onExitFullscreen != null) {
                IconButton(onClick = onExitFullscreen, modifier = Modifier.size(36.dp)) {
                    Icon(
                        Icons.Default.FullscreenExit,
                        contentDescription = "Exit full screen",
                        tint = Color.White,
                    )
                }
            }
            }
        }
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .clip(RoundedCornerShape(if (compact) 0.dp else 6.dp))
                .background(Color.Black),
            contentAlignment = Alignment.Center,
        ) {
            when {
                embedId != null -> LiveEmbedPlayer(
                    videoId = embedId,
                    muted = !focused,
                    modifier = Modifier.fillMaxSize(),
                )
                selectedSource != null -> Text(
                    "${selectedSource.displayName} is ${selectedSource.statusLabel().lowercase()}.",
                    color = Color.White.copy(alpha = 0.8f),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(8.dp),
                )
                else -> Text(
                    "Slot $number · Empty",
                    color = Color.White.copy(alpha = 0.7f),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun LiveEmbedPlayer(
    videoId: String,
    muted: Boolean,
    modifier: Modifier = Modifier,
) {
    val html = remember(videoId) {
        """
        <!DOCTYPE html><html><head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
          <style>html,body,#player{margin:0;padding:0;background:#000;height:100%;width:100%;overflow:hidden;}iframe{border:0;width:100%;height:100%;}</style>
        </head><body>
          <div id="player"></div>
          <script>
            var tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(tag);
            var player;
            var muted = true;
            function applyMute() {
              if (!player || !player.mute) return;
              if (muted) player.mute(); else player.unMute();
            }
            function onYouTubeIframeAPIReady() {
              player = new YT.Player('player', {
                videoId: '$videoId',
                host: 'https://www.youtube-nocookie.com',
                playerVars: { autoplay: 1, mute: 1, playsinline: 1, rel: 0, modestbranding: 1, enablejsapi: 1 },
                events: {
                  onReady: function () {
                    applyMute();
                    player.playVideo();
                  }
                }
              });
            }
          </script>
        </body></html>
        """.trimIndent()
    }
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                setBackgroundColor(android.graphics.Color.BLACK)
                webViewClient = WebViewClient()
                webChromeClient = WebChromeClient()
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
            webView.evaluateJavascript(
                "muted = ${if (muted) "true" else "false"}; if (typeof applyMute === 'function') applyMute();",
                null,
            )
        },
        onRelease = {
            it.stopLoading()
            it.destroy()
        },
        modifier = modifier,
    )
}

@Composable
private fun LiveStreamsPane(
    sources: List<LiveSourceRecord>,
    loading: Boolean,
    refreshing: Boolean,
    refreshingSourceId: String?,
    browsingSourceId: String?,
    onOpenSource: (LiveSourceRecord) -> Unit,
    onPlayVideo: (sourceId: String, videoId: String) -> Unit,
    onRefreshSource: (String) -> Unit,
    hint: String = "Tap a live source to play it. Sources with multiple cameras open a picker first.",
    emptyMessage: String = "No live sources yet. Add a YouTube channel on the website, then refresh here.",
) {
    val browsingSource = browsingSourceId?.let { id -> sources.firstOrNull { it.id == id } }
    if (browsingSource != null) {
        LiveSourceVideosPane(
            source = browsingSource,
            onPlayVideo = { videoId -> onPlayVideo(browsingSource.id, videoId) },
        )
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            hint,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        when {
            loading && sources.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }
            sources.isEmpty() -> {
                Text(
                    emptyMessage,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            else -> {
                if (refreshing) {
                    Text(
                        "Checking live status…",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                sources.forEach { source ->
                    LiveSourceRow(
                        source = source,
                        refreshing = refreshing,
                        refreshingSourceId = refreshingSourceId,
                        onOpen = { onOpenSource(source) },
                        onRefresh = { onRefreshSource(source.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun LiveSourceRow(
    source: LiveSourceRecord,
    refreshing: Boolean,
    refreshingSourceId: String?,
    onOpen: () -> Unit,
    onRefresh: () -> Unit,
) {
    val playable = source.playableLive()
    val status = source.statusLabel()
    val liveTitle = playable.firstOrNull()?.title
        ?: source.blockedLive().firstOrNull()?.title
    val canOpen = playable.isNotEmpty() ||
        source.blockedLive().isNotEmpty() ||
        source.upcoming().isNotEmpty()
    val refreshingThis = refreshingSourceId == source.id
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
            .then(
                if (canOpen) {
                    Modifier.clickable(onClick = onOpen)
                } else {
                    Modifier
                },
            )
            .padding(start = 14.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    source.displayName,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.titleMedium,
                )
                if (source.liveCount() > 0) {
                    Text(
                        "${source.liveCount()} LIVE",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            Text(
                buildString {
                    append(status)
                    if (!source.enabled) append(" · Off")
                    if (playable.size > 1) {
                        append(" · ").append(playable.size).append(" cameras")
                    } else if (liveTitle != null) {
                        append(" · ").append(liveTitle)
                    }
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (!source.verifyError.isNullOrBlank()) {
                Text(
                    source.verifyError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
        if (refreshingThis) {
            Box(
                modifier = Modifier.size(48.dp),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(22.dp),
                    strokeWidth = 2.dp,
                )
            }
        } else {
            IconButton(
                onClick = onRefresh,
                enabled = !refreshing && refreshingSourceId == null,
            ) {
                Icon(
                    Icons.Default.Refresh,
                    contentDescription = "Refresh ${source.displayName}",
                )
            }
        }
        if (canOpen) {
            Icon(
                Icons.Default.ChevronRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun LiveSourceVideosPane(
    source: LiveSourceRecord,
    onPlayVideo: (videoId: String) -> Unit,
) {
    val playable = source.playableLive()
    val blocked = source.blockedLive()
    val upcoming = source.upcoming()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "Choose a live video to play in a single grid slot.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (playable.isEmpty() && blocked.isEmpty() && upcoming.isEmpty()) {
            Text(
                "No live videos right now. Refresh this source and try again.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (playable.isNotEmpty()) {
            Text(
                "Live",
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
            )
            playable.forEach { video ->
                LiveVideoRow(
                    video = video,
                    subtitle = "Live · Tap to play",
                    enabled = true,
                    onClick = { onPlayVideo(video.videoId) },
                )
            }
        }
        if (blocked.isNotEmpty()) {
            Text(
                "Not embeddable",
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
            )
            blocked.forEach { video ->
                LiveVideoRow(
                    video = video,
                    subtitle = "Live on YouTube, but embedding is blocked",
                    enabled = false,
                    onClick = {},
                )
            }
        }
        if (upcoming.isNotEmpty()) {
            Text(
                "Upcoming",
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
            )
            upcoming.forEach { video ->
                LiveVideoRow(
                    video = video,
                    subtitle = "Upcoming",
                    enabled = false,
                    onClick = {},
                )
            }
        }
    }
}

@Composable
private fun LiveVideoRow(
    video: LiveVideoRecord,
    subtitle: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                video.title,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                color = if (enabled) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (enabled) {
            Icon(
                Icons.Default.PlayArrow,
                contentDescription = "Play",
                tint = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
private fun LiveCategoriesPane(
    categories: List<CategoryRecord>,
    sources: List<LiveSourceRecord>,
    loading: Boolean,
    refreshing: Boolean,
    refreshingSourceId: String?,
    browsingCategoryId: String?,
    browsingSourceId: String?,
    onSelectCategory: (String?) -> Unit,
    onOpenSource: (LiveSourceRecord) -> Unit,
    onPlayVideo: (sourceId: String, videoId: String) -> Unit,
    onRefreshSource: (String) -> Unit,
) {
    val browsingSource = browsingSourceId?.let { id -> sources.firstOrNull { it.id == id } }
    if (browsingSource != null) {
        LiveSourceVideosPane(
            source = browsingSource,
            onPlayVideo = { videoId -> onPlayVideo(browsingSource.id, videoId) },
        )
        return
    }

    val categoryId = browsingCategoryId
    if (categoryId != null) {
        val filtered = sources.filter { categoryId in it.categoryIds }
        LiveStreamsPane(
            sources = filtered,
            loading = loading,
            refreshing = refreshing,
            refreshingSourceId = refreshingSourceId,
            browsingSourceId = null,
            onOpenSource = onOpenSource,
            onPlayVideo = onPlayVideo,
            onRefreshSource = onRefreshSource,
            hint = "Tap a source in this category to play it. Multi-camera sources open a picker first.",
            emptyMessage = "No live sources in this category yet. Tag streams on the website, then refresh.",
        )
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "Tap a category to see its live sources. Live categories are separate from Feed.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        when {
            loading && categories.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }
            categories.isEmpty() -> {
                Text(
                    "No live categories yet. Create and tag streams on the website.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            else -> {
                categories.forEach { category ->
                    val tagged = sources.filter { category.id in it.categoryIds }
                    val liveTagged = tagged.count { it.liveCount() > 0 }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
                            .clickable { onSelectCategory(category.id) }
                            .padding(horizontal = 14.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                category.name,
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(
                                buildString {
                                    append(tagged.size)
                                    append(if (tagged.size == 1) " source" else " sources")
                                    if (liveTagged > 0) {
                                        append(" · ")
                                        append(liveTagged)
                                        append(" live")
                                    }
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Icon(
                            Icons.Default.ChevronRight,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun NavTopItem(
    label: String,
    selected: Boolean,
    onClick: (() -> Unit)?,
) {
    Text(
        text = label,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f) else Color.Transparent,
            )
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 18.dp),
        style = MaterialTheme.typography.titleLarge,
        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
    )
}

@Composable
private fun NavSubItem(
    label: String,
    selected: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Text(
        text = label,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f) else Color.Transparent,
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(start = 36.dp, end = 16.dp, top = 12.dp, bottom = 12.dp),
        style = MaterialTheme.typography.titleMedium,
        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        color = when {
            !enabled -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
            selected -> MaterialTheme.colorScheme.primary
            else -> MaterialTheme.colorScheme.onSurfaceVariant
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
private fun SwipeFeedRow(
    item: InboxItem,
    onOpen: () -> Unit,
    onArchive: () -> Unit,
    onSnooze: () -> Unit,
    showChannelInMeta: Boolean = true,
    onLongPress: (() -> Unit)? = null,
    highlighted: Boolean = false,
    exiting: Boolean = false,
    onExitFinished: () -> Unit = {},
) {
    val exitModifier = rememberSnoozeExitModifier(exiting, onExitFinished)
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
        modifier = exitModifier,
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
        FeedRow(
            item = item,
            onClick = onOpen,
            onLongPress = onLongPress,
            showChannelInMeta = showChannelInMeta,
            highlighted = highlighted,
        )
    }
}

@Composable
private fun rememberSnoozeExitModifier(
    exiting: Boolean,
    onExitFinished: () -> Unit,
): Modifier {
    val density = LocalDensity.current
    val configuration = LocalConfiguration.current
    val slidePx = with(density) { configuration.screenWidthDp.dp.toPx() }
    val offsetX = remember { Animatable(0f) }
    var finished by remember { mutableStateOf(false) }
    LaunchedEffect(exiting) {
        if (exiting && !finished) {
            delay(180)
            offsetX.animateTo(
                targetValue = -slidePx,
                animationSpec = tween(durationMillis = 320, easing = FastOutLinearInEasing),
            )
            finished = true
            onExitFinished()
        } else if (!exiting) {
            finished = false
            if (offsetX.value != 0f) offsetX.snapTo(0f)
        }
    }
    return Modifier.offset { IntOffset(offsetX.value.roundToInt(), 0) }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FeedRow(
    item: InboxItem,
    onClick: () -> Unit,
    showChannelInMeta: Boolean = true,
    selectionMode: Boolean = false,
    selected: Boolean = false,
    highlighted: Boolean = false,
    onLongPress: (() -> Unit)? = null,
    exiting: Boolean = false,
    onExitFinished: () -> Unit = {},
) {
    val exitModifier = rememberSnoozeExitModifier(exiting, onExitFinished)
    Row(
        modifier = Modifier
            .then(exitModifier)
            .fillMaxWidth()
            .background(
                when {
                    selected -> MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                    highlighted -> MaterialTheme.colorScheme.primary.copy(alpha = 0.08f)
                    else -> MaterialTheme.colorScheme.surface
                },
            )
            .clip(RoundedCornerShape(8.dp))
            .combinedClickable(
                enabled = !exiting,
                onClick = onClick,
                onLongClick = onLongPress,
            )
            .padding(vertical = 4.dp, horizontal = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        if (selected) {
            Box(
                modifier = Modifier
                    .width(88.dp)
                    .height(66.dp),
                contentAlignment = Alignment.Center,
            ) {
                Checkbox(
                    checked = true,
                    onCheckedChange = { onClick() },
                )
            }
        } else {
            AsyncImage(
                model = item.thumbnailUrl,
                contentDescription = null,
                modifier = Modifier
                    .width(88.dp)
                    .height(66.dp)
                    .clip(RoundedCornerShape(6.dp)),
                contentScale = ContentScale.Crop,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    item.title,
                    maxLines = 4,
                    minLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    fontWeight = if (item.watchedAt == null) FontWeight.SemiBold else FontWeight.Normal,
                    fontFamily = FontFamily.Default,
                    color = if (item.watchedAt != null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleMedium.copy(lineHeight = 24.sp),
                    modifier = Modifier.weight(1f),
                )
            }
            val date = item.publishedAt?.take(10).orEmpty()
            val meta = if (showChannelInMeta) {
                listOf(item.channelTitle, date).filter { it.isNotBlank() }.joinToString(" · ")
            } else {
                date
            }
            if (meta.isNotBlank()) {
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
    onToggleWatched: () -> Unit = {},
    onPlayerEvent: (videoId: String, type: String, currentTime: Double, rate: Double, duration: Double?) -> Unit = { _, _, _, _, _ -> },
    onFlushPlayback: () -> Unit = {},
    embedded: Boolean = false,
) {
    var snoozeOpen by remember { mutableStateOf(false) }
    var watchOpen by remember { mutableStateOf(false) }
    var notes by remember(item.videoId, item.notes) { mutableStateOf(item.notes) }
    val context = LocalContext.current

    DisposableEffect(item.videoId) {
        var castPlayerContext: ChromecastYouTubePlayerContext? = null
        try {
            val castContext = CastContext.getSharedInstance(context.applicationContext)
            castPlayerContext = ChromecastYouTubePlayerContext(
                castContext.sessionManager,
                object : ChromecastConnectionListener {
                    override fun onChromecastConnecting() = Unit
                    override fun onChromecastConnected(chromecastYouTubePlayerContext: ChromecastYouTubePlayerContext) {
                        try {
                            chromecastYouTubePlayerContext.initialize(object : AbstractYouTubePlayerListener() {
                                override fun onReady(youTubePlayer: YouTubePlayer) {
                                    youTubePlayer.loadVideo(item.videoId, 0f)
                                }
                            })
                        } catch (_: Throwable) {
                        }
                    }
                    override fun onChromecastDisconnected() = Unit
                },
            )
        } catch (_: Throwable) {
            castPlayerContext = null
        }
        onDispose {
            try {
                castPlayerContext?.release()
            } catch (_: Throwable) {
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (!embedded) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
                actions = {
                    if (embedded) {
                        if (view == FeedView.Deleted) {
                            TextButton(onClick = onRestore) { Text("Restore") }
                            IconButton(onClick = { openOnYouTube(context, item.videoId) }) {
                                Icon(Icons.Default.PlayCircle, contentDescription = "Open on YouTube")
                            }
                        } else {
                            IconButton(onClick = { watchOpen = true }) {
                                Icon(Icons.Default.PlaylistAdd, contentDescription = "Add to watchlist")
                            }
                            IconButton(onClick = { openOnYouTube(context, item.videoId) }) {
                                Icon(Icons.Default.PlayCircle, contentDescription = "Open on YouTube")
                            }
                            if (view == FeedView.Snoozed) {
                                TextButton(onClick = onUnsnooze) { Text("Unsnooze") }
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
            YoutubePlayer(
                videoId = item.videoId,
                embeddable = item.embeddable,
                thumbnailUrl = item.thumbnailUrl,
                onPlayerEvent = onPlayerEvent,
                onFlushPlayback = onFlushPlayback,
            )
            if (!item.embeddable) {
                Text(
                    "This video can’t be embedded. Opening it on YouTube does not mark it watched.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = onToggleWatched) {
                Text(if (item.watchedAt != null) "Mark as unwatched" else "Mark as watched")
            }
            CastRow()
            Text(
                item.title,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Normal,
                fontFamily = FontFamily.Default,
            )
            Text(item.channelTitle, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!embedded) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (view == FeedView.Deleted) {
                        Button(onClick = onRestore) { Text("Restore") }
                        IconButton(onClick = { openOnYouTube(context, item.videoId) }) {
                            Icon(Icons.Default.PlayCircle, contentDescription = "Open on YouTube")
                        }
                    } else {
                        IconButton(onClick = { watchOpen = true }) {
                            Icon(Icons.Default.PlaylistAdd, contentDescription = "Add to watchlist")
                        }
                        IconButton(onClick = { openOnYouTube(context, item.videoId) }) {
                            Icon(Icons.Default.PlayCircle, contentDescription = "Open on YouTube")
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
    val context = LocalContext.current
    var castReady by remember {
        mutableStateOf(
            try {
                CastContext.getSharedInstance(context.applicationContext)
                true
            } catch (_: Throwable) {
                false
            },
        )
    }
    var routeButton by remember { mutableStateOf<MediaRouteButton?>(null) }

    if (!castReady) return

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
                try {
                    MediaRouteButton(ctx).also { button ->
                        CastButtonFactory.setUpMediaRouteButton(ctx.applicationContext, button)
                        routeButton = button
                    }
                } catch (_: Throwable) {
                    android.view.View(ctx)
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
private fun YoutubePlayer(
    videoId: String,
    embeddable: Boolean,
    thumbnailUrl: String,
    autoplay: Boolean = false,
    onPlayerEvent: (videoId: String, type: String, currentTime: Double, rate: Double, duration: Double?) -> Unit = { _, _, _, _, _ -> },
    onFlushPlayback: () -> Unit = {},
    modifier: Modifier = Modifier
        .fillMaxWidth()
        .aspectRatio(16f / 9f)
        .clip(RoundedCornerShape(12.dp)),
) {
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
        return
    }
    val activity = LocalContext.current as? Activity
    val eventHandler = remember { arrayOf(onPlayerEvent) }
    eventHandler[0] = onPlayerEvent
    DisposableEffect(videoId) {
        onDispose { onFlushPlayback() }
    }
    val html = remember(videoId, autoplay) {
        """
        <!DOCTYPE html><html><head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
          <meta name="referrer" content="strict-origin-when-cross-origin"/>
          <style>html,body,#player{margin:0;padding:0;background:#000;height:100%;width:100%;}iframe{border:0;width:100%;height:100%;}</style>
        </head><body>
          <div id="player"></div>
          <script>
            var tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(tag);
            var player;
            var shouldAutoplay = ${if (autoplay) "true" else "false"};
            function post(type) {
              try {
                var t = player && player.getCurrentTime ? player.getCurrentTime() : 0;
                var r = player && player.getPlaybackRate ? player.getPlaybackRate() : 1;
                var d = player && player.getDuration ? player.getDuration() : 0;
                AndroidWatch.postEvent(JSON.stringify({type:type, currentTime:t, rate:r, duration:d}));
              } catch (e) {}
            }
            function onYouTubeIframeAPIReady() {
              player = new YT.Player('player', {
                videoId: '$videoId',
                host: 'https://www.youtube-nocookie.com',
                playerVars: { playsinline: 1, rel: 0, modestbranding: 1, enablejsapi: 1, autoplay: shouldAutoplay ? 1 : 0 },
                events: {
                  onReady: function (e) { if (shouldAutoplay) e.target.playVideo(); },
                  onStateChange: function (e) {
                    if (e.data === 1) post('playing');
                    else if (e.data === 2) post('paused');
                    else if (e.data === 3) post('buffering');
                    else if (e.data === 0) post('ended');
                  }
                }
              });
              setInterval(function () {
                if (player && player.getPlayerState && player.getPlayerState() === 1) post('time');
              }, 400);
            }
          </script>
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
                addJavascriptInterface(
                    WatchJsBridge(
                        videoId = { (tag as? String) ?: videoId },
                        onEvent = { id, type, currentTime, rate, duration ->
                            eventHandler[0](id, type, currentTime, rate, duration)
                        },
                    ),
                    "AndroidWatch",
                )
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
        modifier = modifier,
    )
}

private class WatchJsBridge(
    private val videoId: () -> String,
    private val onEvent: (videoId: String, type: String, currentTime: Double, rate: Double, duration: Double?) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun postEvent(json: String) {
        main.post {
            val obj = runCatching { JSONObject(json) }.getOrNull() ?: return@post
            val duration = obj.optDouble("duration", Double.NaN)
            onEvent(
                videoId(),
                obj.optString("type"),
                obj.optDouble("currentTime", 0.0),
                obj.optDouble("rate", 1.0),
                if (duration.isFinite() && duration > 0) duration else null,
            )
        }
    }
}
