package dev.tvgames.tv

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.resume

data class Host(val name: String, val uuid: String)

data class Badge(val title: String, val description: String, val points: Int, val url: String, val earned: Boolean)

data class Achievements(val total: Int, val earned: Int, val badges: List<Badge>) {
    val percent: Int get() = if (total == 0) 0 else earned * 100 / total
}

data class Profile(val user: String, val points: Long, val softcorePoints: Long, val avatar: String?)

data class GameEntry(
    val id: String,
    val title: String,
    val tags: List<String>,
    val category: String,
    val launcher: Boolean,
    /** Exact Sunshine app name/id: what Moonlight needs to start it. */
    val appName: String,
    val appId: String,
    /** Absolute URL of the cover, or null. */
    val cover: String?,
    /** RetroAchievements progress, when the game has achievements. */
    val achievements: Achievements?,
)

data class Library(val baseUrl: String, val host: Host, val profile: Profile?, val games: List<GameEntry>)

const val API_PORT = 47900
private const val DEFAULT_HOST = "192.168.50.2"
private const val PREFS = "tvgames"
private const val KEY_BASE_URL = "base_url"

/** Finds the PC's `tvgames serve` and fetches the library. */
class Repository(private val context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Blocking parts run on the caller's dispatcher (IO). */
    suspend fun load(): Library {
        val tried = linkedSetOf<String>()
        prefs.getString(KEY_BASE_URL, null)?.let { tried += it }
        tried += "http://$DEFAULT_HOST:$API_PORT"
        var lastError: Exception? = null
        for (base in tried) {
            try {
                return fetch(base).also { remember(base) }
            } catch (e: Exception) {
                lastError = e
            }
        }
        // Sunshine announces itself over mDNS; the API runs on the same machine.
        val found = discoverHost()
        if (found != null) {
            val base = "http://$found:$API_PORT"
            if (base !in tried) {
                return fetch(base).also { remember(base) }
            }
        }
        throw lastError ?: IllegalStateException("PC não encontrado")
    }

    private fun remember(base: String) = prefs.edit().putString(KEY_BASE_URL, base).apply()

    private fun fetch(base: String): Library {
        val conn = URL("$base/api/library").openConnection() as HttpURLConnection
        conn.connectTimeout = 2500
        conn.readTimeout = 8000
        try {
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                val msg = runCatching { JSONObject(body).optString("error") }.getOrNull()
                throw IllegalStateException(msg?.takeIf { it.isNotBlank() } ?: "HTTP $code")
            }
            return parseLibrary(base, body)
        } finally {
            conn.disconnect()
        }
    }

    private suspend fun discoverHost(): String? = withTimeoutOrNull(5000) {
        val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
        suspendCancellableCoroutine { cont ->
            var resolving = false
            val listener = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(serviceType: String) {}
                override fun onDiscoveryStopped(serviceType: String) {}
                override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                    if (cont.isActive) cont.resume(null)
                }
                override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
                override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
                override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                    if (resolving) return
                    resolving = true
                    @Suppress("DEPRECATION")
                    nsd.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                            resolving = false
                        }
                        override fun onServiceResolved(info: NsdServiceInfo) {
                            @Suppress("DEPRECATION")
                            val addr = info.host?.hostAddress
                            if (addr != null && cont.isActive) cont.resume(addr)
                        }
                    })
                }
            }
            nsd.discoverServices("_nvstream._tcp", NsdManager.PROTOCOL_DNS_SD, listener)
            cont.invokeOnCancellation { runCatching { nsd.stopServiceDiscovery(listener) } }
        }
    }
}

fun parseLibrary(base: String, json: String): Library {
    val root = JSONObject(json)
    val h = root.getJSONObject("host")
    val arr = root.getJSONArray("games")
    val games = (0 until arr.length()).map { i ->
        val g = arr.getJSONObject(i)
        val tags = g.optJSONArray("tags")
        GameEntry(
            id = g.getString("id"),
            title = g.getString("title"),
            tags = (0 until (tags?.length() ?: 0)).map { tags!!.getString(it) },
            category = g.optString("category"),
            launcher = g.optBoolean("launcher"),
            appName = g.getString("app_name"),
            appId = g.getString("app_id"),
            cover = g.optString("cover").takeIf { it.isNotBlank() && it != "null" }?.let { base + it },
            achievements = g.optJSONObject("achievements")?.let { a ->
                val badges = a.optJSONArray("badges")
                Achievements(
                    total = a.optInt("total"),
                    earned = a.optInt("earned"),
                    badges = (0 until (badges?.length() ?: 0)).map { j ->
                        val b = badges!!.getJSONObject(j)
                        Badge(b.optString("title"), b.optString("description"), b.optInt("points"), b.optString("url"), b.optBoolean("earned"))
                    },
                )
            },
        )
    }
    val profile = root.optJSONObject("profile")?.let {
        Profile(it.optString("user"), it.optLong("points"), it.optLong("softcore_points"), it.optString("avatar").takeIf { a -> a.isNotBlank() })
    }
    return Library(base, Host(h.optString("name"), h.optString("uuid")), profile, games)
}
