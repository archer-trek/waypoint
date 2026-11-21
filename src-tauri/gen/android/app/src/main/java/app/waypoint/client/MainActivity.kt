package app.waypoint.client

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

class MainActivity : TauriActivity() {
  private var currentWebView: WebView? = null
  private var lastImeVisible = false
  private var lastImeBottomPx = -1
  private var lastSyncedAppearance: String? = null
  private lateinit var systemBackCallback: OnBackPressedCallback

  private inner class WaypointAndroidBridge {
    @JavascriptInterface
    fun setSystemBackEnabled(enabled: Boolean) {
      runOnUiThread {
        if (::systemBackCallback.isInitialized) {
          systemBackCallback.isEnabled = enabled
        }
      }
    }

    @JavascriptInterface
    fun setSystemAppearance(appearance: String?) {
      this@MainActivity.setSystemAppearance(appearance ?: "system")
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    systemBackCallback = object : OnBackPressedCallback(false) {
      override fun handleOnBackPressed() {
        val webView = currentWebView
        if (webView == null) {
          fallbackToSystemBack()
          return
        }
        webView.evaluateJavascript(
          "(function() { return typeof window.__waypointHandleSystemBack === 'function' ? Boolean(window.__waypointHandleSystemBack()) : false; })()",
        ) { rawResult ->
          if (SystemBackSupport.shouldFallbackToSystemAfterJsResult(rawResult)) {
            fallbackToSystemBack()
          }
        }
      }
    }
    onBackPressedDispatcher.addCallback(this, systemBackCallback)

    Thread {
      MediaViewerSupport.cleanupExpiredEntries(MediaViewerSupport.mediaCacheDir(cacheDir))
    }.start()

    // Publish from the decor view only. A listener on the WebView replaces
    // Chromium's constructor listener on API 28-30, and View.onApplyWindowInsets
    // does not forward to it, so env(safe-area-inset-*) would stop updating.
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      publishImeInset(insets)
      insets
    }
    ViewCompat.setWindowInsetsAnimationCallback(
      window.decorView,
      object : WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
        override fun onProgress(
          insets: WindowInsetsCompat,
          runningAnimations: MutableList<WindowInsetsAnimationCompat>,
        ): WindowInsetsCompat = insets

        override fun onEnd(animation: WindowInsetsAnimationCompat) {
          ViewCompat.requestApplyInsets(window.decorView)
        }
      },
    )
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    currentWebView = webView
    webView.addJavascriptInterface(WaypointAndroidBridge(), "WaypointAndroid")
    webView.overScrollMode = View.OVER_SCROLL_NEVER
    webView.isVerticalScrollBarEnabled = false
    webView.isHorizontalScrollBarEnabled = false
    webView.setOnScrollChangeListener { v, scrollX, scrollY, _, _ ->
      if (scrollX != 0 || scrollY != 0) {
        v.scrollTo(0, 0)
      }
    }
    ViewCompat.requestApplyInsets(window.decorView)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    lastSyncedAppearance?.let { applySystemAppearanceOnUiThread(it, newConfig.uiMode) }
  }

  fun setSystemAppearance(appearance: String) {
    lastSyncedAppearance = appearance
    runOnUiThread {
      applySystemAppearanceOnUiThread(appearance, resources.configuration.uiMode)
    }
  }

  fun getMediaCacheDirPath(): String {
    val dir = MediaViewerSupport.mediaCacheDir(cacheDir)
    if (!dir.exists()) {
      dir.mkdirs()
    }
    return dir.absolutePath
  }

  fun openMediaFile(filePath: String, mimeType: String?): String? {
    val outcome = openMediaFileResult(filePath, mimeType)
    return outcome.toBridgeResult()
  }

  private fun openMediaFileResult(filePath: String, mimeType: String?): MediaOpenResult {
    return try {
      val file = File(filePath)
      val uri = FileProvider.getUriForFile(
        this,
        MediaViewerSupport.fileProviderAuthority(packageName),
        file,
      )
      for (candidateMime in MediaViewerSupport.candidateMimeTypes(mimeType)) {
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, candidateMime)
          clipData = ClipData.newRawUri("", uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
          startActivity(intent)
          return MediaOpenResult.Opened
        } catch (_: ActivityNotFoundException) {
          // Try next MIME candidate (e.g. generic "*/*") before failing.
        }
      }
      MediaOpenResult.NoViewerApp
    } catch (ex: Exception) {
      MediaOpenResult.Failed(ex.message ?: "Unable to open media file")
    }
  }

  private fun fallbackToSystemBack() {
    if (::systemBackCallback.isInitialized) {
      systemBackCallback.isEnabled = false
    }
    onBackPressedDispatcher.onBackPressed()
  }

  private fun applySystemAppearanceOnUiThread(appearance: String, uiMode: Int) {
    val nightMask = uiMode and Configuration.UI_MODE_NIGHT_MASK
    val systemIsNightMode = nightMask == Configuration.UI_MODE_NIGHT_YES
    val useLightBars = SystemBarContrast.isLightSystemBars(appearance, systemIsNightMode)
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = useLightBars
    controller.isAppearanceLightNavigationBars = useLightBars
    window.setBackgroundDrawable(
      ColorDrawable(SystemBarContrast.windowBackgroundColorInt(appearance, systemIsNightMode)),
    )
  }

  private fun publishImeInset(insets: WindowInsetsCompat) {
    val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
    val imeBottomPx = if (imeVisible) {
      val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
      val navBarInsets = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
      (imeInsets.bottom - navBarInsets.bottom).coerceAtLeast(0)
    } else {
      0
    }
    val webView = currentWebView ?: return
    if (imeVisible == lastImeVisible && imeBottomPx == lastImeBottomPx) {
      return
    }
    lastImeVisible = imeVisible
    lastImeBottomPx = imeBottomPx
    webView.post {
      // physical px / devicePixelRatio is the same CSS-pixel height visualViewport uses.
      // A hidden IME publishes 0 even when a leftover inset height is still attached.
      val js = """
        (function() {
          var physical = $imeBottomPx;
          var dpr = window.devicePixelRatio || 1;
          var h = physical > 0 ? Math.round(physical / dpr) : 0;
          window.dispatchEvent(new CustomEvent('waypoint:keyboard-inset', { detail: { bottom: h } }));
          if (document && document.documentElement) {
            if (h > 0) {
              document.documentElement.style.setProperty('--keyboard-inset', h + 'px');
            } else {
              document.documentElement.style.removeProperty('--keyboard-inset');
            }
          }
        })();
      """.trimIndent()
      webView.evaluateJavascript(js, null)
    }
  }
}
