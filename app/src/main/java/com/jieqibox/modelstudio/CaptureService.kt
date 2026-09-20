package com.jieqibox.modelstudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Log
import java.io.File
import java.io.FileOutputStream

/**
 * 悬浮窗采集：截屏 → 判稳定 → 存候选。
 *
 * 这个服务**不依赖 WebView**。判据全是像素级的，所以用户切到对局应用时
 * 它照样工作，也不占 WebView 的算力。
 *
 * 采集状态机（这就是「新局面」的原生侧判据）：
 *
 *     等变化 ──画面动了──> 走子中 ──变化率降下来──> 存候选 ──> 等变化
 *
 * 关键在于存完要**重新等一次变化**，否则画面静止时会不停地存同一张。
 * 至于「局面是否真的变了」（比如只是计时器跳动），由 WebView 侧用识别出的
 * FEN 再做一次去重 —— 那是第二道过滤，不在这里做。
 */
class CaptureService : Service() {

    companion object {
        private const val TAG = "CaptureService"
        private const val CHANNEL_ID = "model_studio_capture"
        private const val NOTIFICATION_ID = 0x7A32

        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "data"
        const val EXTRA_SCALE = "scale"
        const val EXTRA_INTERVAL_MS = "intervalMs"
        const val EXTRA_STABLE_FRAMES = "stableFrames"

        /** 变化检测用的亮度指纹网格边长 */
        private const val SIGNATURE_GRID = 16

        /** 单格亮度差超过这个值就算"这格变了" */
        private const val SIGNATURE_TOLERANCE = 10

        /** 变化率超过这个值 = 画面在动（走子中） */
        private const val MOVING_RATIO = 0.008

        /** 候选图最长边。与网页端的 MAX_EDGE 一致，保证坐标空间相同 */
        private const val CANDIDATE_MAX_EDGE = 1600

        /** 候选图 JPEG 质量 */
        private const val CANDIDATE_QUALITY = 90

        /** 候选目录名（放在应用私有目录下，不需要存储权限） */
        const val CANDIDATE_DIR = "capture-candidates"

        @Volatile
        var instance: CaptureService? = null
            private set

        fun isRunning(): Boolean = instance != null
    }

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var handlerThread: HandlerThread? = null
    private var handler: Handler? = null

    private var frameWidth = 0
    private var frameHeight = 0
    private var captureScale = 0.5f

    /** 采集间隔下限（毫秒），由网页端传进来 */
    @Volatile
    private var minIntervalMs = 5000L

    /** 连续多少帧算稳定 */
    @Volatile
    private var stableFramesNeeded = 3

    private val frameLock = Any()
    private var latestBitmap: Bitmap? = null
    private var latestSignature: IntArray? = null

    @Volatile
    private var lastChangeRatio = 1.0

    /** 状态机的当前状态 */
    private enum class Phase { WAITING_CHANGE, MOVING, SETTLING }
    private var phase = Phase.WAITING_CHANGE
    private var stableCount = 0

    @Volatile
    private var lastCaptureTime = 0L

    @Volatile
    private var capturedCount = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val data = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(EXTRA_DATA) as? Intent
        }
        captureScale = intent.getFloatExtra(EXTRA_SCALE, 0.5f).coerceIn(0.15f, 1.0f)
        minIntervalMs = intent.getIntExtra(EXTRA_INTERVAL_MS, 5000).toLong().coerceIn(1000L, 120000L)
        stableFramesNeeded = intent.getIntExtra(EXTRA_STABLE_FRAMES, 3).coerceIn(1, 10)

        if (data == null || resultCode == 0) {
            Log.w(TAG, "Missing projection token")
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundCompat()

        return if (startProjection(resultCode, data)) {
            capturedCount = countCandidates()
            Log.i(TAG, "Capture started; existing candidates=$capturedCount")
            START_STICKY
        } else {
            stopSelf()
            START_NOT_STICKY
        }
    }

    override fun onDestroy() {
        releaseProjection()
        instance = null
        super.onDestroy()
    }

    // ---------------------------------------------------------------- 前台通知

    private fun startForegroundCompat() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.capture_channel_name),
                NotificationManager.IMPORTANCE_LOW
            )
            ch.description = getString(R.string.capture_channel_description)
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }

        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        val notification = builder
            .setContentTitle(getString(R.string.capture_notification_title))
            .setContentText(getString(R.string.capture_notification_text))
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentIntent(open)
            .setOngoing(true)
            .build()

        // Android 14 起前台服务必须声明类型，截屏属于 mediaProjection
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(count: Int) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val n = builder
            .setContentTitle(getString(R.string.capture_notification_title))
            .setContentText(getString(R.string.capture_notification_count, count))
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        nm.notify(NOTIFICATION_ID, n)
    }

    // ---------------------------------------------------------------- 截屏

    private fun startProjection(resultCode: Int, data: Intent): Boolean {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val proj = try {
            manager.getMediaProjection(resultCode, data)
        } catch (e: Exception) {
            Log.e(TAG, "getMediaProjection failed", e)
            return false
        }
        projection = proj

        val metrics = resources.displayMetrics
        val screenWidth = metrics.widthPixels
        val screenHeight = metrics.heightPixels
        val densityDpi = metrics.densityDpi

        frameWidth = (screenWidth * captureScale).toInt().coerceAtLeast(180)
        frameHeight = (screenHeight * captureScale).toInt().coerceAtLeast(180)

        val thread = HandlerThread("model-studio-capture")
        thread.start()
        handlerThread = thread
        val h = Handler(thread.looper)
        handler = h

        val reader = ImageReader.newInstance(
            frameWidth, frameHeight, PixelFormat.RGBA_8888, 2
        )
        imageReader = reader
        reader.setOnImageAvailableListener({ r -> onImageAvailable(r) }, h)

        // 用户在系统弹窗里点"停止共享"时，服务也要跟着停
        proj.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                Log.i(TAG, "Projection stopped by system")
                stopSelf()
            }
        }, h)

        virtualDisplay = proj.createVirtualDisplay(
            "model-studio-capture",
            frameWidth, frameHeight, densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface, null, h
        )

        return virtualDisplay != null
    }

    private fun releaseProjection() {
        try { virtualDisplay?.release() } catch (e: Exception) { /* 忽略 */ }
        virtualDisplay = null
        try { imageReader?.close() } catch (e: Exception) { /* 忽略 */ }
        imageReader = null
        try { projection?.stop() } catch (e: Exception) { /* 忽略 */ }
        projection = null
        handlerThread?.quitSafely()
        handlerThread = null
        handler = null
        synchronized(frameLock) {
            latestBitmap?.recycle()
            latestBitmap = null
            latestSignature = null
        }
    }

    private fun onImageAvailable(reader: ImageReader) {
        var image: Image? = null
        try {
            image = reader.acquireLatestImage() ?: return
            val bitmap = imageToBitmap(image) ?: return

            val signature = luminanceSignature(bitmap)
            val previous = latestSignature
            val ratio = if (previous == null) 1.0 else {
                var changed = 0
                for (i in signature.indices) {
                    if (Math.abs(signature[i] - previous[i]) > SIGNATURE_TOLERANCE) changed++
                }
                changed.toDouble() / signature.size
            }

            synchronized(frameLock) {
                // 只留最新一帧：采集总是采"现在"，不是"刚才"
                latestBitmap?.recycle()
                latestBitmap = bitmap
                latestSignature = signature
                lastChangeRatio = ratio
            }

            stepStateMachine(ratio)
        } catch (e: Exception) {
            Log.w(TAG, "Frame handling failed", e)
        } finally {
            try { image?.close() } catch (e: Exception) { /* 忽略 */ }
        }
    }

    /**
     * 采集状态机。
     *
     * 之所以需要它：画面静止时变化率一直很低，如果只看"稳定就采"，
     * 会每隔几秒存一张一模一样的图。必须先等到画面动过（走子），
     * 再等它稳定下来（走子完成），这才是"一个新的局面"。
     */
    private fun stepStateMachine(ratio: Double) {
        when (phase) {
            Phase.WAITING_CHANGE -> {
                if (ratio > MOVING_RATIO) {
                    phase = Phase.MOVING
                    stableCount = 0
                }
            }
            Phase.MOVING -> {
                if (ratio <= MOVING_RATIO) {
                    // 开始静下来，进入"结算"阶段，再确认几帧
                    phase = Phase.SETTLING
                    stableCount = 1
                }
            }
            Phase.SETTLING -> {
                if (ratio > MOVING_RATIO) {
                    // 又动了，说明刚才只是动画中间的停顿
                    phase = Phase.MOVING
                    stableCount = 0
                } else {
                    stableCount++
                    if (stableCount >= stableFramesNeeded) {
                        val now = System.currentTimeMillis()
                        if (now - lastCaptureTime >= minIntervalMs) {
                            if (saveCandidate()) {
                                lastCaptureTime = now
                                capturedCount++
                                updateNotification(capturedCount)
                                notifyOverlay()
                            }
                        }
                        // 无论存没存（可能是间隔不够被跳过），都回去等下一次变化
                        phase = Phase.WAITING_CHANGE
                        stableCount = 0
                    }
                }
            }
        }
    }

    /** 手动补采：无视状态机，直接存当前这一帧 */
    fun captureNow(): Boolean {
        val now = System.currentTimeMillis()
        val ok = saveCandidate()
        if (ok) {
            lastCaptureTime = now
            capturedCount++
            updateNotification(capturedCount)
            notifyOverlay()
            // 手采之后回到等变化，避免立刻又自动采一张
            phase = Phase.WAITING_CHANGE
            stableCount = 0
        }
        return ok
    }

    private fun saveCandidate(): Boolean {
        synchronized(frameLock) {
            val bitmap = latestBitmap ?: return false
            return try {
                val jpeg = encodeJpeg(bitmap, CANDIDATE_QUALITY, CANDIDATE_MAX_EDGE)
                    ?: return false
                val dir = candidateDir(this) ?: return false
                val name = "shot_" + System.currentTimeMillis() + ".jpg"
                FileOutputStream(File(dir, name)).use { it.write(jpeg) }
                Log.i(TAG, "Candidate saved: $name")
                true
            } catch (e: Exception) {
                Log.w(TAG, "Failed to save candidate", e)
                false
            }
        }
    }

    // ---------------------------------------------------------------- 工具

    private fun imageToBitmap(image: Image): Bitmap? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * image.width

        val bmp = Bitmap.createBitmap(
            image.width + rowPadding / pixelStride,
            image.height,
            Bitmap.Config.ARGB_8888
        )
        bmp.copyPixelsFromBuffer(buffer)

        // 去掉行填充（有些设备 rowStride 不是宽度的整数倍）
        return if (rowPadding == 0) {
            bmp
        } else {
            Bitmap.createBitmap(bmp, 0, 0, image.width, image.height).also {
                if (it != bmp) bmp.recycle()
            }
        }
    }

    /**
     * 亮度指纹：把画面压成 16×16 的平均亮度。
     *
     * 比逐像素比对便宜得多，而且对压缩噪声不敏感 ——
     * 我们只关心"画面整体动没动"。
     */
    private fun luminanceSignature(bitmap: Bitmap): IntArray {
        val out = IntArray(SIGNATURE_GRID * SIGNATURE_GRID)
        val cw = bitmap.width.toFloat() / SIGNATURE_GRID
        val ch = bitmap.height.toFloat() / SIGNATURE_GRID
        for (gy in 0 until SIGNATURE_GRID) {
            for (gx in 0 until SIGNATURE_GRID) {
                val x0 = (gx * cw).toInt().coerceIn(0, bitmap.width - 1)
                val y0 = (gy * ch).toInt().coerceIn(0, bitmap.height - 1)
                val x1 = ((gx + 1) * cw).toInt().coerceIn(x0 + 1, bitmap.width)
                val y1 = ((gy + 1) * ch).toInt().coerceIn(y0 + 1, bitmap.height)
                var sum = 0L
                var n = 0
                var y = y0
                while (y < y1) {
                    var x = x0
                    while (x < x1) {
                        val p = bitmap.getPixel(x, y)
                        val luma = ((p shr 16 and 0xFF) * 299 +
                                    (p shr 8 and 0xFF) * 587 +
                                    (p and 0xFF) * 114) / 1000
                        sum += luma
                        n++
                        x += 2
                    }
                    y += 2
                }
                out[gy * SIGNATURE_GRID + gx] = if (n > 0) (sum / n).toInt() else 0
            }
        }
        return out
    }

    private fun encodeJpeg(bitmap: Bitmap, quality: Int, maxEdge: Int): ByteArray? {
        return try {
            val longest = maxOf(bitmap.width, bitmap.height)
            val target = if (longest > maxEdge) {
                val ratio = maxEdge.toFloat() / longest.toFloat()
                Bitmap.createScaledBitmap(
                    bitmap,
                    (bitmap.width * ratio).toInt().coerceAtLeast(1),
                    (bitmap.height * ratio).toInt().coerceAtLeast(1),
                    true
                )
            } else {
                bitmap
            }
            val bos = java.io.ByteArrayOutputStream()
            target.compress(Bitmap.CompressFormat.JPEG, quality, bos)
            if (target != bitmap) target.recycle()
            bos.toByteArray()
        } catch (e: Exception) {
            Log.w(TAG, "encodeJpeg failed", e)
            null
        }
    }

    private fun notifyOverlay() {
        try {
            CaptureOverlay.instance?.refresh(capturedCount)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to refresh overlay", e)
        }
    }

    // ---------------------------------------------------------------- 对外

    fun captured(): Int = capturedCount

    fun currentChangeRatio(): Double = lastChangeRatio

    fun currentPhase(): String = when (phase) {
        Phase.WAITING_CHANGE -> "waiting"
        Phase.MOVING -> "moving"
        Phase.SETTLING -> "settling"
    }

    fun candidateDirRef(): File? = candidateDir(this)

    private fun countCandidates(): Int {
        val dir = candidateDir(this) ?: return 0
        return dir.listFiles()?.count { it.name.endsWith(".jpg") } ?: 0
    }

    fun stopCapture() {
        releaseProjection()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** 候选目录：应用私有目录，不申请任何存储权限 */
    fun candidateDir(ctx: Context): File? {
        val dir = File(ctx.filesDir, CANDIDATE_DIR)
        if (!dir.exists() && !dir.mkdirs()) return null
        return dir
    }
}
