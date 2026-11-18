package app.waypoint.client

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  private var currentWebView: WebView? = null
  private var lastImeHeightDp = -1

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
      val navBarInsets = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
      val imeBottomPx = (imeInsets.bottom - navBarInsets.bottom).coerceAtLeast(0)
      val density = resources.displayMetrics.density
      val imeHeightDp = if (imeBottomPx > 0) (imeBottomPx / density).roundToInt() else 0

      if (imeHeightDp != lastImeHeightDp) {
        lastImeHeightDp = imeHeightDp
        currentWebView?.post {
          val js = """
            (function() {
              var h = $imeHeightDp;
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
          currentWebView?.evaluateJavascript(js, null)
        }
      }
      insets
    }
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
  }
}
