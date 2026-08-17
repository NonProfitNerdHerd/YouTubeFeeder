package com.heartlandwiwx.streamfeeder.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import com.heartlandwiwx.streamfeeder.R
import com.heartlandwiwx.streamfeeder.data.AppTheme

/** App system font: Roboto (Android default) at normal weight for readable titles. */
private val SystemFont = FontFamily.Default

/** Product wordmark. */
val BrandFont = FontFamily(
    Font(R.font.merriweather_regular, FontWeight.Normal),
    Font(R.font.merriweather_bold, FontWeight.Bold),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF8AB4F8),
    onPrimary = Color(0xFF062E6F),
    background = Color(0xFF0F1115),
    surface = Color(0xFF171A21),
    onBackground = Color(0xFFE8EAED),
    onSurface = Color(0xFFE8EAED),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF1A73E8),
    background = Color(0xFFF8F9FA),
    surface = Color(0xFFFFFFFF),
    onBackground = Color(0xFF1F1F1F),
    onSurface = Color(0xFF1F1F1F),
)

/** Warm paper tones that cut blue light, similar to night-shift / sepia reading mode. */
private val SepiaColors = lightColorScheme(
    primary = Color(0xFF9A6B3F),
    onPrimary = Color(0xFFFFF6E8),
    background = Color(0xFFF3E6C9),
    surface = Color(0xFFF8EDD8),
    onBackground = Color(0xFF3B2A1A),
    onSurface = Color(0xFF3B2A1A),
    onSurfaceVariant = Color(0xFF6B5340),
)

private val BaseTypography = Typography()
private val AppTypography = BaseTypography.copy(
    displayLarge = BaseTypography.displayLarge.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    displayMedium = BaseTypography.displayMedium.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    displaySmall = BaseTypography.displaySmall.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    headlineLarge = BaseTypography.headlineLarge.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    headlineMedium = BaseTypography.headlineMedium.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    headlineSmall = BaseTypography.headlineSmall.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    titleLarge = BaseTypography.titleLarge.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    titleMedium = BaseTypography.titleMedium.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    titleSmall = BaseTypography.titleSmall.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    bodyLarge = BaseTypography.bodyLarge.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    bodyMedium = BaseTypography.bodyMedium.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    bodySmall = BaseTypography.bodySmall.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    labelLarge = BaseTypography.labelLarge.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    labelMedium = BaseTypography.labelMedium.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
    labelSmall = BaseTypography.labelSmall.copy(fontFamily = SystemFont, fontWeight = FontWeight.Normal),
)

@Composable
fun StreamFeederTheme(theme: AppTheme, content: @Composable () -> Unit) {
    val colors = when (theme) {
        AppTheme.Light -> LightColors
        AppTheme.Dark -> DarkColors
        AppTheme.Sepia -> SepiaColors
    }
    MaterialTheme(
        colorScheme = colors,
        typography = AppTypography,
        content = content,
    )
}
