package network.sentinel.devnetdvpn.node

import android.util.Log
import java.io.BufferedWriter
import java.io.IOException
import java.util.concurrent.CopyOnWriteArraySet
import org.json.JSONObject

// ─── Node main process (src/android/main.ts → assets node/main.cjs) ───
// Long-lived, owned by the VPN service so it outlives the screen. Talks JSON lines over
// stdin/stdout (see main.ts header). Restarted with backoff if it dies; calls in flight when it
// dies get an error reply so the UI never waits forever.

class NodeMain(private val runtime: NodeRuntime) {
    interface Listener {
        fun onReply(id: Long, resultJson: String)
        fun onEvent(channel: String, payloadJson: String)
        fun onReady() {}
    }

    private val listeners = CopyOnWriteArraySet<Listener>()
    private val inFlight = java.util.concurrent.ConcurrentHashMap.newKeySet<Long>()
    @Volatile private var proc: Process? = null
    @Volatile private var stdin: BufferedWriter? = null
    @Volatile private var running = false
    @Volatile var ready = false
        private set
    private var failures = 0
    /** Calls made before the engine said ready (app start, engine restart): sent on ready. */
    private val queued = java.util.concurrent.ConcurrentLinkedQueue<JSONObject>()

    fun addListener(l: Listener) { listeners.add(l); if (ready) l.onReady() }
    fun removeListener(l: Listener) { listeners.remove(l) }

    fun start() {
        if (running) return
        running = true
        Thread(::superviseLoop, "test-host").start()
    }

    fun stop() {
        running = false
        send(JSONObject().put("quit", true))
        proc?.let { p ->
            if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) p.destroy()
        }
    }

    /** A renderer invoke: the reply arrives through Listener.onReply. */
    fun invoke(id: Long, channel: String, payloadJson: String) {
        val payload: Any = try {
            org.json.JSONTokener(payloadJson).nextValue() ?: JSONObject.NULL
        } catch (e: org.json.JSONException) {
            Log.w(TAG, "bad payload for $channel", e)
            JSONObject.NULL
        }
        inFlight.add(id)
        val msg = JSONObject().put("id", id).put("ch", channel).put("p", payload)
        if (!ready) {
            if (queued.size >= MAX_QUEUED) fail(id, "The app engine is starting. Try again in a moment.") else queued.add(msg)
            return
        }
        if (!send(msg)) fail(id, "The app engine is starting. Try again in a moment.")
    }

    fun visible(shown: Boolean) { send(JSONObject().put("visible", shown)) }

    private fun send(msg: JSONObject): Boolean {
        val w = stdin ?: return false
        return try {
            synchronized(w) { w.write(msg.toString()); w.newLine(); w.flush() }
            true
        } catch (e: IOException) {
            Log.w(TAG, "write to node main failed", e)
            false
        }
    }

    private fun fail(id: Long, message: String) {
        inFlight.remove(id)
        val r = JSONObject().put("ok", false).put("error", message).put("code", "unavailable").toString()
        listeners.forEach { it.onReply(id, r) }
    }

    private fun superviseLoop() {
        while (running) {
            val started = System.currentTimeMillis()
            try {
                runOnce()
            } catch (e: Exception) {
                Log.e(TAG, "node main failed to run", e)
            }
            ready = false
            stdin = null
            queued.clear()
            inFlight.toList().forEach { fail(it, "The app engine restarted. Try again.") }
            if (!running) break
            failures = if (System.currentTimeMillis() - started > 60_000) 1 else failures + 1
            val delay = minOf(30_000L, 1000L shl minOf(failures, 5))
            Log.w(TAG, "node main exited; restarting in ${delay}ms")
            Thread.sleep(delay)
        }
    }

    private fun runOnce() {
        runtime.prepare()
        val pb = ProcessBuilder(runtime.nodeBin.absolutePath, runtime.mainBundle.absolutePath)
            .directory(runtime.dataDir.parentFile)
        pb.environment().putAll(runtime.env())
        val p = pb.start()
        proc = p
        stdin = p.outputStream.bufferedWriter()
        Thread({ p.errorStream.bufferedReader().forEachLine { Log.i(TAG, it) } }, "test-host").start()
        p.inputStream.bufferedReader().forEachLine(::onLine)
        val code = p.waitFor()
        Log.w(TAG, "node main exited with $code")
    }

    private fun onLine(line: String) {
        val msg = try {
            JSONObject(line)
        } catch (e: org.json.JSONException) {
            Log.i(TAG, "stdout: $line")
            return
        }
        when {
            msg.has("id") && msg.has("r") -> {
                val id = msg.getLong("id")
                inFlight.remove(id)
                val r = msg.get("r").toString()
                listeners.forEach { it.onReply(id, r) }
            }
            msg.has("ev") -> {
                val ch = msg.getString("ev")
                val p = msg.opt("p")?.toString() ?: "null"
                listeners.forEach { it.onEvent(ch, p) }
            }
            msg.optBoolean("ready") -> {
                ready = true
                failures = 0
                while (true) {
                    val m = queued.poll() ?: break
                    if (!send(m)) fail(m.getLong("id"), "The app engine is starting. Try again in a moment.")
                }
                listeners.forEach { it.onReady() }
            }
        }
    }

    private companion object {
        const val TAG = "test-host"
        const val MAX_QUEUED = 500
    }
}
