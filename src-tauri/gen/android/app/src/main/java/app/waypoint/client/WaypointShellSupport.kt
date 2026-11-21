package app.waypoint.client

import java.io.File

internal object SystemBarContrast {
  const val COLOR_LIGHT_BG = 0xFFFFFFFF.toInt()
  const val COLOR_DARK_BG = 0xFF09090B.toInt()

  fun isLightSystemBars(appearance: String?, systemIsNightMode: Boolean = false): Boolean {
    return when (appearance?.trim()?.lowercase()) {
      "light" -> true
      "dark" -> false
      else -> !systemIsNightMode
    }
  }

  fun windowBackgroundColorInt(appearance: String?, systemIsNightMode: Boolean = false): Int {
    return if (isLightSystemBars(appearance, systemIsNightMode)) {
      COLOR_LIGHT_BG
    } else {
      COLOR_DARK_BG
    }
  }
}

internal class SystemBackState {
  @Volatile
  var canHandleInApp: Boolean = false
    private set

  fun setCanHandleInApp(enabled: Boolean) {
    canHandleInApp = enabled
  }

  fun shouldInterceptBack(): Boolean = canHandleInApp

  fun shouldFallbackToSystemAfterJsResult(rawResult: String?): Boolean {
    return rawResult?.trim() != "true"
  }
}

internal object MediaViewerSupport {
  const val MEDIA_CACHE_SUBDIR = "waypoint-media"
  const val MEDIA_CACHE_TTL_MS = 24L * 60L * 60L * 1000L
  const val NO_VIEWER_ERROR_CODE = "NO_VIEWER_APP"

  fun mediaCacheDir(cacheDir: File): File = File(cacheDir, MEDIA_CACHE_SUBDIR)

  fun fileProviderAuthority(packageName: String): String = "$packageName.fileprovider"

  fun normalizeMimeType(rawMimeType: String?): String {
    val essence = rawMimeType
      ?.substringBefore(';')
      ?.trim()
      ?.lowercase()
      .orEmpty()
    return if (essence.isNotEmpty() && essence.contains('/')) {
      essence
    } else {
      "application/octet-stream"
    }
  }

  fun candidateMimeTypes(rawMimeType: String?): List<String> {
    val normalized = normalizeMimeType(rawMimeType)
    return if (normalized == "*/*") {
      listOf("*/*")
    } else {
      listOf(normalized, "*/*")
    }
  }

  fun cleanupExpiredEntries(
    cacheDir: File,
    nowMs: Long = System.currentTimeMillis(),
    maxAgeMs: Long = MEDIA_CACHE_TTL_MS,
  ): Int {
    if (!cacheDir.exists() || !cacheDir.isDirectory) {
      return 0
    }
    var removed = 0
    val entries = cacheDir.listFiles() ?: return 0
    for (entry in entries) {
      val ageMs = nowMs - entry.lastModified()
      if (ageMs >= maxAgeMs && entry.deleteRecursively()) {
        removed += 1
      }
    }
    return removed
  }
}
