package dev.tvgames.tv

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * Remote images in a small LRU (TV has ~1 GB RAM). Covers are decoded at half
 * size (300x400); small images (badges, avatars) at full size.
 */
object Covers {
    private val cache = object : LruCache<String, ImageBitmap>(96) {}

    fun cached(url: String): ImageBitmap? = cache.get(url)

    suspend fun load(url: String, sampleSize: Int = 2): ImageBitmap? = cache.get(url) ?: withContext(Dispatchers.IO) {
        runCatching {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 2500
            conn.readTimeout = 8000
            try {
                val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize }
                conn.inputStream.use { BitmapFactory.decodeStream(it, null, opts) }?.asImageBitmap()
            } finally {
                conn.disconnect()
            }
        }.getOrNull()?.also { cache.put(url, it) }
    }
}
