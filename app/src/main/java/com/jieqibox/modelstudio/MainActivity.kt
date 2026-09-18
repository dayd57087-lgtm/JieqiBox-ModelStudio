package com.jieqibox.modelstudio

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.FileOutputStream

/**
 * 模型工坊：采集 · 标注 · 训练。
 *
 * 这一层刻意保持很薄 —— 只做 WebView 装不下的事：
 *   1. 把 assets/www 以 https 源提供出去（file:// 下 localStorage / fetch / WebGL 都不可靠）
 *   2. 系统文件选择器（导入对局截图，走 SAF，不需要任何存储权限）
 *   3. 把训练好的模型写进「下载/模型工坊」
 *
 * 标注与训练的全部逻辑都在 WebView 里，见 assets/www/studio.js。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader

    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserRequest = 1001

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this)
        webView.setBackgroundColor(0xFF14161A.toInt())
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            // 训练要跑很久，别让缩放/字体影响画布尺寸
            setSupportZoom(false)
            builtInZoomControls = false
            textZoom = 100
        }
        webView.isVerticalScrollBarEnabled = false
        webView.addJavascriptInterface(Bridge(), "StudioNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                if (request.url.host == "appassets.androidplatform.net") return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    true
                } catch (e: Exception) {
                    true
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback

                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "image/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                return try {
                    startActivityForResult(
                        Intent.createChooser(intent, "选择对局截图"),
                        fileChooserRequest
                    )
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    false
                }
            }
        }

        webView.loadUrl(PAGE_URL)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == fileChooserRequest) {
            val cb = filePathCallback
            filePathCallback = null
            if (cb == null) return

            var result: Array<Uri>? = null
            if (resultCode == RESULT_OK && data != null) {
                val picked = mutableListOf<Uri>()
                data.clipData?.let { clip ->
                    for (i in 0 until clip.itemCount) picked.add(clip.getItemAt(i).uri)
                }
                if (picked.isEmpty()) {
                    data.data?.let { picked.add(it) }
                }
                if (picked.isNotEmpty()) result = picked.toTypedArray()
            }
            cb.onReceiveValue(result)
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        webView.evaluateJavascript("window.onAndroidBack ? window.onAndroidBack() : false") { value ->
            if (value != "true") finish()
        }
    }

    override fun onDestroy() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("StudioNative")
            webView.destroy()
        }
        super.onDestroy()
    }

    /** 暴露给网页的原生能力，通过 window.StudioNative 调用。 */
    inner class Bridge {

        @JavascriptInterface
        fun isNative(): Boolean = true

        @JavascriptInterface
        fun appVersion(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun platform(): String = "android-${Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"}"

        /** 训练期间不让屏幕熄灭。 */
        @JavascriptInterface
        fun keepAwake(on: Boolean) {
            runOnUiThread {
                if (on) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        @JavascriptInterface
        fun toast(message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }
        }

        /**
         * 把模型权重写进「下载/模型工坊」。
         * 大文件走 base64 是够的：这里最大也就几百 KB。
         */
        @JavascriptInterface
        fun saveFile(name: String, base64: String): String {
            return try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                saveToDownloads(sanitise(name), bytes)
            } catch (e: Exception) {
                "ERROR: ${e.message}"
            }
        }

        /** 供 WebView 内下载引擎判断模型体积，避免误报。 */
        @JavascriptInterface
        fun supportedAbis(): String = Build.SUPPORTED_ABIS.joinToString(",")
    }

    private fun sanitise(name: String): String {
        val cleaned = name.replace(Regex("[^A-Za-z0-9._\\-\\u4e00-\\u9fa5]"), "_")
        return if (cleaned.isBlank()) "model.bin" else cleaned
    }

    private fun mimeOf(name: String): String = when {
        name.endsWith(".json") -> "application/json"
        name.endsWith(".bin") -> "application/octet-stream"
        name.endsWith(".onnx") -> "application/octet-stream"
        name.endsWith(".tflite") -> "application/octet-stream"
        else -> "application/octet-stream"
    }

    private fun saveToDownloads(name: String, bytes: ByteArray): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(name))
                put(
                    MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/模型工坊"
                )
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return "ERROR: 无法在下载目录创建文件"
            try {
                resolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: return "ERROR: 无法写入下载目录"
            } catch (e: Exception) {
                resolver.delete(uri, null, null)
                return "ERROR: ${e.message}"
            }
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return "下载/模型工坊/$name"
        }

        val dir = File(getExternalFilesDir(null), "exports").apply { mkdirs() }
        val target = File(dir, name)
        FileOutputStream(target).use { it.write(bytes) }
        return target.absolutePath
    }

    companion object {
        private const val PAGE_URL =
            "https://appassets.androidplatform.net/assets/www/index.html"
    }
}
