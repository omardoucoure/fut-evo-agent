package com.futevolution.evo.engagement

import com.futevolution.evo.config.EvoConfig
import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.serialization.json.*
import org.slf4j.LoggerFactory
import java.sql.Connection

data class PlayerRef(
    val eaId: Int,
    val name: String,
    val overall: Int,
    val position: String,
)

data class InsightData(
    val id: Long,
    val playerName: String,
    val content: String,
    val source: String,
    val sentiment: String?,
)

data class PlayerStats(
    val eaId: Int,
    val name: String,
    val overall: Int,
    val position: String,
    val pace: Int,
    val shooting: Int,
    val passing: Int,
    val dribbling: Int,
    val defending: Int,
    val physical: Int,
    val price: Int,
    val rarityName: String?,
)

data class DraftReply(
    val postId: String,
    val reply: String,
    val mentionsApp: Boolean,
    val playersReferenced: List<PlayerRef>,
    val insightsUsed: List<Long>,
    val promptTokens: Int,
)

/**
 * Drafts contextual replies using Ollama + community_insights + player DB.
 * Maintains a 7/10 app mention ratio.
 */
class ReplyDrafter(
    private val config: EvoConfig,
    private val dbConnection: Connection,
    private val httpClient: HttpClient,
) {
    private val log = LoggerFactory.getLogger(ReplyDrafter::class.java)
    private val json = Json { ignoreUnknownKeys = true }

    // Rolling counter for 7/10 mention ratio
    private var draftCounter = 0L

    companion object {
        private val MARKETING_BLACKLIST = listOf(
            "download", "app store", "play store", "google play",
            "check out our", "sign up", "free trial", "limited time",
            "subscribe", "premium", "pro version", "install",
        )
        private const val MIN_WORDS = 50
        private const val MAX_WORDS = 300
    }

    /**
     * Draft a reply for a Reddit candidate.
     * Returns null if the draft fails validation.
     */
    suspend fun draft(candidate: RedditCandidate, runId: Long): DraftReply? {
        val mentionApp = shouldMentionApp()
        draftCounter++

        // Extract player names from the post
        val playerMentions = extractPlayerMentions(candidate.title + " " + (candidate.body ?: ""))

        // Fetch relevant data
        val insights = if (playerMentions.isNotEmpty()) fetchInsights(playerMentions) else emptyList()
        val playerStats = if (playerMentions.isNotEmpty()) fetchPlayerStats(playerMentions) else emptyList()

        // Build prompt
        val prompt = buildPrompt(candidate, insights, playerStats, mentionApp)

        // Call Ollama
        val reply = callOllama(prompt) ?: return null

        // Validate
        if (!validateReply(reply)) {
            log.warn("Draft reply failed validation for post ${candidate.postId}")
            return null
        }

        val draft = DraftReply(
            postId = candidate.postId,
            reply = reply,
            mentionsApp = mentionApp,
            playersReferenced = playerStats.map { PlayerRef(it.eaId, it.name, it.overall, it.position) },
            insightsUsed = insights.map { it.id },
            promptTokens = prompt.length / 4, // rough estimate
        )

        // Save to queue
        saveDraft(candidate, draft, runId)

        return draft
    }

    private fun shouldMentionApp(): Boolean {
        return (draftCounter % 10) < 7
    }

    private fun buildPrompt(
        candidate: RedditCandidate,
        insights: List<InsightData>,
        players: List<PlayerStats>,
        mentionApp: Boolean,
    ): String {
        val playerDataSection = if (players.isNotEmpty()) {
            "PLAYER DATA (accurate stats):\n" + players.joinToString("\n") { p ->
                "- ${p.name} (${p.overall} OVR, ${p.position}): PAC ${p.pace} SHO ${p.shooting} PAS ${p.passing} DRI ${p.dribbling} DEF ${p.defending} PHY ${p.physical}" +
                    if (p.price > 0) " | ${p.price} coins" else ""
            }
        } else ""

        val insightSection = if (insights.isNotEmpty()) {
            "\nCOMMUNITY OPINIONS:\n" + insights.take(5).joinToString("\n") { i ->
                "- ${i.playerName}: ${i.content} (from ${i.source})"
            }
        } else ""

        val mentionRule = if (mentionApp) {
            """- Naturally mention futevolution.com as where you found this data.
  Example: "I checked on futevolution and [player] has a really high meta rating there"
  Example: "according to futevolution's meta ratings, [player] is tier S right now"
  Keep it brief and natural — one mention max."""
        } else {
            "- Do NOT mention any apps, websites, or tools. Pure gameplay advice only."
        }

        return """You are a helpful FIFA/FC Ultimate Team player on Reddit. You genuinely enjoy helping other players improve their squads. Write a reply to this Reddit post.

POST: "${candidate.title}" in r/${candidate.subreddit}
${candidate.body?.take(1000) ?: "(no body text)"}

$playerDataSection
$insightSection

RULES:
- Sound like a real person. Casual Reddit tone (lowercase ok, slang ok).
- Reference specific stats or community opinions to be genuinely helpful.
- 50-200 words.
- Never say "download", "app store", "check out", "sign up", "free trial".
$mentionRule
- Never claim to be AI or a bot. Use "imo", "from what I've seen" if unsure.
- If the post asks about a specific position, focus on that.
- Include concrete recommendations with player names and stats.

Write ONLY the reply text, nothing else."""
    }

    private fun extractPlayerMentions(text: String): List<String> {
        // Common player names to look for in posts
        // This is a simple approach — the Ollama could also be used for NER
        val commonNames = fetchKnownPlayerNames()
        val lowerText = text.lowercase()
        return commonNames.filter { name ->
            lowerText.contains(name.lowercase())
        }.take(5)
    }

    private fun fetchKnownPlayerNames(): List<String> {
        val names = mutableListOf<String>()
        val stmt = dbConnection.prepareStatement(
            """SELECT DISTINCT COALESCE(common_name, name) as player_name
               FROM players
               WHERE overall >= 84
               ORDER BY overall DESC
               LIMIT 500"""
        )
        val rs = stmt.executeQuery()
        while (rs.next()) {
            names.add(rs.getString("player_name"))
        }
        rs.close()
        stmt.close()
        return names
    }

    private fun fetchInsights(playerNames: List<String>): List<InsightData> {
        if (playerNames.isEmpty()) return emptyList()
        val placeholders = playerNames.joinToString(",") { "?" }
        val stmt = dbConnection.prepareStatement(
            """SELECT id, player_name, content, source, sentiment
               FROM community_insights
               WHERE LOWER(player_name) IN (${playerNames.joinToString(",") { "LOWER(?)" }})
               AND created_at > NOW() - INTERVAL '14 days'
               ORDER BY community_score DESC, created_at DESC
               LIMIT 10"""
        )
        playerNames.forEachIndexed { i, name -> stmt.setString(i + 1, name) }
        val rs = stmt.executeQuery()
        val results = mutableListOf<InsightData>()
        while (rs.next()) {
            results.add(InsightData(
                id = rs.getLong("id"),
                playerName = rs.getString("player_name"),
                content = rs.getString("content"),
                source = rs.getString("source"),
                sentiment = rs.getString("sentiment"),
            ))
        }
        rs.close()
        stmt.close()
        return results
    }

    private fun fetchPlayerStats(playerNames: List<String>): List<PlayerStats> {
        if (playerNames.isEmpty()) return emptyList()
        val stmt = dbConnection.prepareStatement(
            """SELECT ea_id, COALESCE(common_name, name) as name, overall, position,
                      face_pace, face_shooting, face_passing, face_dribbling,
                      face_defending, face_physicality, COALESCE(ps_price, 0) as price,
                      rarity_name
               FROM players
               WHERE LOWER(COALESCE(common_name, name)) IN (${playerNames.joinToString(",") { "LOWER(?)" }})
               ORDER BY overall DESC
               LIMIT 10"""
        )
        playerNames.forEachIndexed { i, name -> stmt.setString(i + 1, name) }
        val rs = stmt.executeQuery()
        val results = mutableListOf<PlayerStats>()
        while (rs.next()) {
            results.add(PlayerStats(
                eaId = rs.getInt("ea_id"),
                name = rs.getString("name"),
                overall = rs.getInt("overall"),
                position = rs.getString("position"),
                pace = rs.getInt("face_pace"),
                shooting = rs.getInt("face_shooting"),
                passing = rs.getInt("face_passing"),
                dribbling = rs.getInt("face_dribbling"),
                defending = rs.getInt("face_defending"),
                physical = rs.getInt("face_physicality"),
                price = rs.getInt("price"),
                rarityName = rs.getString("rarity_name"),
            ))
        }
        rs.close()
        stmt.close()
        return results
    }

    private suspend fun callOllama(prompt: String): String? {
        return try {
            val requestBody = buildJsonObject {
                put("model", config.ollamaModel)
                put("prompt", prompt)
                put("stream", false)
                putJsonObject("options") {
                    put("temperature", 0.8)
                    put("top_p", 0.9)
                    put("num_predict", 512)
                }
            }

            val resp = httpClient.post("${config.ollamaUrl}/api/generate") {
                contentType(ContentType.Application.Json)
                setBody(requestBody.toString())
            }

            if (resp.status != HttpStatusCode.OK) {
                log.error("Ollama returned ${resp.status}")
                return null
            }

            val result = json.parseToJsonElement(resp.bodyAsText()).jsonObject
            result["response"]?.jsonPrimitive?.content?.trim()
        } catch (e: Exception) {
            log.error("Ollama call failed: ${e.message}")
            null
        }
    }

    private fun validateReply(reply: String): Boolean {
        val wordCount = reply.split(Regex("\\s+")).size
        if (wordCount < MIN_WORDS) {
            log.debug("Reply too short: $wordCount words")
            return false
        }
        if (wordCount > MAX_WORDS) {
            log.debug("Reply too long: $wordCount words")
            return false
        }
        val lowerReply = reply.lowercase()
        for (phrase in MARKETING_BLACKLIST) {
            if (lowerReply.contains(phrase)) {
                log.debug("Reply contains blacklisted phrase: $phrase")
                return false
            }
        }
        // No ALL CAPS words (3+ chars)
        if (Regex("\\b[A-Z]{3,}\\b").containsMatchIn(reply)) {
            if (!reply.contains("CDM") && !reply.contains("CAM") && !reply.contains("OVR") &&
                !reply.contains("PAC") && !reply.contains("SHO") && !reply.contains("DEF") &&
                !reply.contains("PHY") && !reply.contains("DRI") && !reply.contains("SBC")) {
                log.debug("Reply contains ALL CAPS words")
                return false
            }
        }
        return true
    }

    private fun saveDraft(candidate: RedditCandidate, draft: DraftReply, runId: Long) {
        val stmt = dbConnection.prepareStatement(
            """INSERT INTO reddit_comment_queue
               (reddit_post_id, subreddit, post_title, post_body, post_url, post_author,
                post_score, post_created_at, post_flair,
                draft_reply, mentions_app, relevance_score,
                players_referenced, insights_used, run_id, prompt_tokens, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, TO_TIMESTAMP(?), ?, ?, ?, ?, ?::jsonb, ?, ?, ?, 'pending')
               ON CONFLICT (reddit_post_id) DO NOTHING"""
        )
        stmt.setString(1, candidate.postId)
        stmt.setString(2, candidate.subreddit)
        stmt.setString(3, candidate.title)
        stmt.setString(4, candidate.body)
        stmt.setString(5, candidate.url)
        stmt.setString(6, candidate.author)
        stmt.setInt(7, candidate.score)
        stmt.setLong(8, candidate.createdUtc)
        stmt.setString(9, candidate.flair)
        stmt.setString(10, draft.reply)
        stmt.setBoolean(11, draft.mentionsApp)
        stmt.setFloat(12, 1.0f) // Passed keyword filter = relevant
        stmt.setString(13, buildJsonArray {
            draft.playersReferenced.forEach { p ->
                addJsonObject {
                    put("ea_id", p.eaId)
                    put("name", p.name)
                    put("overall", p.overall)
                    put("position", p.position)
                }
            }
        }.toString())
        val insightsArray = dbConnection.createArrayOf("BIGINT", draft.insightsUsed.toTypedArray())
        stmt.setArray(14, insightsArray)
        stmt.setLong(15, runId)
        stmt.setInt(16, draft.promptTokens)
        stmt.executeUpdate()
        stmt.close()

        // Update daily limits
        val limitStmt = dbConnection.prepareStatement(
            """INSERT INTO reddit_daily_limits (date, drafts_created) VALUES (CURRENT_DATE, 1)
               ON CONFLICT (date) DO UPDATE SET drafts_created = reddit_daily_limits.drafts_created + 1"""
        )
        limitStmt.executeUpdate()
        limitStmt.close()

        log.info("Saved draft reply for post ${candidate.postId} (mentions_app=${ draft.mentionsApp})")
    }
}
