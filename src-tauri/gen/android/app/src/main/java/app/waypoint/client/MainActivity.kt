package app.waypoint.client

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : TauriActivity() {
  private var currentWebView: WebView? = null
  private var lastImeVisible = false
  private var lastImeBottomPx = -1
  private var lastSyncedAppearance: String? = null
  private lateinit var systemBackCallback: OnBackPressedCallback
  private lateinit var takePictureLauncher: ActivityResultLauncher<Uri>
  private lateinit var pickSingleImageLauncher: ActivityResultLauncher<PickVisualMediaRequest>
  private lateinit var pickMultipleImagesLauncher: ActivityResultLauncher<PickVisualMediaRequest>
  private lateinit var openSingleDocumentLauncher: ActivityResultLauncher<Array<String>>
  private lateinit var openMultipleDocumentsLauncher: ActivityResultLauncher<Array<String>>
  private var pendingFilePathCallback: ValueCallback<Array<Uri?>?>? = null
  private var pendingCameraOutputUri: Uri? = null
  private var pendingCameraTempFile: File? = null

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

  private inner class WaypointWebChromeClient(
    private val delegate: WebChromeClient?,
  ) : WebChromeClient() {
    override fun onShowCustomView(view: View, callback: CustomViewCallback) {
      if (delegate != null) {
        delegate.onShowCustomView(view, callback)
      } else {
        super.onShowCustomView(view, callback)
      }
    }

    override fun onHideCustomView() {
      if (delegate != null) {
        delegate.onHideCustomView()
      } else {
        super.onHideCustomView()
      }
    }

    override fun onPermissionRequest(request: PermissionRequest) {
      if (delegate != null) {
        delegate.onPermissionRequest(request)
      } else {
        super.onPermissionRequest(request)
      }
    }

    override fun getDefaultVideoPoster(): Bitmap? {
      return delegate?.defaultVideoPoster ?: super.getDefaultVideoPoster()
    }

    override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
      return delegate?.onJsAlert(view, url, message, result)
        ?: super.onJsAlert(view, url, message, result)
    }

    override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
      return delegate?.onJsConfirm(view, url, message, result)
        ?: super.onJsConfirm(view, url, message, result)
    }

    override fun onJsPrompt(
      view: WebView,
      url: String,
      message: String,
      defaultValue: String,
      result: JsPromptResult,
    ): Boolean {
      return delegate?.onJsPrompt(view, url, message, defaultValue, result)
        ?: super.onJsPrompt(view, url, message, defaultValue, result)
    }

    override fun onGeolocationPermissionsShowPrompt(
      origin: String,
      callback: GeolocationPermissions.Callback,
    ) {
      if (delegate != null) {
        delegate.onGeolocationPermissionsShowPrompt(origin, callback)
      } else {
        super.onGeolocationPermissionsShowPrompt(origin, callback)
      }
    }

    override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
      return delegate?.onConsoleMessage(consoleMessage)
        ?: super.onConsoleMessage(consoleMessage)
    }

    override fun onReceivedTitle(view: WebView, title: String) {
      if (delegate != null) {
        delegate.onReceivedTitle(view, title)
      } else {
        super.onReceivedTitle(view, title)
      }
    }

    override fun onShowFileChooser(
      webView: WebView,
      filePathCallback: ValueCallback<Array<Uri?>?>,
      fileChooserParams: FileChooserParams,
    ): Boolean {
      return handleShowFileChooser(webView, filePathCallback, fileChooserParams, delegate)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    takePictureLauncher = registerForActivityResult(
      ActivityResultContracts.TakePicture(),
    ) { success ->
      val uri = pendingCameraOutputUri
      val tempFile = pendingCameraTempFile
      pendingCameraOutputUri = null
      pendingCameraTempFile = null
      if (success && uri != null) {
        completePendingFileChooser(arrayOf(uri))
      } else {
        tempFile?.delete()
        completePendingFileChooser(null)
      }
    }

    pickSingleImageLauncher = registerForActivityResult(
      ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
      completePendingFileChooser(uri?.let { arrayOf(it) })
    }

    pickMultipleImagesLauncher = registerForActivityResult(
      ActivityResultContracts.PickMultipleVisualMedia(),
    ) { uris ->
      completePendingFileChooser(if (uris.isNotEmpty()) uris.toTypedArray() else null)
    }

    openSingleDocumentLauncher = registerForActivityResult(
      ActivityResultContracts.OpenDocument(),
    ) { uri ->
      completePendingFileChooser(uri?.let { arrayOf(it) })
    }

    openMultipleDocumentsLauncher = registerForActivityResult(
      ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
      completePendingFileChooser(if (uris.isNotEmpty()) uris.toTypedArray() else null)
    }

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
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val existingClient = webView.webChromeClient
      if (existingClient !is WaypointWebChromeClient) {
        webView.webChromeClient = WaypointWebChromeClient(existingClient)
      }
    }
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

  private fun completePendingFileChooser(uris: Array<Uri?>?) {
    val callback = pendingFilePathCallback
    pendingFilePathCallback = null
    callback?.onReceiveValue(uris)
  }

  private fun createCameraOutputFile(): File {
    val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
    val storageDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES) ?: cacheDir
    if (!storageDir.exists()) {
      storageDir.mkdirs()
    }
    return File.createTempFile("JPEG_${timeStamp}_", ".jpg", storageDir)
  }

  private fun handleShowFileChooser(
    webView: WebView,
    filePathCallback: ValueCallback<Array<Uri?>?>,
    fileChooserParams: WebChromeClient.FileChooserParams,
    delegate: WebChromeClient?,
  ): Boolean {
    pendingFilePathCallback?.onReceiveValue(null)
    pendingFilePathCallback = filePathCallback
    pendingCameraOutputUri = null
    pendingCameraTempFile = null

    val allowMultiple = fileChooserParams.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
    return when (
      FileChooserSupport.classify(
        fileChooserParams.acceptTypes,
        fileChooserParams.isCaptureEnabled,
      )
    ) {
      FileChooserKind.CAMERA_PHOTO -> {
        val captureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        if (captureIntent.resolveActivity(packageManager) == null) {
          pendingFilePathCallback = null
          return delegate?.onShowFileChooser(webView, filePathCallback, fileChooserParams)
            ?: run {
              filePathCallback.onReceiveValue(null)
              true
            }
        }
        try {
          val photoFile = createCameraOutputFile()
          val uri = FileProvider.getUriForFile(
            this,
            MediaViewerSupport.fileProviderAuthority(packageName),
            photoFile,
          )
          pendingCameraTempFile = photoFile
          pendingCameraOutputUri = uri
          takePictureLauncher.launch(uri)
          true
        } catch (_: Exception) {
          pendingCameraTempFile?.delete()
          pendingCameraTempFile = null
          pendingCameraOutputUri = null
          pendingFilePathCallback = null
          delegate?.onShowFileChooser(webView, filePathCallback, fileChooserParams)
            ?: run {
              filePathCallback.onReceiveValue(null)
              true
            }
        }
      }
      FileChooserKind.GALLERY_IMAGES -> {
        val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
        try {
          if (allowMultiple) {
            pickMultipleImagesLauncher.launch(request)
          } else {
            pickSingleImageLauncher.launch(request)
          }
          true
        } catch (_: Exception) {
          pendingFilePathCallback = null
          delegate?.onShowFileChooser(webView, filePathCallback, fileChooserParams)
            ?: run {
              filePathCallback.onReceiveValue(null)
              true
            }
        }
      }
      FileChooserKind.DOCUMENT_FILES -> {
        try {
          if (allowMultiple) {
            openMultipleDocumentsLauncher.launch(arrayOf("*/*"))
          } else {
            openSingleDocumentLauncher.launch(arrayOf("*/*"))
          }
          true
        } catch (_: ActivityNotFoundException) {
          pendingFilePathCallback = null
          delegate?.onShowFileChooser(webView, filePathCallback, fileChooserParams)
            ?: run {
              filePathCallback.onReceiveValue(null)
              true
            }
        }
      }
    }
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
