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
 * 刻意做成**只读状态 + 一个补采按钮**：
 * 自动采集本身不需要操作，悬浮窗存在的意义是让你知道它还在工作、
 * 以及漏采时能手动补一张。
 *
 * 手动补采时必须先把自己藏起来再采 —— 否则悬浮窗会被采进画面，
 * 训练时模型可能把这个按钮当成特征。见 manualCapture()。
 */
class CaptureOverlay(private val context: Context) {

    companion object {
        private const val TAG = "CaptureOverlay"

        @Volatile
        var instance: CaptureOverlay? = null
            private set

        /** 状态刷新间隔 */
        private const val REFRESH_MS = 500L
    }

    private var windowManager: WindowManager? = null
    private var root: LinearLayout? = null
    private var statusText: TextView? = null
    private var countText: TextView? = null
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

    fun show() {
        if (visible) return
        try {
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
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
        } catch (e: Exception) {
            Log.e(TAG, "Failed to show overlay", e)
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
        } catch (e: Exception) {
            Log.w(TAG, "Failed to remove overlay", e)
        }
        root = null
        layoutParams = null
        windowManager = null
        visible = false
        instance = null
    }

    fun isShowing(): Boolean = visible

    /** 由服务在采集到新图时调用 */
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
        countText?.text = "已采 $captured 张"
        val phase = CaptureService.instance?.currentPhase() ?: "waiting"
        val label = when (phase) {
            "moving" -> "画面变化中"
            "settling" -> "即将采集"
            else -> "等待走子"
        }
        statusText?.text = label
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun buildView(): LinearLayout {
        val row = LinearLayout(context)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(12), dp(8), dp(10), dp(8))
        row.background = GradientDrawable().apply {
            cornerRadius = dp(20).toFloat()
            setColor(0xE61B2028.toInt())
            setStroke(dp(1), 0x66FFFFFF.toInt())
        }

        // 采集指示点（会随状态变色，让用户一眼看出它在工作）
        val dot = View(context)
        val dotSize = dp(8)
        dot.layoutParams = LinearLayout.LayoutParams(dotSize, dotSize).apply {
            rightMargin = dp(8)
        }
        dot.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(0xFF3FBF74.toInt())
        }
        row.addView(dot)

        // 文字区：两行
        val texts = LinearLayout(context)
        texts.orientation = LinearLayout.VERTICAL
        texts.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { rightMargin = dp(10) }

        val c = TextView(context)
        c.text = "已采 0 张"
        c.setTextColor(Color.WHITE)
        c.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        countText = c
        texts.addView(c)

        val s = TextView(context)
        s.text = "等待走子"
        s.setTextColor(0xFF98A0AC.toInt())
        s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
        statusText = s
        texts.addView(s)

        row.addView(texts)

        // 手动补采
        val btn = TextView(context)
        btn.text = "补采"
        btn.setTextColor(Color.WHITE)
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        btn.gravity = Gravity.CENTER
        btn.setPadding(dp(12), dp(7), dp(12), dp(7))
        btn.background = GradientDrawable().apply {
            cornerRadius = dp(14).toFloat()
            setColor(0xFF3568C4.toInt())
        }
        btn.setOnClickListener { manualCapture(btn) }
        row.addView(btn)

        /*
         * 拖动整个条。
         *
         * ACTION_DOWN 必须返回 true —— 返回 false 的话 Android 认为没人要处理这次触摸，
         * 后续的 MOVE 事件根本不会派发过来，拖动就失效了。
         *
         * 而按钮上的按下会被按钮自己消费（不再冒泡到这里），
         * 所以"点按钮补采"和"空白处拖动"两件事不会打架。
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
                        try { windowManager?.updateViewLayout(root, lp) } catch (e: Exception) {
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

    /**
     * 手动补采：先把自己藏起来，等窗口真的消失，再采一帧。
     *
     * 必须藏：悬浮窗会被采进画面里，训练时模型可能把这个按钮当成特征。
     * 用 postDelayed 而不是阻塞等待 —— 阻塞主线程的话，隐藏窗口这件事
     * 反而永远排不上队（窗口的显示/隐藏都得在主线程做）。
     */
    private fun manualCapture(btn: TextView) {
        val svc = CaptureService.instance
        if (svc == null) {
            flash(btn, "未在采集", false)
            return
        }
        setVisible(false)
        // 120ms 约等于两帧，够窗口真正从画面上消失
        main.postDelayed({
            val ok = try { svc.captureNow() } catch (e: Exception) {
                Log.w(TAG, "manual capture failed", e)
                false
            }
            setVisible(true)
            flash(btn, if (ok) "已采" else "失败", ok)
        }, 120)
    }

    private fun flash(btn: TextView, msg: String, ok: Boolean) {
        val original = "补采"
        btn.text = msg
        btn.background = GradientDrawable().apply {
            cornerRadius = dp(14).toFloat()
            setColor(if (ok) 0xFF2E7D32.toInt() else 0xFF7A2B2B.toInt())
        }
        main.postDelayed({
            btn.text = original
            btn.background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat()
                setColor(0xFF3568C4.toInt())
            }
        }, 1200)
    }

    private fun dp(v: Int): Int =
        (v * context.resources.displayMetrics.density).toInt()
}
