package app.waypoint.client

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var currentWebView: WebView? = null
  private var lastImeHeightDp = -1

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
      val density = resources.displayMetrics.density
      val imeHeightDp = if (imeInsets.bottom > 0) (imeInsets.bottom / density).toInt() else 0

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
  }
}
