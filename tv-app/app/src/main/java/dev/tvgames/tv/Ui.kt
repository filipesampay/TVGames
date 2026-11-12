@file:OptIn(ExperimentalTvMaterial3Api::class)

package dev.tvgames.tv

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.Button
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.ExperimentalTvMaterial3Api
import androidx.tv.material3.FilterChip
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import androidx.tv.material3.darkColorScheme

private val Accent = Color(0xFF8B7CFF)
private val Gold = Color(0xFFFFC94D)
private val Bg = Color(0xFF0B0B12)

@Composable
fun TvGamesTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Accent,
            onPrimary = Color.White,
            surface = Color(0xFF1A1A26),
            onSurface = Color.White,
            background = Bg,
        ),
        content = content,
    )
}

private const val ALL = "Todos"
private const val APPS = "Apps"

@Composable
fun TvGamesScreen(
    state: UiState,
    launching: GameEntry?,
    message: String?,
    onRetry: () -> Unit,
    onPlay: (GameEntry) -> Unit,
) {
    Box(Modifier.fillMaxSize().background(Bg)) {
        when (state) {
            UiState.Loading -> Centered { Text("Procurando o PC…", style = MaterialTheme.typography.titleLarge, color = Color.White) }
            is UiState.Error -> ErrorView(state.message, onRetry)
            is UiState.Ready -> LibraryView(state.library, onPlay)
        }
        if (launching != null) LaunchingOverlay(launching)
        if (message != null) {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.BottomCenter) {
                Text(
                    message,
                    color = Color.White,
                    modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(Color(0xE6B3261E)).padding(horizontal = 20.dp, vertical = 12.dp),
                )
            }
        }
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun ErrorView(message: String, onRetry: () -> Unit) {
    val focus = remember { FocusRequester() }
    Centered {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Não encontrei o PC", style = MaterialTheme.typography.headlineSmall, color = Color.White)
            Text(
                "Verifique se o PC está ligado e se o serviço tvgames-serve está rodando.\n($message)",
                color = Color(0xFFB8B8C8),
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(8.dp))
            Button(onClick = onRetry, modifier = Modifier.focusRequester(focus)) { Text("Tentar de novo") }
        }
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

@Composable
private fun LaunchingOverlay(game: GameEntry) {
    Box(Modifier.fillMaxSize().background(Color(0xCC000000)), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Abrindo", color = Color(0xFFB8B8C8), style = MaterialTheme.typography.titleMedium)
            Text(game.title, color = Color.White, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun LibraryView(library: Library, onPlay: (GameEntry) -> Unit) {
    val games = library.games.filter { !it.launcher }
    val apps = library.games.filter { it.launcher }
    val filters = buildList {
        add(ALL)
        addAll(games.map { it.category }.distinct().sorted())
        if (apps.isNotEmpty()) add(APPS)
    }
    var filter by rememberSaveable { mutableStateOf(ALL) }
    if (filter !in filters) filter = ALL
    val shown = when (filter) {
        ALL -> games
        APPS -> apps
        else -> games.filter { it.category == filter }
    }
    var focused by remember { mutableStateOf<GameEntry?>(null) }
    val hero = focused ?: shown.firstOrNull()
    val firstCard = remember { FocusRequester() }

    Box(Modifier.fillMaxSize()) {
        Backdrop(hero?.cover)
        Column(Modifier.fillMaxSize().padding(start = 40.dp, end = 40.dp, top = 24.dp)) {
            Header(library)
            Spacer(Modifier.height(10.dp))
            Hero(hero)
            Spacer(Modifier.height(12.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 4.dp)) {
                items(filters) { f ->
                    FilterChip(
                        selected = f == filter,
                        onClick = { filter = f },
                        modifier = Modifier.onFocusChanged { if (it.isFocused) filter = f },
                    ) { Text(f) }
                }
            }
            Spacer(Modifier.height(8.dp))
            if (shown.isEmpty()) {
                Text("Nada aqui ainda. Rode `tvgames sync` no PC.", color = Color(0xFFB8B8C8))
            }
            LazyVerticalGrid(
                columns = GridCells.Fixed(7),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                contentPadding = PaddingValues(top = 10.dp, bottom = 32.dp, start = 4.dp, end = 4.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                itemsIndexed(shown, key = { _, g -> g.id }) { i, game ->
                    GameCard(
                        game = game,
                        modifier = if (i == 0) Modifier.focusRequester(firstCard) else Modifier,
                        onFocus = { focused = game },
                        onClick = { onPlay(game) },
                    )
                }
            }
        }
    }
    LaunchedEffect(library.baseUrl) { runCatching { firstCard.requestFocus() } }
}

@Composable
private fun Header(library: Library) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("TV", color = Accent, fontWeight = FontWeight.Black, fontSize = 22.sp)
        Text("Games", color = Color.White, fontWeight = FontWeight.Black, fontSize = 22.sp)
        Spacer(Modifier.weight(1f))
        library.profile?.let { p ->
            val avatar = rememberCover(p.avatar, sampleSize = 1)
            if (avatar != null) {
                Image(avatar, contentDescription = p.user, modifier = Modifier.size(24.dp).clip(CircleShape))
                Spacer(Modifier.width(8.dp))
            }
            Text(p.user, color = Color.White, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(8.dp))
            Text("🏆 ${p.points + p.softcorePoints} pts", color = Gold, style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.width(20.dp))
        }
        Box(Modifier.size(8.dp).clip(CircleShape).background(Color(0xFF3DDC84)))
        Spacer(Modifier.width(6.dp))
        Text(library.host.name.uppercase(), color = Color(0xFFB8B8C8), style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun Hero(game: GameEntry?) {
    AnimatedContent(targetState = game, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "hero") { g ->
        Column(Modifier.fillMaxWidth().height(if (g?.achievements != null) 132.dp else 96.dp)) {
            if (g != null) {
                Text(g.category.uppercase(), color = Accent, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                Text(
                    g.title,
                    color = Color.White,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    g.tags.take(4).forEach { tag ->
                        Text(
                            tag,
                            color = Color(0xFFDADAE6),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(Color(0x33FFFFFF)).padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                }
                g.achievements?.let { AchievementsRow(it) }
            }
        }
    }
}

@Composable
private fun AchievementsRow(a: Achievements) {
    Spacer(Modifier.height(10.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(160.dp).height(6.dp).clip(RoundedCornerShape(3.dp)).background(Color(0x33FFFFFF))) {
            Box(
                Modifier.fillMaxWidth(a.percent / 100f).height(6.dp).clip(RoundedCornerShape(3.dp))
                    .background(if (a.earned == a.total) Gold else Accent),
            )
        }
        Spacer(Modifier.width(10.dp))
        Text(
            "🏆 ${a.earned}/${a.total} conquistas · ${a.percent}%",
            color = Color(0xFFDADAE6),
            style = MaterialTheme.typography.labelMedium,
        )
        Spacer(Modifier.width(14.dp))
        a.badges.take(8).forEach { b ->
            val img = rememberCover(b.url, sampleSize = 1)
            Box(
                Modifier.padding(end = 6.dp).size(26.dp).clip(RoundedCornerShape(4.dp)).background(Color(0x22FFFFFF)),
            ) {
                if (img != null) {
                    Image(img, contentDescription = b.title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
            }
        }
    }
}

@Composable
private fun Backdrop(cover: String?) {
    val image = rememberCover(cover)
    Box(Modifier.fillMaxSize()) {
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                alpha = 0.55f,
                modifier = Modifier.fillMaxSize().blur(36.dp),
            )
        }
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(0f to Color(0x66000000), 0.45f to Color(0xCC0B0B12), 1f to Bg),
            ),
        )
    }
}

@Composable
private fun GameCard(game: GameEntry, modifier: Modifier, onFocus: () -> Unit, onClick: () -> Unit) {
    Column(modifier) {
        Card(
            onClick = onClick,
            modifier = Modifier.fillMaxWidth().aspectRatio(3f / 4f).onFocusChanged { if (it.isFocused) onFocus() },
            shape = CardDefaults.shape(RoundedCornerShape(10.dp)),
            scale = CardDefaults.scale(focusedScale = 1.08f),
            border = CardDefaults.border(
                focusedBorder = Border(BorderStroke(3.dp, Color.White), shape = RoundedCornerShape(10.dp)),
            ),
        ) {
            Box(Modifier.fillMaxSize()) {
                val image = rememberCover(game.cover)
                if (image != null) {
                    Image(image, contentDescription = game.title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                } else {
                    Placeholder(game)
                }
                game.achievements?.let { a ->
                    val done = a.total > 0 && a.earned == a.total
                    Text(
                        if (done) "🏆 100%" else "🏆 ${a.earned}/${a.total}",
                        color = if (done) Color.Black else Color.White,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.align(Alignment.BottomEnd).padding(5.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(if (done) Gold else Color(0xCC000000))
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(
            game.title,
            color = Color(0xFFE6E6F0),
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun Placeholder(game: GameEntry) {
    Box(
        Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFF2A2350), Color(0xFF14121F)))),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            game.title,
            color = Color.White,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(10.dp),
        )
    }
}

@Composable
private fun rememberCover(url: String?, sampleSize: Int = 2): ImageBitmap? {
    val image by produceState(initialValue = url?.let { Covers.cached(it) }, url) {
        value = url?.let { Covers.cached(it) ?: Covers.load(it, sampleSize) }
    }
    return image
}
