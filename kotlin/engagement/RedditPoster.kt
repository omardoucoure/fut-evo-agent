package com.futevolution.evo.engagement

import com.futevolution.evo.config.EvoConfig
import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.request.forms.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.serialization.json.*
import org.slf4j.LoggerFactory
import java.sql.Connection
import java.time.Instant
import java.util.Base64

data class PostResult(
    val success: Boolean,
    val commentId: String? = null,
    val error: String? = null,
)

/**
 * Posts approved replies via Reddit OAuth2 API.
 * Uses a regular user "script" app (not a bot account).
 */
class RedditPoster(
    private val config: EvoConfig,
    private val dbConnection: Connection,
    private val httpClient: HttpClient,
) {
    private val log = LoggerFactory.getLogger(RedditPoster::class.java)
    private val json = Json { ignoreUnknownKeys = true }

    private var accessToken: String? = null
    private var tokenExpiresAt: Long = 0

    /**
     * Post a single approved reply by queue ID.
     */
    suspend fun postReply(queueId: Long): PostResult {
        // Check daily limit
        if (!canPostToday()) {
            return PostResult(false, error = "Daily comment limit reached")
        }

        // Get the approved draft
        val draft = getDraft(queueId) ?: return PostResult(false, error = "Draft not found or not approved")

        // Ensure valid OAuth token
        ensureValidToken()
        val token = accessToken ?: return PostResult(false, error = "Could not obtain Reddit access token")

        // Post comment
        return try {
            val replyText = draft.editedReply ?: draft.draftReply
            val commentId = submitComment(draft.postId, replyText, token)

            // Update queue status
            markAsPosted(queueId, commentId)
            incrementDailyCount()

            log.info("Posted reply to r/${draft.subreddit} post ${draft.postId} → comment $commentId")
            PostResult(true, commentId)
        } catch (e: Exception) {
            log.error("Failed to post reply for queue $queueId: ${e.message}")
            markAsFailed(queueId, e.message ?: "Unknown error")
            PostResult(false, error = e.message)
        }
    }

    /**
     * Post all approved replies that haven't been posted yet.
     * Respects daily limit.
     */
    suspend fun postApprovedReplies(): Int {
        val approved = getApprovedDrafts()
        if (approved.isEmpty()) return 0

        var posted = 0
        for (queueId in approved) {
            if (!canPostToday()) break
            val result = postReply(queueId)
            if (result.success) posted++
            // Natural delay between posts (30-60 seconds)
            kotlinx.coroutines.delay((30_000L..60_000L).random())
        }
        return posted
    }

    /**
     * Poll engagement metrics for previously posted comments.
     */
    suspend fun updateEngagementMetrics(): Int {
        ensureValidToken()
        val token = accessToken ?: return 0

        val postedComments = getPostedComments()
        var updated = 0

        for ((queueId, commentId) in postedComments) {
            try {
                val metrics = fetchCommentMetrics(commentId, token)
                if (metrics != null) {
                    saveMetrics(queueId, commentId, metrics)
                    updated++
                }
            } catch (e: Exception) {
                log.debug("Could not fetch metrics for comment $commentId: ${e.message}")
            }
        }
        return updated
    }

    fun getPostedTodayCount(): Int {
        val stmt = dbConnection.prepareStatement(
            "SELECT comments_posted FROM reddit_daily_limits WHERE date = CURRENT_DATE"
        )
        val rs = stmt.executeQuery()
        val count = if (rs.next()) rs.getInt("comments_posted") else 0
        rs.close()
        stmt.close()
        return count
    }

    fun getPendingCount(): Int {
        val stmt = dbConnection.prepareStatement(
            "SELECT COUNT(*) FROM reddit_comment_queue WHERE status = 'pending'"
        )
        val rs = stmt.executeQuery()
        val count = if (rs.next()) rs.getInt(1) else 0
        rs.close()
        stmt.close()
        return count
    }

    // ── OAuth2 Token Management ──

    private suspend fun ensureValidToken() {
        if (accessToken != null && Instant.now().epochSecond < tokenExpiresAt - 60) return

        // Try loading from DB first
        val dbToken = loadTokenFromDb()
        if (dbToken != null && Instant.now().epochSecond < dbToken.second - 60) {
            accessToken = dbToken.first
            tokenExpiresAt = dbToken.second
            return
        }

        // Request new token
        refreshAccessToken()
    }

    private suspend fun refreshAccessToken() {
        if (config.redditClientId.isBlank() || config.redditUsername.isBlank()) {
            log.error("Reddit credentials not configured")
            return
        }

        val credentials = Base64.getEncoder().encodeToString(
            "${config.redditClientId}:${config.redditClientSecret}".toByteArray()
        )

        val resp = httpClient.submitForm(
            url = "https://www.reddit.com/api/v1/access_token",
            formParameters = parameters {
                append("grant_type", "password")
                append("username", config.redditUsername)
                append("password", config.redditPassword)
            }
        ) {
            header("Authorization", "Basic $credentials")
            header("User-Agent", config.redditUserAgent)
        }

        if (resp.status != HttpStatusCode.OK) {
            log.error("Reddit OAuth failed: ${resp.status} — ${resp.bodyAsText()}")
            return
        }

        val body = json.parseToJsonElement(resp.bodyAsText()).jsonObject
        val token = body["access_token"]?.jsonPrimitive?.content
        val expiresIn = body["expires_in"]?.jsonPrimitive?.intOrNull ?: 3600

        if (token != null) {
            accessToken = token
            tokenExpiresAt = Instant.now().epochSecond + expiresIn
            saveTokenToDb(token, tokenExpiresAt)
            log.info("Reddit OAuth token refreshed (expires in ${expiresIn}s)")
        }
    }

    // ── Reddit API Calls ──

    private suspend fun submitComment(postId: String, text: String, token: String): String {
        val resp = httpClient.submitForm(
            url = "https://oauth.reddit.com/api/comment",
            formParameters = parameters {
                append("thing_id", "t3_$postId")
                append("text", text)
            }
        ) {
            header("Authorization", "Bearer $token")
            header("User-Agent", config.redditUserAgent)
        }

        if (resp.status != HttpStatusCode.OK) {
            throw Exception("Reddit comment API returned ${resp.status}: ${resp.bodyAsText().take(200)}")
        }

        val body = json.parseToJsonElement(resp.bodyAsText()).jsonObject
        // Reddit returns the comment data in jquery format or JSON
        val commentData = body["json"]?.jsonObject?.get("data")?.jsonObject
            ?.get("things")?.jsonArray?.firstOrNull()?.jsonObject
            ?.get("data")?.jsonObject
        val commentId = commentData?.get("id")?.jsonPrimitive?.content
            ?: commentData?.get("name")?.jsonPrimitive?.content?.removePrefix("t1_")
            ?: "unknown"

        return commentId
    }

    private suspend fun fetchCommentMetrics(commentId: String, token: String): CommentMetrics? {
        val resp = httpClient.get("https://oauth.reddit.com/api/info") {
            parameter("id", "t1_$commentId")
            header("Authorization", "Bearer $token")
            header("User-Agent", config.redditUserAgent)
        }

        if (resp.status != HttpStatusCode.OK) return null

        val body = json.parseToJsonElement(resp.bodyAsText()).jsonObject
        val children = body["data"]?.jsonObject?.get("children")?.jsonArray
        val comment = children?.firstOrNull()?.jsonObject?.get("data")?.jsonObject ?: return null

        return CommentMetrics(
            score = comment["score"]?.jsonPrimitive?.intOrNull ?: 0,
            ups = comment["ups"]?.jsonPrimitive?.intOrNull ?: 0,
            downs = comment["downs"]?.jsonPrimitive?.intOrNull ?: 0,
            replies = comment["num_comments"]?.jsonPrimitive?.intOrNull ?: 0,
            controversial = comment["controversiality"]?.jsonPrimitive?.intOrNull == 1,
            removed = comment["removed"]?.jsonPrimitive?.booleanOrNull ?: false
                || comment["body"]?.jsonPrimitive?.content == "[removed]",
        )
    }

    // ── Database Helpers ──

    private data class DraftInfo(
        val postId: String,
        val subreddit: String,
        val draftReply: String,
        val editedReply: String?,
    )

    private data class CommentMetrics(
        val score: Int,
        val ups: Int,
        val downs: Int,
        val replies: Int,
        val controversial: Boolean,
        val removed: Boolean,
    )

    private fun getDraft(queueId: Long): DraftInfo? {
        val stmt = dbConnection.prepareStatement(
            """SELECT reddit_post_id, subreddit, draft_reply, edited_reply
               FROM reddit_comment_queue WHERE id = ? AND status = 'approved'"""
        )
        stmt.setLong(1, queueId)
        val rs = stmt.executeQuery()
        val result = if (rs.next()) DraftInfo(
            postId = rs.getString("reddit_post_id"),
            subreddit = rs.getString("subreddit"),
            draftReply = rs.getString("draft_reply"),
            editedReply = rs.getString("edited_reply"),
        ) else null
        rs.close()
        stmt.close()
        return result
    }

    private fun getApprovedDrafts(): List<Long> {
        val stmt = dbConnection.prepareStatement(
            "SELECT id FROM reddit_comment_queue WHERE status = 'approved' ORDER BY created_at ASC LIMIT 5"
        )
        val rs = stmt.executeQuery()
        val ids = mutableListOf<Long>()
        while (rs.next()) ids.add(rs.getLong("id"))
        rs.close()
        stmt.close()
        return ids
    }

    private fun getPostedComments(): List<Pair<Long, String>> {
        val stmt = dbConnection.prepareStatement(
            """SELECT id, reddit_comment_id FROM reddit_comment_queue
               WHERE status = 'posted' AND reddit_comment_id IS NOT NULL
               AND posted_at > NOW() - INTERVAL '7 days'
               ORDER BY posted_at DESC LIMIT 20"""
        )
        val rs = stmt.executeQuery()
        val results = mutableListOf<Pair<Long, String>>()
        while (rs.next()) results.add(rs.getLong("id") to rs.getString("reddit_comment_id"))
        rs.close()
        stmt.close()
        return results
    }

    private fun markAsPosted(queueId: Long, commentId: String) {
        val stmt = dbConnection.prepareStatement(
            """UPDATE reddit_comment_queue
               SET status = 'posted', reddit_comment_id = ?, posted_at = NOW(), updated_at = NOW()
               WHERE id = ?"""
        )
        stmt.setString(1, commentId)
        stmt.setLong(2, queueId)
        stmt.executeUpdate()
        stmt.close()
    }

    private fun markAsFailed(queueId: Long, error: String) {
        val stmt = dbConnection.prepareStatement(
            """UPDATE reddit_comment_queue
               SET status = 'failed', post_error = ?, updated_at = NOW()
               WHERE id = ?"""
        )
        stmt.setString(1, error.take(500))
        stmt.setLong(2, queueId)
        stmt.executeUpdate()
        stmt.close()
    }

    private fun canPostToday(): Boolean {
        return getPostedTodayCount() < config.redditMaxDailyComments
    }

    private fun incrementDailyCount() {
        val stmt = dbConnection.prepareStatement(
            """INSERT INTO reddit_daily_limits (date, comments_posted) VALUES (CURRENT_DATE, 1)
               ON CONFLICT (date) DO UPDATE SET comments_posted = reddit_daily_limits.comments_posted + 1"""
        )
        stmt.executeUpdate()
        stmt.close()
    }

    private fun loadTokenFromDb(): Pair<String, Long>? {
        val stmt = dbConnection.prepareStatement(
            "SELECT access_token, EXTRACT(EPOCH FROM token_expires_at)::BIGINT as expires FROM reddit_credentials LIMIT 1"
        )
        val rs = stmt.executeQuery()
        val result = if (rs.next()) rs.getString("access_token") to rs.getLong("expires") else null
        rs.close()
        stmt.close()
        return result
    }

    private fun saveTokenToDb(token: String, expiresAt: Long) {
        val stmt = dbConnection.prepareStatement(
            """INSERT INTO reddit_credentials (id, username, access_token, refresh_token, token_expires_at, client_id, client_secret, user_agent)
               VALUES (1, ?, ?, '', TO_TIMESTAMP(?), ?, ?, ?)
               ON CONFLICT (id) DO UPDATE SET
                   access_token = EXCLUDED.access_token,
                   token_expires_at = EXCLUDED.token_expires_at,
                   updated_at = NOW()"""
        )
        stmt.setString(1, config.redditUsername)
        stmt.setString(2, token)
        stmt.setLong(3, expiresAt)
        stmt.setString(4, config.redditClientId)
        stmt.setString(5, config.redditClientSecret)
        stmt.setString(6, config.redditUserAgent)
        stmt.executeUpdate()
        stmt.close()
    }

    private fun saveMetrics(queueId: Long, commentId: String, metrics: CommentMetrics) {
        val stmt = dbConnection.prepareStatement(
            """INSERT INTO reddit_engagement_metrics
               (comment_queue_id, reddit_comment_id, upvotes, downvotes, score, reply_count, is_controversial, was_removed)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)"""
        )
        stmt.setLong(1, queueId)
        stmt.setString(2, commentId)
        stmt.setInt(3, metrics.ups)
        stmt.setInt(4, metrics.downs)
        stmt.setInt(5, metrics.score)
        stmt.setInt(6, metrics.replies)
        stmt.setBoolean(7, metrics.controversial)
        stmt.setBoolean(8, metrics.removed)
        stmt.executeUpdate()
        stmt.close()

        // Log warning if negative or removed
        if (metrics.score < -2 || metrics.removed) {
            log.warn("Comment $commentId flagged: score=${metrics.score} removed=${metrics.removed}")
        }
    }
}
