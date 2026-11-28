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

internal object SystemBackSupport {
  fun shouldFallbackToSystemAfterJsResult(rawResult: String?): Boolean {
    return rawResult?.trim() != "true"
  }
}

internal enum class FileChooserKind {
  CAMERA_PHOTO,
  GALLERY_IMAGES,
  DOCUMENT_FILES,
}

internal object FileChooserSupport {
  fun classify(acceptTypes: Array<String>?, captureEnabled: Boolean): FileChooserKind {
    val normalized = acceptTypes
      ?.map { it.trim().lowercase() }
      ?.filter { it.isNotEmpty() }
      .orEmpty()
    val hasImageAccept = normalized.any { it.startsWith("image/") }
    if (captureEnabled && hasImageAccept) {
      return FileChooserKind.CAMERA_PHOTO
    }
    if (!captureEnabled && normalized.isNotEmpty() && normalized.all { it.startsWith("image/") }) {
      return FileChooserKind.GALLERY_IMAGES
    }
    return FileChooserKind.DOCUMENT_FILES
  }
}

internal sealed interface MediaOpenResult {
  object Opened : MediaOpenResult
  object NoViewerApp : MediaOpenResult
  data class Failed(val message: String) : MediaOpenResult

  fun toBridgeResult(): String? = when (this) {
    is Opened -> null
    is NoViewerApp -> MediaViewerSupport.NO_VIEWER_ERROR_CODE
    is Failed -> message.ifBlank { "Unable to open media file" }
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
