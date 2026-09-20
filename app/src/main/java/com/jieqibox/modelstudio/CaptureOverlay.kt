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
 * 手动补采时必须先把自己藏起来再采 —— 否则悬浮窗会被采进画面，
 * 训练时模型可能把这个按钮当成特征。见 manualCapture()。
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

    private var windowManager: WindowManager? = null
    private var root: LinearLayout? = null
    private var statusText: TextView? = null
    private var countText: TextView? = null
    private var dot: View? = null
    private var armBtn: TextView? = null
    private var shotBtn: TextView? = null
    private var layoutParams: WindowManager.LayoutParams? = null
    private val main = Handler(Looper.getMainLooper())

    private var refreshRunnable: Runnable? = null

    /** 拖动用 */
    private var touchStartX = 0f
    private var touchStartY = 0f
    private var windowStartX = 0
    private var windowStartY = 0

    private var visible = false
    private var captured = 0

    /**
     * 反馈文字显示到什么时候。
     * 周期刷新会不停重写按钮文字，不设这个闸门的话「已采」会被立刻冲掉，
     * 用户根本来不及看到自己点到了没有。
     */
    private var flashUntil = 0L

    fun show() {
        if (visible) return
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
            Log.i(TAG, "Overlay shown")
        } catch (t: Throwable) {
            // 悬浮窗只是"看得见"，不该因为它把应用弄崩
            Log.e(TAG, "Failed to show overlay", t)
            cleanup()
        }
    }

    /**
     * 临时隐藏（采一帧用），之后再 setVisible(true) 恢复。
     *
     * 在主线程调用时**立即**生效，不能走 post ——
     * 手动补采的流程是"隐藏 → 等一帧 → 采 → 恢复"，
     * 如果隐藏只是排进主线程队列，而主线程又在等采集结果，就会一直采不到隐藏后的画面。
     */
    fun setVisible(on: Boolean) {
        val apply = Runnable {
            val v = root ?: return@Runnable
            v.visibility = if (on) View.VISIBLE else View.INVISIBLE
        }
        if (Looper.myLooper() == Looper.getMainLooper()) apply.run()
        else main.post(apply)
    }

    fun hide() {
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

    fun isShowing(): Boolean = visible

    /** 由服务在采集到新图 / 状态变化时调用 */
    fun refresh(count: Int) {
        captured = count
        main.post { updateTexts() }
    }

    // ---------------------------------------------------------------- 内部

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

    private fun updateTexts() {
        if (!visible) return
        // 正在显示操作反馈时先别覆盖它
        if (System.currentTimeMillis() < flashUntil) return

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
                        try {
                            windowManager?.updateViewLayout(root, lp)
                        } catch (t: Throwable) {
                            // 窗口正在被移除时可能抛，忽略
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
     * 采集本身在采集线程上跑，结果回来之前悬浮窗一直是藏着的；
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
    private fun flash(btn: TextView?, msg: String, ok: Boolean) {
        if (btn == null) return
        btn.text = msg
        btn.background = btnBg(if (ok) COLOR_GREEN else COLOR_RED)
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
