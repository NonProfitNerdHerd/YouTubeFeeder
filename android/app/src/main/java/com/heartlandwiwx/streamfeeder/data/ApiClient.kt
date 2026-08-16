package com.heartlandwiwx.streamfeeder.data

import com.heartlandwiwx.streamfeeder.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ApiClient(
    private val tokenProvider: () -> String?,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val base = BuildConfig.API_BASE.trimEnd('/')

    suspend fun me(): CurrentUser = withContext(Dispatchers.IO) {
        val obj = getJson("/api/me")
        CurrentUser(
            id = obj.getString("id"),
            displayName = obj.optString("displayName", "User"),
            connected = obj.optBoolean("connected", false),
        )
    }

    suspend fun inbox(
        view: String = "inbox",
        categoryId: String? = null,
        watchlistId: String? = null,
        channelId: String? = null,
    ): List<InboxItem> = withContext(Dispatchers.IO) {
        val q = buildString {
            append("view=").append(view)
            if (!categoryId.isNullOrBlank()) append("&categoryId=").append(categoryId)
            if (!watchlistId.isNullOrBlank()) append("&watchlistId=").append(watchlistId)
            if (!channelId.isNullOrBlank()) append("&channelId=").append(channelId)
        }
        val arr = getJson("/api/inbox?$q").optJSONArray("items") ?: JSONArray()
        (0 until arr.length()).map { parseInboxItem(arr.getJSONObject(it)) }
    }

    suspend fun channels(): List<ChannelRecord> = withContext(Dispatchers.IO) {
        val arr = getJson("/api/channels").optJSONArray("channels") ?: JSONArray()
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            ChannelRecord(
                channelId = o.getString("channelId"),
                title = o.optString("title", "Channel"),
                thumbnailUrl = o.optString("thumbnailUrl", ""),
            )
        }
    }

    suspend fun categories(): List<CategoryRecord> = withContext(Dispatchers.IO) {
        val arr = getJson("/api/categories").optJSONArray("categories") ?: JSONArray()
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            CategoryRecord(o.getString("id"), o.getString("name"))
        }
    }

    suspend fun watchlists(): List<WatchlistRecord> = withContext(Dispatchers.IO) {
        val arr = getJson("/api/watchlists").optJSONArray("watchlists") ?: JSONArray()
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            WatchlistRecord(o.getString("id"), o.getString("name"), o.optInt("videoCount", 0))
        }
    }

    suspend fun patchInbox(videoId: String, body: JSONObject) = withContext(Dispatchers.IO) {
        requestJson("PATCH", "/api/inbox/$videoId", body)
        Unit
    }

    suspend fun addToWatchlist(listId: String, videoId: String) = withContext(Dispatchers.IO) {
        requestJson("POST", "/api/watchlists/$listId/items", JSONObject().put("videoId", videoId))
        Unit
    }

    suspend fun logout() = withContext(Dispatchers.IO) {
        try {
            requestJson("POST", "/api/auth/logout", JSONObject())
        } catch (_: Exception) {
            // Local clear still happens in the ViewModel.
        }
    }

    fun loginUrl(): String = "$base/api/auth/google?intent=login&client=android"

    private fun parseInboxItem(o: JSONObject) = InboxItem(
        videoId = o.getString("videoId"),
        channelId = o.optString("channelId", ""),
        channelTitle = o.optString("channelTitle", ""),
        title = o.optString("title", "(untitled)"),
        descriptionExcerpt = o.optString("descriptionExcerpt", ""),
        thumbnailUrl = o.optString("thumbnailUrl", ""),
        publishedAt = optionalString(o, "publishedAt"),
        embeddable = o.optBoolean("embeddable", true),
        unread = o.optBoolean("unread", false),
        hidden = o.optBoolean("hidden", false),
        snoozedUntil = optionalString(o, "snoozedUntil"),
        notes = o.optString("notes", ""),
    )

    private fun optionalString(o: JSONObject, key: String): String? {
        if (!o.has(key) || o.isNull(key)) return null
        val value = o.optString(key, "")
        return value.ifBlank { null }
    }

    private fun getJson(path: String): JSONObject = requestJson("GET", path, null)

    private fun requestJson(method: String, path: String, body: JSONObject?): JSONObject {
        val builder = Request.Builder().url("$base$path")
        val token = tokenProvider()
        if (!token.isNullOrBlank()) {
            builder.header("Authorization", "Bearer $token")
        }
        when (method) {
            "GET" -> builder.get()
            "POST" -> builder.post((body ?: JSONObject()).toString().toRequestBody(jsonMedia))
            "PATCH" -> builder.patch((body ?: JSONObject()).toString().toRequestBody(jsonMedia))
            "DELETE" -> builder.delete()
            else -> error("Unsupported method $method")
        }
        client.newCall(builder.build()).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                val message = runCatching {
                    JSONObject(text).getJSONObject("error").optString("message", text)
                }.getOrDefault(text.ifBlank { "HTTP ${res.code}" })
                throw ApiException(res.code, message)
            }
            if (text.isBlank()) return JSONObject()
            return JSONObject(text)
        }
    }
}
