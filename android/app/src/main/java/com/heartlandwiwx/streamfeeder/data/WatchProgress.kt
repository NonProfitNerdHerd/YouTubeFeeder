package com.heartlandwiwx.streamfeeder.data

const val WATCHED_SECONDS = 30.0
const val SHORT_VIDEO_MAX_SECONDS = 60.0
const val SHORT_VIDEO_FRACTION = 0.5
const val SEEK_MAX_STEP_SECONDS = 2.0
const val WALL_CLOCK_SLACK = 1.25
const val SAMPLE_INTERVAL_MS = 400L
const val PROGRESS_PERSIST_MS = 12_000L

fun meetsWatchThreshold(
    playbackSeconds: Double,
    durationSeconds: Double?,
    ended: Boolean = false,
): Boolean {
    if (ended) return true
    if (!playbackSeconds.isFinite() || playbackSeconds < 0) return false
    if (playbackSeconds >= WATCHED_SECONDS) return true
    val duration = durationSeconds
    if (duration != null && duration.isFinite() && duration > 0 && duration < SHORT_VIDEO_MAX_SECONDS) {
        return playbackSeconds >= duration * SHORT_VIDEO_FRACTION
    }
    return false
}

data class PlaybackSampleState(
    val playing: Boolean = false,
    val lastTime: Double? = null,
    val lastWall: Long? = null,
    val playbackSeconds: Double = 0.0,
)

fun createPlaybackSampler(initialSeconds: Double = 0.0) =
    PlaybackSampleState(playbackSeconds = initialSeconds.coerceAtLeast(0.0))

fun setSamplerPlaying(state: PlaybackSampleState, playing: Boolean): PlaybackSampleState =
    if (!playing) state.copy(playing = false, lastTime = null, lastWall = null)
    else state.copy(playing = true)

fun samplePlayback(
    state: PlaybackSampleState,
    currentTime: Double,
    nowMs: Long,
    playbackRate: Double = 1.0,
): PlaybackSampleState {
    if (!state.playing) return state
    if (!currentTime.isFinite()) return state
    val rate = if (playbackRate.isFinite() && playbackRate > 0) playbackRate else 1.0
    val lastTime = state.lastTime
    val lastWall = state.lastWall
    if (lastTime == null || lastWall == null) {
        return state.copy(lastTime = currentTime, lastWall = nowMs)
    }
    val dPos = currentTime - lastTime
    val dWall = ((nowMs - lastWall) / 1000.0) * rate
    val add = if (dPos > 0 && dPos <= SEEK_MAX_STEP_SECONDS) {
        maxOf(0.0, minOf(dPos, dWall * WALL_CLOCK_SLACK))
    } else {
        0.0
    }
    return state.copy(
        lastTime = currentTime,
        lastWall = nowMs,
        playbackSeconds = state.playbackSeconds + add,
    )
}

fun mergeStoredPlayback(stored: Double, local: Double): Double = maxOf(0.0, stored, local)
