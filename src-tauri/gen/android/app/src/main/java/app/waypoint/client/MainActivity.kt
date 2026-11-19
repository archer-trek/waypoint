package app.waypoint.client

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var currentWebView: WebView? = null
  private var lastImeVisible = false
  private var lastImeBottomPx = -1

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

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
