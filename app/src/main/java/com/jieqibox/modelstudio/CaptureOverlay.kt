package com.jieqibox.modelstudio

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 采集状态悬浮窗。
 *
 * 三个元素：
 *   状态点 + 两行文字（"已采 N 张 / 现在在等什么"）+ 两个按钮（开始·暂停 / 补采）
 *
 * 为什么把「开始」放在悬浮窗上而不是应用里：
 * 打开采集时人还在工坊里，而截屏窗口一旦架好，画面里是工坊自己。
 * 先切到对局应用、摆好局面，再点一下「开始」——这样第一张候选一定是棋盘，
 * 而不是切换过程中的桌面或加载画面。
 *
 * ======================================================================
 * 线程约定（这个类被一次闪退教训过，改之前请先把这段读完）
 *
 * 规矩只有一条，而且**每个碰视图的函数自己负责**：
 *
 *     碰窗口/视图的函数，函数体第一件事必须是 onMain { … }
 *
 * 不依赖调用方在主线程 —— 因为这个类会被
 * MainActivity 里的 @JavascriptInterface 方法调到，而它们跑在
 * WebView 的 JavaBridge 线程上，不是主线程。
 *
 * 当初写成「谁调用谁负责在主线程」，于是 JavaBridge 线程上执行了
 * wm.addView：这个悬浮窗的 ViewRootImpl 就被认领给了 JavaBridge 线程。
 * 此刻**一切正常**，窗口照常显示、不报任何错。半秒后主线程刷一次
 * 「已采 N 张」→ ViewRootImpl.checkThread() 发现线程对不上
 * → CalledFromWrongThreadException，没人接，应用直接退出。
 *
 * 这种错最难查：崩溃点和肇事点隔了半秒、还不在同一个函数里。
 * 所以现在把守护写在**每个碰视图的函数自己身上** —— 就算调用方忘了，
 * 也不会错。tools/check_threading.py 盯着这条规矩，改回去会报错。
 *
 * 副作用是 show()/showInternal() 这种嵌套看起来有点重复，那是有意的：
 * 外层的 onMain 是"及时响应"，内层是"正确性保险"。已在主线程时
 * onMain 直接跑，不排队，所以没有额外开销。
 * ======================================================================
 */
class CaptureOverlay(context: Context) {

    companion object {
        private const val TAG = "CaptureOverlay"

        @Volatile
        var instance: CaptureOverlay? = null
            private set

        /** 状态刷新间隔 */
        private const val REFRESH_MS = 500L

        /** 按钮显示反馈（"已采" / "已开始"）的时长 */
        private const val FLASH_MS = 1200L

        private const val COLOR_BLUE = 0xFF3568C4.toInt()
        private const val COLOR_GREEN = 0xFF2E7D32.toInt()
        private const val COLOR_RED = 0xFF7A2B2B.toInt()
        private const val COLOR_DOT_ON = 0xFF3FBF74.toInt()
        private const val COLOR_DOT_READY = 0xFFE0A33A.toInt()
        private const val COLOR_DOT_OFF = 0xFF66707C.toInt()
    }

    /**
     * 用**应用上下文**而不是 Activity。
     *
     * 这是系统悬浮窗的正确姿势：Activity 上下文绑着那个 Activity 的窗口令牌，
     * 用户切到对局应用后我们的 Activity 随时可能被回收，之后任何一次
     * updateViewLayout / removeView 都会抛 BadTokenException 直接把应用干掉。
     * 应用上下文没有这个问题，顺带也不会泄漏 Activity。
     */
    private val appContext: Context = context.applicationContext ?: context

    private val main = Handler(Looper.getMainLooper())

    private var windowManager: WindowManager? = null
    private var root: LinearLayout? = null
    private var statusText: TextView? = null
    private var countText: TextView? = null
    private var dot: View? = null
    private var armBtn: TextView? = null
    private var shotBtn: TextView? = null
    private var layoutParams: WindowManager.LayoutParams? = null

    private var refreshRunnable: Runnable? = null

    /** 拖动用 —— 只在主线程的触摸回调里读写 */
    private var touchStartX = 0f
    private var touchStartY = 0f
    private var windowStartX = 0
    private var windowStartY = 0

    @Volatile
    private var visible = false

    @Volatile
    private var captured = 0

    /**
     * 反馈文字显示到什么时候。
     * 周期刷新会不停重写按钮文字，不设这个闸门的话「已采」会被立刻冲掉，
     * 用户根本来不及看到自己点到了没有。
     */
    @Volatile
    private var flashUntil = 0L

    // ---------------------------------------------------------------- 对外
    //
    // 这些口子任何人都可能调（包括 JavaBridge 线程）。真正的活在
    // xxxInternal 里，而那些 Internal 自己也会再 onMain 一次 —— 见类注释。

    fun show() {
        showInternal()
    }

    fun hide() {
        hideInternal()
    }

    /**
     * 临时隐藏（采一帧用），之后再 setVisible(true) 恢复。
     *
     * 在主线程调用时**立即**生效，不走 post ——
     * 手动补采的流程是"隐藏 → 等一帧 → 采 → 恢复"，
     * 如果隐藏只是排进主线程队列，而主线程又在等采集结果，就一直采不到隐藏后的画面。
     * onMain 在已处于主线程时正好是"直接跑"，满足这个要求。
     */
    fun setVisible(on: Boolean) = onMain {
        root?.visibility = if (on) View.VISIBLE else View.INVISIBLE
    }

    fun isShowing(): Boolean = visible

    /** 由服务在采集到新图 / 状态变化时调用（采集线程也会调，所以必须转主线程） */
    fun refresh(count: Int) {
        captured = count
        updateTexts()
    }

    // ---------------------------------------------------------------- 工具

    /**
     * 把一段碰窗口/视图的代码送到主线程执行。
     *
     * 已经在主线程就直接跑（省掉一次排队，触摸反馈等不起），否则 post 过去。
     * 两头都吞异常：悬浮窗只是"看得见"，不该因为它把用户的应用弄崩。
     */
    private inline fun onMain(crossinline block: () -> Unit) {
        val run = Runnable {
            try {
                block()
            } catch (t: Throwable) {
                Log.w(TAG, "overlay operation failed", t)
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) run.run() else main.post(run)
    }

    private fun showInternal() = onMain {
        if (!visible) {
            try {
                val wm = appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                windowManager = wm

                val view = buildView()
                val lp = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    } else {
                        @Suppress("DEPRECATION")
                        WindowManager.LayoutParams.TYPE_PHONE
                    },
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    android.graphics.PixelFormat.TRANSLUCENT
                )
                lp.gravity = Gravity.TOP or Gravity.START
                lp.x = dp(12)
                lp.y = dp(140)

                wm.addView(view, lp)
                root = view
                layoutParams = lp
                visible = true
                instance = this

                startRefresh()
                updateTexts()
                Log.i(TAG, "Overlay shown")
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to show overlay", t)
                cleanup()
            }
        }
    }

    private fun hideInternal() = onMain {
        stopRefresh()
        try {
            root?.let { windowManager?.removeView(it) }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to remove overlay", t)
        }
        cleanup()
    }

    private fun cleanup() {
        root = null
        layoutParams = null
        windowManager = null
        dot = null
        armBtn = null
        shotBtn = null
        countText = null
        statusText = null
        visible = false
        instance = null
    }

    private fun startRefresh() {
        stopRefresh()
        val r = object : Runnable {
            override fun run() {
                updateTexts()
                main.postDelayed(this, REFRESH_MS)
            }
        }
        refreshRunnable = r
        main.post(r)
    }

    private fun stopRefresh() {
        refreshRunnable?.let { main.removeCallbacks(it) }
        refreshRunnable = null
    }

    private fun updateTexts() = onMain {
        if (!visible) return@onMain
        // 正在显示操作反馈时先别覆盖它
        if (System.currentTimeMillis() < flashUntil) return@onMain

        val svc = CaptureService.instance
        val armed = svc?.isArmed() == true
        val phase = svc?.currentPhase() ?: "idle"

        countText?.text = "已采 $captured 张"
        statusText?.text = when {
            svc == null -> "采集已停止"
            !armed -> "已就绪 · 点「开始」"
            phase == "moving" -> "画面变化中"
            phase == "settling" -> "即将采集"
            else -> "等待走子"
        }
        dot?.background = circle(
            when {
                svc == null -> COLOR_DOT_OFF
                armed -> COLOR_DOT_ON
                else -> COLOR_DOT_READY
            }
        )

        armBtn?.text = if (armed) "暂停" else "开始"
        armBtn?.background = btnBg(if (armed) COLOR_GREEN else COLOR_BLUE)
        shotBtn?.text = "补采"
        shotBtn?.background = btnBg(COLOR_BLUE)
    }

    /**
     * 搭出悬浮窗的视图。
     *
     * 这里只组装一棵**还没有父窗口**的视图树 —— 游离的层级碰不到 ViewRootImpl，
     * 所以不存在线程问题（真正的线程约束从 addView 那一刻才开始）。
     * 唯一碰到窗口的是拖动回调里的 updateViewLayout，那一处单独 onMain 了。
     */
    @SuppressLint("ClickableViewAccessibility")
    private fun buildView(): LinearLayout {
        val row = LinearLayout(appContext)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(12), dp(8), dp(10), dp(8))
        row.background = GradientDrawable().apply {
            cornerRadius = dp(20).toFloat()
            setColor(0xE61B2028.toInt())
            setStroke(dp(1), 0x66FFFFFF.toInt())
        }

        // 采集指示点：灰=没采集，黄=已就绪等开拍，绿=采集中
        val d = View(appContext)
        val dotSize = dp(8)
        d.layoutParams = LinearLayout.LayoutParams(dotSize, dotSize).apply {
            rightMargin = dp(8)
        }
        d.background = circle(COLOR_DOT_READY)
        dot = d
        row.addView(d)

        // 文字区：两行
        val texts = LinearLayout(appContext)
        texts.orientation = LinearLayout.VERTICAL
        texts.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { rightMargin = dp(10) }

        val c = TextView(appContext)
        c.text = "已采 0 张"
        c.setTextColor(Color.WHITE)
        c.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        countText = c
        texts.addView(c)

        val s = TextView(appContext)
        s.text = "已就绪"
        s.setTextColor(0xFF98A0AC.toInt())
        s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
        statusText = s
        texts.addView(s)

        row.addView(texts)

        // 开始 / 暂停
        val arm = button(if (CaptureService.instance?.isArmed() == true) "暂停" else "开始",
            COLOR_BLUE) {
            toggleArmed(it)
        }
        armBtn = arm
        row.addView(arm)

        // 手动补采
        val shot = button("补采", COLOR_BLUE) { manualCapture(it) }
        shot.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { leftMargin = dp(6) }
        shotBtn = shot
        row.addView(shot)

        /*
         * 拖动整个条。
         *
         * ACTION_DOWN 必须返回 true —— 返回 false 的话 Android 认为没人要处理这次触摸，
         * 后续的 MOVE 事件根本不会派发过来，拖动就失效了。
         *
         * 而按钮上的按下会被按钮自己消费（不再冒泡到这里），
         * 所以"点按钮"和"空白处拖动"两件事不会打架。
         */
        row.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    touchStartX = ev.rawX
                    touchStartY = ev.rawY
                    windowStartX = layoutParams?.x ?: 0
                    windowStartY = layoutParams?.y ?: 0
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val lp = layoutParams
                    if (lp != null) {
                        lp.x = windowStartX + (ev.rawX - touchStartX).toInt()
                        lp.y = windowStartY + (ev.rawY - touchStartY).toInt()
                        // 触摸回调本来就在主线程，这里再 onMain 一次是给
                        // 「碰视图的函数必须自己包住」这条规矩留的保险
                        onMain {
                            try {
                                windowManager?.updateViewLayout(root, lp)
                            } catch (t: Throwable) {
                                // 窗口正在被移除时可能抛，忽略
                            }
                        }
                    }
                    true
                }
                else -> true
            }
        }

        return row
    }

    /** 开拍 / 暂停。真正的开关在服务里，这里只负责按一下并给出反馈 */
    private fun toggleArmed(btn: TextView) {
        val svc = CaptureService.instance
        if (svc == null) {
            flash(btn, "未运行", false)
            return
        }
        val next = !svc.isArmed()
        try {
            svc.setArmed(next)
        } catch (t: Throwable) {
            Log.w(TAG, "toggleArmed failed", t)
            flash(btn, "失败", false)
            return
        }
        flash(btn, if (next) "已开始" else "已暂停", next)
    }

    /**
     * 手动补采：先把自己藏起来，等窗口真的消失，再采一帧。
     *
     * 必须藏：悬浮窗会被采进画面里，训练时模型可能把这个按钮当成特征。
     * 用 postDelayed 而不是阻塞等待 —— 阻塞主线程的话，隐藏窗口这件事
     * 反而永远排不上队（窗口的显示/隐藏都得在主线程做）。
     *
     * 编码那一帧走 captureNowAsync()（它排到采集线程上）：
     * 编一张 JPEG 要几十上百毫秒，摆在主线程上就是一次卡顿。
     *
     * 万一回调没来（服务正好在销毁），3 秒后也要把它放回来 ——
     * 否则它会一直隐身，用户以为功能坏了。
     */
    private fun manualCapture(btn: TextView) {
        val svc = CaptureService.instance
        if (svc == null) {
            flash(btn, "未运行", false)
            return
        }

        setVisible(false)
        var restored = false
        val restore = {
            if (!restored) {
                restored = true
                setVisible(true)
            }
        }

        main.postDelayed({ restore() }, 3000)
        // 120ms 约等于两帧，够窗口真正从画面上消失
        main.postDelayed({
            try {
                svc.captureNowAsync { ok ->
                    restore()
                    flash(btn, if (ok) "已采" else "失败", ok)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "manual capture failed", t)
                restore()
                flash(btn, "失败", false)
            }
        }, 120)
    }

    /**
     * 按钮上的临时反馈。
     *
     * 只改文字和底色，FLASH_MS 之后交给 updateTexts() 还原 ——
     * 还原动作统一由它做，避免两处各写一份状态。
     */
    private fun flash(btn: TextView?, msg: String, ok: Boolean) = onMain {
        if (btn != null) {
            btn.text = msg
            btn.background = btnBg(if (ok) COLOR_GREEN else COLOR_RED)
        }
        flashUntil = System.currentTimeMillis() + FLASH_MS
        main.postDelayed({
            flashUntil = 0L
            updateTexts()
        }, FLASH_MS)
    }

    private fun button(label: String, color: Int, onClick: (TextView) -> Unit): TextView {
        val btn = TextView(appContext)
        btn.text = label
        btn.setTextColor(Color.WHITE)
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        btn.gravity = Gravity.CENTER
        btn.setPadding(dp(12), dp(7), dp(12), dp(7))
        btn.background = btnBg(color)
        btn.setOnClickListener { onClick(btn) }
        return btn
    }

    private fun btnBg(color: Int): GradientDrawable = GradientDrawable().apply {
        cornerRadius = dp(14).toFloat()
        setColor(color)
    }

    private fun circle(color: Int): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
    }

    private fun dp(v: Int): Int =
        (v * appContext.resources.displayMetrics.density).toInt()
}
