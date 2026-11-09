package network.sentinel.devnetdvpn.node

import android.content.Context
import android.net.Uri
import android.util.Log
import java.io.File
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

// ─── "Open file" for Node (Electron's dialog.showOpenDialog) ───
// The app bridge runs in the VPN service; Android's document picker needs an Activity. MainActivity
// registers itself here while it is on screen. The chosen document is copied to private cache
// (Node reads plain paths) and the copy is deleted after COPY_TTL_MS: a picked file can be a
// wallet key file.

object FilePicker {
    private const val TAG = "ddv-pick"
    private const val COPY_TTL_MS = 60_000L
    private const val MAX_BYTES = 1_000_000

    /** Shows the system picker; completes with a content Uri, or null when cancelled. */
    fun interface Host {
        fun launchPicker(done: CompletableFuture<Uri?>)
    }

    @Volatile var host: Host? = null

    /** Blocks the bridge thread until the person picks a file. Returns the private copy's path. */
    fun pick(ctx: Context, timeoutMs: Long): String? {
        val h = host ?: error("open the app to choose a file")
        val done = CompletableFuture<Uri?>()
        h.launchPicker(done)
        val uri = try {
            done.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            Log.w(TAG, "picker timed out", e)
            null
        } ?: return null
        val dir = File(ctx.cacheDir, "pick").apply { mkdirs() }
        val out = File(dir, UUID.randomUUID().toString())
        ctx.contentResolver.openInputStream(uri).use { input ->
            requireNotNull(input) { "the chosen file could not be opened" }
            val bytes = input.readNBytesCompat(MAX_BYTES + 1)
            require(bytes.size <= MAX_BYTES) { "the chosen file is larger than 1 MB" }
            out.writeBytes(bytes)
        }
        out.setReadable(false, false)
        out.setReadable(true, true)
        Thread {
            try {
                Thread.sleep(COPY_TTL_MS)
            } catch (e: InterruptedException) {
                Log.w(TAG, "cleanup interrupted", e)
            }
            if (!out.delete() && out.exists()) Log.w(TAG, "could not delete ${out.name}")
        }.apply { isDaemon = true }.start()
        return out.absolutePath
    }

    /** Leftovers from a crash between copy and cleanup. */
    fun clearCache(ctx: Context) {
        File(ctx.cacheDir, "pick").listFiles()?.forEach { if (!it.delete()) Log.w(TAG, "stale ${it.name} not deleted") }
    }

    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val buf = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(16 * 1024)
        while (buf.size() < limit) {
            val n = read(chunk, 0, minOf(chunk.size, limit - buf.size()))
            if (n < 0) break
            buf.write(chunk, 0, n)
        }
        return buf.toByteArray()
    }
}
