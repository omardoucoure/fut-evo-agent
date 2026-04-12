package com.futevolution.evo.engagement

import com.futevolution.evo.config.EvoConfig
import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.serialization.json.*
import org.slf4j.LoggerFactory
import java.sql.Connection
import java.time.Instant

data class RedditCandidate(
    val postId: String,
    val subreddit: String,
    val title: String,
    val body: String?,
    val author: String,
    val score: Int,
    val commentCount: Int,
    val createdUtc: Long,
    val flair: String?,
    val url: String,
)

/**
 * Scans Reddit subreddits for squad-related posts that the agent can reply to.
 * Uses Reddit's public JSON API (no auth needed for reading).
 */
class RedditEngagementScanner(
    private val config: EvoConfig,
    private val dbConnection: Connection,
    private val httpClient: HttpClient,
) {
    private val log = LoggerFactory.getLogger(RedditEngagementScanner::class.java)
    private val json = Json { ignoreUnknownKeys = true }

    private val SQUAD_KEYWORDS = listOf(
        "squad", "upgrade", "who should i buy", "best player for",
        "formation", "chemistry", "budget", "coins", "replace",
        "what chem style", "worth it", "rate my team", "improvements",
        "suggestions", "who to buy", "better option", "meta",
        "best cdm", "best cb", "best st", "best cam", "best lw", "best rw",
        "help me", "team advice", "any upgrade", "weak link",
        "evolution", "evo", "which evo", "best evo",
    )

    /**
     * Scan configured subreddits for relevant posts.
     * Returns candidates sorted by relevance, filtered for duplicates.
     */
    suspend fun scan(): List<RedditCandidate> {
        val allCandidates = mutableListOf<RedditCandidate>()
        val processedIds = getProcessedPostIds()

        for (subreddit in config.redditSubreddits) {
            try {
                val posts = fetchNewPosts(subreddit)
                log.info("Reddit engagement: fetched ${posts.size} posts from r/$subreddit")

                for (post in posts) {
                    // Skip already processed
                    if (post.postId in processedIds) continue
                    // Skip own posts
                    if (post.author.equals(config.redditUsername, ignoreCase = true)) continue
                    // Skip old posts (>12h)
                    val ageHours = (Instant.now().epochSecond - post.createdUtc) / 3600
                    if (ageHours > config.redditPostMaxAgeHours) continue
                    // Skip low-score posts
                    if (post.score < config.redditMinPostScore) continue
                    // Keyword relevance check
                    if (matchesKeywords(post.title, post.body)) {
                        allCandidates.add(post)
                    }
                }
            } catch (e: Exception) {
                log.error("Reddit engagement scan failed for r/$subreddit: ${e.message}")
            }
        }

        log.info("Reddit engagement: ${allCandidates.size} candidates after filtering")
        return allCandidates.sortedByDescending { it.score }
    }

    private suspend fun fetchNewPosts(subreddit: String): List<RedditCandidate> {
        val resp = httpClient.get("https://www.reddit.com/r/$subreddit/new.json") {
            parameter("limit", 25)
            parameter("raw_json", 1)
            header("User-Agent", config.redditUserAgent)
        }

        if (resp.status != HttpStatusCode.OK) {
            log.warn("Reddit r/$subreddit returned ${resp.status}")
            return emptyList()
        }

        val root = json.parseToJsonElement(resp.bodyAsText()).jsonObject
        val children = root["data"]?.jsonObject?.get("children")?.jsonArray ?: return emptyList()

        return children.mapNotNull { child ->
            val data = child.jsonObject["data"]?.jsonObject ?: return@mapNotNull null
            val postId = data["id"]?.jsonPrimitive?.content ?: return@mapNotNull null
            val title = data["title"]?.jsonPrimitive?.content ?: return@mapNotNull null
            val selftext = data["selftext"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() }
            val author = data["author"]?.jsonPrimitive?.content ?: "[deleted]"
            val score = data["score"]?.jsonPrimitive?.intOrNull ?: 0
            val numComments = data["num_comments"]?.jsonPrimitive?.intOrNull ?: 0
            val createdUtc = data["created_utc"]?.jsonPrimitive?.doubleOrNull?.toLong() ?: 0L
            val flair = data["link_flair_text"]?.jsonPrimitive?.contentOrNull
            val permalink = data["permalink"]?.jsonPrimitive?.content ?: ""

            RedditCandidate(
                postId = postId,
                subreddit = subreddit,
                title = title,
                body = selftext,
                author = author,
                score = score,
                commentCount = numComments,
                createdUtc = createdUtc,
                flair = flair,
                url = "https://www.reddit.com$permalink",
            )
        }
    }

    private fun matchesKeywords(title: String, body: String?): Boolean {
        val text = (title + " " + (body ?: "")).lowercase()
        return SQUAD_KEYWORDS.any { keyword -> text.contains(keyword) }
    }

    /**
     * Get all post IDs already in the comment queue to avoid duplicates.
     */
    private fun getProcessedPostIds(): Set<String> {
        val ids = mutableSetOf<String>()
        val stmt = dbConnection.prepareStatement(
            "SELECT reddit_post_id FROM reddit_comment_queue"
        )
        val rs = stmt.executeQuery()
        while (rs.next()) {
            ids.add(rs.getString("reddit_post_id"))
        }
        rs.close()
        stmt.close()
        return ids
    }
}
