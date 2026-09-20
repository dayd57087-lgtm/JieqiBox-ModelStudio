package com.jieqibox.modelstudio

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.SharedPreferences
import android.media.projection.MediaProjectionManager
import android.provider.Settings
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
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
    /** 请求截屏授权的请求码 */
    private val capturePermissionRequest = 1003

    private val prefs: SharedPreferences by lazy {
        getSharedPreferences("model-studio", MODE_PRIVATE)
    }

    // 截屏授权 token。Android 不允许长期保留，每次启动应用都要重新过一遍弹窗，
    // 而且只能用一次 —— 用完立即清掉。
    private var pendingProjectionResultCode = 0
    private var pendingProjectionData: Intent? = null

    /**
     * 请求截屏授权。
     *
     * 用 startActivityForResult 而不是 registerForActivityResult ——
     * 本 Activity 继承的是 android.app.Activity，而那个方法属于
     * androidx.activity.ComponentActivity，这里并没有。
     * 文件夹选择用的也是同一套老 API，保持一致。
     */
    private fun requestCapturePermission() {
        try {
            val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            @Suppress("DEPRECATION")
            startActivityForResult(mgr.createScreenCaptureIntent(), capturePermissionRequest)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to request capture permission", e)
            callJs("window.onCapturePermission && " +
                "window.onCapturePermission(false, '无法打开授权弹窗')")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        installCrashLogger()

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
        webView.addJavascriptInterface(CaptureBridge(), "Capture")

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
        if (requestCode == capturePermissionRequest) {
            if (resultCode == RESULT_OK && data != null) {
                pendingProjectionResultCode = resultCode
                pendingProjectionData = data
                callJs("window.onCapturePermission && window.onCapturePermission(true, '')")
            } else {
                pendingProjectionResultCode = 0
                pendingProjectionData = null
                callJs("window.onCapturePermission && window.onCapturePermission(false, '已取消')")
            }
            return
        }
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
            webView.removeJavascriptInterface("Capture")
            webView.destroy()
        }
        super.onDestroy()
    }

    /* ------------------------------------------------------------------ */
    /* 崩溃记录                                                            */
    /*                                                                     */
    /* 悬浮窗采集这类代码，出问题的地方常常在用户那边才有（具体机型、        */
    /* 具体时序），而应用一崩就什么都不剩了。所以自己记一份：写进应用私有    */
    /* 目录，下次打开时提示出来 —— 至少要能说出「崩在哪一行」。            */
    /* ------------------------------------------------------------------ */

    private fun installCrashLogger() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val sw = java.io.StringWriter()
                error.printStackTrace(java.io.PrintWriter(sw))
                val text = "时间: " + java.text.SimpleDateFormat(
                    "yyyy-MM-dd HH:mm:ss", java.util.Locale.US
                ).format(java.util.Date()) +
                    "\n线程: " + thread.name +
                    "\n版本: " + BuildConfig.VERSION_NAME +
                    "\n设备: " + Build.MANUFACTURER + " " + Build.MODEL +
                    " / Android " + Build.VERSION.SDK_INT +
                    "\n\n" + sw.toString()
                java.io.File(filesDir, CRASH_FILE).writeText(text)
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to write crash log", t)
            }
            // 无论如何都交回给系统，崩溃该退出的还是要退出
            previous?.uncaughtException(thread, error)
        }
    }

    private fun readCrashLog(): String = try {
        val f = java.io.File(filesDir, CRASH_FILE)
        if (f.exists()) f.readText() else ""
    } catch (t: Throwable) {
        ""
    }

    private fun clearCrashLog() {
        try { java.io.File(filesDir, CRASH_FILE).delete() } catch (t: Throwable) { /* 忽略 */ }
    }

    /** 暴露给网页：window.StudioNative */
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

        /** 上次崩溃的堆栈，没有就返回空串 */
        @JavascriptInterface
        fun lastCrash(): String = readCrashLog()

        @JavascriptInterface
        fun clearCrash() {
            clearCrashLog()
        }
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

    /* ------------------------------------------------------------------ */
    /* 悬浮窗采集                                                          */
    /*                                                                     */
    /* 判据全在原生侧（像素级），所以采集中不依赖 WebView ——                */
    /* 用户切到对局应用时它照样工作，也不占 WebView 的算力。                */
    /* ------------------------------------------------------------------ */

    /**
     * 显示悬浮窗（如果用户授权过）。
     *
     * TYPE_APPLICATION_OVERLAY 需要「显示在其他应用上层」权限，
     * 没授权就静默跳过 —— 采集本身不依赖悬浮窗，它只是状态显示。
     *
     * 返回值 = **用户有没有给权限**，不是"窗口建成了没有"。
     * 建窗口是排进主线程异步做的，这里同步拿不到结果，也不该等 ——
     * 调用方（CaptureBridge.start）真正需要知道的只有"用户有没有地方点开始"。
     *
     * 注意：这个函数可能在 JavaBridge 线程上被调用，所以它自己不许碰视图 ——
     * 碰视图的部分交给 CaptureOverlay 在主线程做。曾经这里直接 addView，
     * 导致悬浮窗的 ViewRootImpl 被认领给了 JavaBridge 线程，
     * 半秒后主线程刷一次文字就 CalledFromWrongThreadException 闪退。
     */
    private fun showCaptureOverlay(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            Log.i(TAG, "Overlay permission not granted; capture still works without it")
            return false
        }
        return try {
            if (CaptureOverlay.instance == null) {
                // 用 applicationContext：悬浮窗的存活时间比 Activity 长得多
                // （用户要切到别的应用去下棋），拿 Activity 当上下文
                // 一旦它被回收，之后每次更新窗口都会 BadTokenException
                CaptureOverlay(applicationContext).show()
            }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to show capture overlay", t)
            false
        }
    }

    private fun hideCaptureOverlay() {
        try { CaptureOverlay.instance?.hide() } catch (t: Throwable) { /* 忽略 */ }
    }

    private fun candidateDir(): java.io.File? {
        val dir = java.io.File(filesDir, CaptureService.CANDIDATE_DIR)
        if (!dir.exists() && !dir.mkdirs()) return null
        return dir
    }

    /** 候选列表：只给名字/大小/时间，图本身按需再读 —— 避免一次传几百 KB */
    private fun listCandidatesJson(): String {
        val dir = candidateDir() ?: return "[]"
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".jpg") } ?: return "[]"
        val arr = org.json.JSONArray()
        files.sortedByDescending { it.lastModified() }.forEach { f ->
            val o = org.json.JSONObject()
            o.put("name", f.name)
            o.put("size", f.length())
            o.put("date", f.lastModified())
            arr.put(o)
        }
        return arr.toString()
    }

    /**
     * 读一张候选图。
     *
     * 候选存的时候已经压到长边 1600、JPEG 90，通常在 200~500 KB。
     * base64 之后翻三分之一，一次读一张是可以接受的。
     */
    private fun readCandidateBase64(name: String): String {
        return try {
            val dir = candidateDir() ?: return ""
            // 只接受文件名，防止路径穿越
            val safe = java.io.File(name).name
            val f = java.io.File(dir, safe)
            if (!f.exists() || !f.isFile) return ""
            Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read candidate", e)
            ""
        } catch (e: OutOfMemoryError) {
            Log.w(TAG, "OOM reading candidate", e)
            ""
        }
    }

    /** 暴露给网页：window.Capture */
    inner class CaptureBridge {

        @JavascriptInterface
        fun isSupported(): Boolean = true

        @JavascriptInterface
        fun hasPermission(): Boolean = pendingProjectionData != null

        @JavascriptInterface
        fun requestPermission() {
            runOnUiThread { requestCapturePermission() }
        }

        @JavascriptInterface
        fun isCapturing(): Boolean = CaptureService.isRunning()

        /**
         * 是否已经「开拍」。
         *
         * 启动采集和开始采集是两件事：点「开始采集」只是把截屏窗口架好
         * （人还在工坊里，画面里是工坊自己），开拍由用户在对局应用里
         * 点悬浮窗上的「开始」决定。
         */
        @JavascriptInterface
        fun isArmed(): Boolean = CaptureService.instance?.isArmed() ?: false

        /**
         * 开拍 / 暂停。
         *
         * 悬浮窗上那个「开始」按钮走的是同一条路，网页端只是另一个入口 ——
         * 没给悬浮窗权限的用户靠的就是这个入口。
         */
        @JavascriptInterface
        fun setArmed(on: Boolean): Boolean {
            val svc = CaptureService.instance ?: return false
            return try {
                svc.setArmed(on)
                true
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to set armed=$on", t)
                false
            }
        }

        @JavascriptInterface
        fun capturedCount(): Int = CaptureService.instance?.captured() ?: 0

        /**
         * 开始采集。
         * @param scale        截帧缩放（省内存，0.5 足够）
         * @param intervalMs   两次采集的最短间隔
         * @param stableFrames 连续多少帧稳定才算"走子完成"
         */
        @JavascriptInterface
        fun start(scale: Double, intervalMs: Int, stableFrames: Int): Boolean {
            val data = pendingProjectionData
            if (data == null) {
                callJs("window.onCaptureState && window.onCaptureState(false, '还没有截屏授权')")
                return false
            }
            return try {
                /*
                 * 先把悬浮窗立起来，再启服务。
                 *
                 * 顺序很重要：悬浮窗是用户「点开始」的地方，服务一起来就得知道
                 * 有没有这个入口。没给悬浮窗权限的话，用户没地方点开始，
                 * 只能由上层直接把 armed 置上，否则功能看起来就是坏的。
                 */
                val overlayOk = showCaptureOverlay()

                val intent = Intent(this@MainActivity, CaptureService::class.java).apply {
                    putExtra(CaptureService.EXTRA_RESULT_CODE, pendingProjectionResultCode)
                    putExtra(CaptureService.EXTRA_DATA, data)
                    putExtra(CaptureService.EXTRA_SCALE, scale.toFloat())
                    putExtra(CaptureService.EXTRA_INTERVAL_MS, intervalMs)
                    putExtra(CaptureService.EXTRA_STABLE_FRAMES, stableFrames)
                    putExtra(CaptureService.EXTRA_ARM, !overlayOk)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(intent)
                } else {
                    startService(intent)
                }
                // token 只能用一次，用完立刻清掉
                pendingProjectionData = null
                pendingProjectionResultCode = 0

                callJs("window.onCaptureState && window.onCaptureState(true, '')")
                true
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start capture", e)
                callJs("window.onCaptureState && " +
                    "window.onCaptureState(false, '启动失败: ${e.message}')")
                false
            }
        }

        @JavascriptInterface
        fun stop(): Boolean {
            return try {
                CaptureService.instance?.stopCapture()
                hideCaptureOverlay()
                callJs("window.onCaptureState && window.onCaptureState(false, '')")
                true
            } catch (e: Exception) {
                Log.w(TAG, "Failed to stop capture", e)
                false
            }
        }

        /* ---- 悬浮窗 ---- */

        @JavascriptInterface
        fun canDrawOverlays(): Boolean =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this@MainActivity)

        @JavascriptInterface
        fun isOverlayShowing(): Boolean = CaptureOverlay.instance?.isShowing() == true

        @JavascriptInterface
        fun openOverlaySettings() {
            runOnUiThread {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return@runOnUiThread
                try {
                    startActivity(
                        Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            android.net.Uri.parse("package:$packageName")
                        )
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to open overlay settings", e)
                }
            }
        }

        /* ---- 候选帧 ---- */

        @JavascriptInterface
        fun candidateCount(): Int {
            val dir = candidateDir() ?: return 0
            return dir.listFiles { f -> f.isFile && f.name.endsWith(".jpg") }?.size ?: 0
        }

        @JavascriptInterface
        fun listCandidates(): String = listCandidatesJson()

        @JavascriptInterface
        fun readCandidate(name: String): String = readCandidateBase64(name)

        @JavascriptInterface
        fun deleteCandidate(name: String): Boolean {
            return try {
                val dir = candidateDir() ?: return false
                java.io.File(dir, java.io.File(name).name).delete()
            } catch (e: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun clearCandidates(): Boolean {
            return try {
                val dir = candidateDir() ?: return false
                dir.listFiles()?.forEach { it.delete() }
                true
            } catch (e: Exception) {
                false
            }
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

        /** 崩溃堆栈落盘的文件名（应用私有目录，不占用户空间也不需要权限） */
        private const val CRASH_FILE = "crash-last.txt"

        /** 截图导入时的长边上限，与网页端 MAX_EDGE 保持一致 */
        private const val MAX_EDGE = 1600

        private const val PREF_SHOT_FOLDER_URI = "shotFolderUri"
        private const val PREF_SHOT_FOLDER_NAME = "shotFolderName"

        private const val PAGE_URL =
            "https://appassets.androidplatform.net/assets/www/index.html"
    }
}
