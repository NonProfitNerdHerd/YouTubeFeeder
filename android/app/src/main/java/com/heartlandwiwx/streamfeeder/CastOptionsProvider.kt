package com.heartlandwiwx.streamfeeder

import android.content.Context
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider

/**
 * Cast options for YouTube Chromecast playback.
 * Receiver ID is the public sample receiver from android-youtube-player
 * (hosts a YouTube iframe on the Cast device).
 */
class CastOptionsProvider : OptionsProvider {
    override fun getCastOptions(context: Context): CastOptions {
        return CastOptions.Builder()
            .setReceiverApplicationId(RECEIVER_APP_ID)
            .build()
    }

    override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null

    companion object {
        const val RECEIVER_APP_ID = "C5CBE8CA"
    }
}
