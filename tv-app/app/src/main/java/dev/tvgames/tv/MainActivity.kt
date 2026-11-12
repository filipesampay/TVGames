package dev.tvgames.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface UiState {
    data object Loading : UiState
    data class Error(val message: String) : UiState
    data class Ready(val library: Library) : UiState
}

class MainActivity : ComponentActivity() {
    private val state = mutableStateOf<UiState>(UiState.Loading)
    private val launching = mutableStateOf<GameEntry?>(null)
    private val toast = mutableStateOf<String?>(null)
    private lateinit var repo: Repository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        repo = Repository(applicationContext)
        setContent {
            TvGamesTheme {
                TvGamesScreen(
                    state = state.value,
                    launching = launching.value,
                    message = toast.value,
                    onRetry = ::reload,
                    onPlay = ::play,
                )
            }
        }
    }

    // Also runs when coming back from a game: the library may have changed.
    override fun onResume() {
        super.onResume()
        launching.value = null
        reload()
    }

    private fun reload() {
        lifecycleScope.launch {
            if (state.value !is UiState.Ready) state.value = UiState.Loading
            state.value = try {
                UiState.Ready(withContext(Dispatchers.IO) { repo.load() })
            } catch (e: Exception) {
                UiState.Error(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    private fun play(game: GameEntry) {
        val lib = (state.value as? UiState.Ready)?.library ?: return
        launching.value = game
        val error = launchInMoonlight(this, lib.host, game)
        if (error != null) {
            launching.value = null
            toast.value = error
            lifecycleScope.launch {
                delay(4000)
                toast.value = null
            }
        }
    }
}
