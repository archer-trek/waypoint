package app.waypoint.client

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WaypointShellSupportTest {
  @Test
  fun systemBarContrastMapsAppearanceAndColors() {
    assertTrue(SystemBarContrast.isLightSystemBars("light", systemIsNightMode = true))
    assertFalse(SystemBarContrast.isLightSystemBars("dark", systemIsNightMode = false))
    assertTrue(SystemBarContrast.isLightSystemBars("system", systemIsNightMode = false))
    assertFalse(SystemBarContrast.isLightSystemBars("system", systemIsNightMode = true))

    assertEquals(0xFFFFFFFF.toInt(), SystemBarContrast.windowBackgroundColorInt("light", true))
    assertEquals(0xFF09090B.toInt(), SystemBarContrast.windowBackgroundColorInt("dark", false))
  }

  @Test
  fun systemBackStateControlsInterceptAndFallback() {
    val state = SystemBackState()
    assertFalse(state.shouldInterceptBack())

    state.setCanHandleInApp(true)
    assertTrue(state.shouldInterceptBack())

    assertFalse(state.shouldFallbackToSystemAfterJsResult("true"))
    assertTrue(state.shouldFallbackToSystemAfterJsResult("false"))
    assertTrue(state.shouldFallbackToSystemAfterJsResult("null"))
    assertTrue(state.shouldFallbackToSystemAfterJsResult(null))

    state.setCanHandleInApp(false)
    assertFalse(state.shouldInterceptBack())
  }

  @Test
  fun mediaViewerSupportBuildsAuthorityCandidatesAndCleansExpiredCache() {
    assertEquals(
      "app.waypoint.client.fileprovider",
      MediaViewerSupport.fileProviderAuthority("app.waypoint.client"),
    )
    assertEquals(
      listOf("application/pdf", "*/*"),
      MediaViewerSupport.candidateMimeTypes("Application/PDF; charset=utf-8"),
    )
    assertEquals(
      listOf("application/octet-stream", "*/*"),
      MediaViewerSupport.candidateMimeTypes("  "),
    )
    assertEquals(
      listOf("*/*"),
      MediaViewerSupport.candidateMimeTypes("*/*"),
    )

    val tempRoot = Files.createTempDirectory("waypoint-media-test").toFile()
    try {
      val mediaDir = MediaViewerSupport.mediaCacheDir(tempRoot).apply { mkdirs() }
      val staleBatch = File(mediaDir, "100-1").apply { mkdirs() }
      val staleFile = File(staleBatch, "old.pdf").apply { writeText("old") }
      val freshBatch = File(mediaDir, "200-2").apply { mkdirs() }
      val freshFile = File(freshBatch, "new.png").apply { writeText("new") }

      val nowMs = 1_000_000_000L
      staleBatch.setLastModified(nowMs - MediaViewerSupport.MEDIA_CACHE_TTL_MS - 1_000L)
      staleFile.setLastModified(nowMs - MediaViewerSupport.MEDIA_CACHE_TTL_MS - 1_000L)
      freshBatch.setLastModified(nowMs - 1_000L)

      val removed = MediaViewerSupport.cleanupExpiredEntries(mediaDir, nowMs = nowMs)
      assertEquals(1, removed)
      assertFalse(staleBatch.exists())
      assertTrue(freshFile.exists())
    } finally {
      tempRoot.deleteRecursively()
    }
  }
}
