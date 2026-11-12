package dev.tvgames.tv

import android.content.Context
import android.content.Intent

private const val MOONLIGHT = "com.limelight"

/**
 * Starts the game through Moonlight's exported ShortcutTrampoline, passing the
 * Sunshine app id (not only the name: name lookup uses Moonlight's cached app
 * list, which misses games published after the PC was last opened there).
 * Returns an error message, or null on success.
 */
fun launchInMoonlight(context: Context, host: Host, game: GameEntry): String? {
    val installed = runCatching { context.packageManager.getPackageInfo(MOONLIGHT, 0) }.isSuccess
    if (!installed) return "O Moonlight não está instalado na TV."
    val intent = Intent()
        .setClassName(MOONLIGHT, "$MOONLIGHT.ShortcutTrampoline")
        .putExtra("UUID", host.uuid)
        .putExtra("Name", host.name)
        .putExtra("AppId", game.appId)
        .putExtra("AppName", game.appName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return runCatching { context.startActivity(intent) }.exceptionOrNull()?.let { "Não consegui abrir o Moonlight: ${it.message}" }
}
