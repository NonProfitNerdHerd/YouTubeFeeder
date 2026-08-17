package com.heartlandwiwx.streamfeeder.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore("streamfeeder")

class SessionStore(private val context: Context) {
    private val tokenKey = stringPreferencesKey("session_token")
    private val themeKey = stringPreferencesKey("app_theme")

    val tokenFlow: Flow<String?> = context.dataStore.data.map { it[tokenKey] }
    val themeFlow: Flow<AppTheme?> = context.dataStore.data.map { AppTheme.fromStorage(it[themeKey]) }

    suspend fun saveToken(token: String) {
        context.dataStore.edit { it[tokenKey] = token }
    }

    suspend fun saveTheme(theme: AppTheme) {
        context.dataStore.edit { it[themeKey] = theme.storage }
    }

    suspend fun clear() {
        context.dataStore.edit { it.remove(tokenKey) }
    }
}
