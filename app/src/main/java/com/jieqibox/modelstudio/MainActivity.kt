package com.jieqibox.modelstudio

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
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
import androidx.documentfile.provider.DocumentFile
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
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
    /** 选截图文件夹用的请求码（SAF 目录授权） */
    private val folderPickRequest = 1002

    private val prefs: SharedPreferences by lazy {
        getSharedPreferences("model-studio", MODE_PRIVATE)
    }

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
        webView.addJavascriptInterface(ShotFolderBridge(), "ShotFolder")

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
        if (requestCode == folderPickRequest) {
            val uri = data?.data
            if (resultCode == RESULT_OK && uri != null) {
                // 取持久读权限 —— 不取的话重启后就失效了
                try {
                    contentResolver.takePersistableUriPermission(
                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (e: Exception) {
                    android.util.Log.w(TAG, "takePersistableUriPermission failed", e)
                }
                val name = folderDisplayName(uri)
                prefs.edit()
                    .putString(PREF_SHOT_FOLDER_URI, uri.toString())
                    .putString(PREF_SHOT_FOLDER_NAME, name)
                    .apply()
                val safe = name.replace("'", " ")
                callJs("window.onShotFolderPicked && " +
                    "window.onShotFolderPicked(true, '$safe', '')")
            } else {
                callJs("window.onShotFolderPicked && " +
                    "window.onShotFolderPicked(false, '', '已取消')")
            }
            return
        }
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
            webView.removeJavascriptInterface("ShotFolder")
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

    /* ------------------------------------------------------------------ */
    /* 截图文件夹                                                          */
    /*                                                                     */
    /* 用 SAF 的目录授权而不是读媒体库权限：用户自己指定哪个文件夹，         */
    /* 应用不需要任何权限，也不依赖 Android 版本。授权会持久化，重启仍在。   */
    /* ------------------------------------------------------------------ */

    private fun folderDisplayName(uri: Uri): String {
        val doc = DocumentFile.fromTreeUri(this, uri)
        return doc?.name ?: uri.lastPathSegment ?: "截图文件夹"
    }

    private fun callJs(script: String) {
        webView.post { webView.evaluateJavascript(script, null) }
    }

    /** 读出目录里的全部图片，带名称/大小/修改时间，供网页端过滤与选择。 */
    private fun listFolderImages(): String {
        val uriStr = prefs.getString(PREF_SHOT_FOLDER_URI, null)
            ?: return "[]"
        val tree = DocumentFile.fromTreeUri(this, Uri.parse(uriStr))
            ?: return "[]"
        if (!tree.canRead()) return "[]"

        val arr = JSONArray()
        var count = 0
        // 按修改时间倒序：最近的截图才是要导入的
        val files = tree.listFiles()
            .filter { it.isFile && (it.type?.startsWith("image/") == true) }
            .sortedByDescending { it.lastModified() }

        for (f in files) {
            if (count++ >= 300) break          // 够用了，避免超大文件夹卡住
            val o = JSONObject()
            o.put("uri", f.uri.toString())
            o.put("name", f.name ?: "")
            o.put("size", f.length())
            o.put("date", f.lastModified())
            arr.put(o)
        }
        return arr.toString()
    }

    /**
     * 读一张图，压到长边 1600 并转成 JPEG，返回 base64。
     *
     * 必须压缩：直接传原图（动辄 5 MB）走 base64 要 7 MB 字符串，
     * 跨 JS 桥传这么大会卡住主线程。压完通常在 300 KB 上下。
     */
    private fun readFolderImage(uriStr: String): String {
        try {
            val uri = Uri.parse(uriStr)

            // 先只读尺寸，算出采样率 —— 直接整图解码遇到大截图会 OOM
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            contentResolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, bounds)
            }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return ""

            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_EDGE * 2) {
                sample *= 2
            }

            val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sample }
            val src = contentResolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, decodeOpts)
            } ?: return ""

            val longEdge = maxOf(src.width, src.height)
            val scaled: Bitmap = if (longEdge > MAX_EDGE) {
                val ratio = MAX_EDGE.toFloat() / longEdge.toFloat()
                Bitmap.createScaledBitmap(
                    src,
                    (src.width * ratio).toInt().coerceAtLeast(1),
                    (src.height * ratio).toInt().coerceAtLeast(1),
                    true
                )
            } else {
                src
            }

            val bos = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 88, bos)
            if (scaled !== src) scaled.recycle()
            src.recycle()
            return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            android.util.Log.e(TAG, "readFolderImage failed", e)
            return ""
        } catch (e: OutOfMemoryError) {
            android.util.Log.e(TAG, "readFolderImage OOM", e)
            return ""
        }
    }

    /** 暴露给网页：window.ShotFolder */
    inner class ShotFolderBridge {
        @JavascriptInterface
        fun hasFolder(): Boolean =
            prefs.getString(PREF_SHOT_FOLDER_URI, null) != null

        @JavascriptInterface
        fun folderName(): String =
            prefs.getString(PREF_SHOT_FOLDER_NAME, "") ?: ""

        @JavascriptInterface
        fun pickFolder() {
            runOnUiThread {
                try {
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                        addFlags(
                            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        )
                    }
                    @Suppress("DEPRECATION")
                    startActivityForResult(intent, folderPickRequest)
                } catch (e: Exception) {
                    callJs("window.onShotFolderPicked && " +
                        "window.onShotFolderPicked(false, '', '无法打开选择器')")
                }
            }
        }

        @JavascriptInterface
        fun listImages(): String = listFolderImages()

        @JavascriptInterface
        fun readImage(uri: String): String = readFolderImage(uri)
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
        private const val TAG = "ModelStudio"

        /** 截图导入时的长边上限，与网页端 MAX_EDGE 保持一致 */
        private const val MAX_EDGE = 1600

        private const val PREF_SHOT_FOLDER_URI = "shotFolderUri"
        private const val PREF_SHOT_FOLDER_NAME = "shotFolderName"

        private const val PAGE_URL =
            "https://appassets.androidplatform.net/assets/www/index.html"
    }
}
