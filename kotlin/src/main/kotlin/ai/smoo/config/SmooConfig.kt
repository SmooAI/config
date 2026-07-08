package ai.smoo.config

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.ktor.http.isSuccess
import java.io.File
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Result of a server-side flag/limit evaluation — mirrors
 * `EvaluateFeatureFlagResponse` in the TS reference implementation.
 */
@Serializable
public data class EvaluationResult(
    val value: JsonElement,
    val matchedRuleId: String? = null,
    val rolloutBucket: Int? = null,
    val source: String,
)

public class SmooConfigException(message: String, public val statusCode: Int? = null) : Exception(message)

/**
 * Options for [SmooConfig] — the mobile runtime mode of @smooai/config
 * (ADR-073, docs/Mobile-Runtime-Mode-Spec.md). Public config arrives via a
 * build-time-baked bundle plus an optional HTTP refresh; flags/limits are
 * always evaluated live against the app-config surface (`/config/app/...`)
 * with the end-user bearer token.
 *
 * @param bundledConfigFile baked public-config bundle (`{"values": {...}}`)
 *   shipped inside the app; null is allowed (tests) but production apps
 *   should always bundle one.
 * @param tokenProvider supplies the caller's bearer token (Supabase user
 *   JWT); flags/limits fall back to cached/default values when null.
 * @param engine caller-injected Ktor engine (Android.create() in the app,
 *   MockEngine in tests) — mirrors the consuming app's ApiClient seam.
 */
public class SmooConfigOptions(
    public val apiUrl: String = "https://api.smoo.ai",
    public val environment: String,
    public val bundledConfigFile: File? = null,
    public val tokenProvider: (suspend () -> String?)? = null,
    public val engine: HttpClientEngine,
    public val cacheDir: File? = null,
)

/**
 * Mobile runtime mode client (ADR-073, SMOODEV-2381) — the Kotlin twin of the
 * Swift `SmooConfig`. Read chains are offline-safe by construction:
 * - public config: baked bundle → http-refreshed cache → null
 * - feature flags / limits: http → last-cached value (disk) → caller default
 *
 * This client speaks the app-config surface (`/config/app/...`): the server
 * pins the evaluation org to the platform master org and serves ONLY
 * public-tier values — there is no secret access on this path by design.
 */
public class SmooConfig(private val options: SmooConfigOptions) {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = HttpClient(options.engine)
    private val cache = DiskCache(options.cacheDir, json)

    private val bundledValues: Map<String, JsonElement> =
        options.bundledConfigFile
            ?.takeIf { it.exists() }
            ?.let { runCatching { json.decodeFromString<ValuesResponse>(it.readText()).values }.getOrNull() }
            ?: emptyMap()

    @Volatile private var refreshedValues: Map<String, JsonElement>? = null

    @Serializable
    private data class ValuesResponse(val values: Map<String, JsonElement>)

    @Serializable
    private data class EvaluateRequest(val environment: String, val context: Map<String, JsonElement>)

    // ── Public config ────────────────────────────────────────────────────────

    /** Refreshed-or-cached map wins over the bundle; resolves offline. */
    public fun publicValue(key: String): JsonElement? {
        val refreshed = refreshedValues ?: cache.publicValues()
        return refreshed?.get(key) ?: bundledValues[key]
    }

    /**
     * Fetches current public values and persists them to the offline cache.
     * Failures throw; prior values remain intact.
     */
    public suspend fun refreshPublicValues() {
        val response = client.get("${options.apiUrl}/config/app/values") {
            parameter("environment", options.environment)
            bearer()
        }
        if (!response.status.isSuccess()) throw SmooConfigException("refresh failed", response.status.value)
        val decoded = json.decodeFromString<ValuesResponse>(response.bodyAsText())
        refreshedValues = decoded.values
        cache.storePublicValues(decoded.values)
    }

    // ── Feature flags ────────────────────────────────────────────────────────

    /** Full evaluation result; throws on network/auth failure. */
    public suspend fun evaluateFlagValue(key: String, context: Map<String, JsonElement> = emptyMap()): EvaluationResult =
        evaluate("feature-flags", key, context).also { cache.storeEvaluation("flag", key, it) }

    /** Offline-safe boolean read: live → last cached → default. Never throws. */
    public suspend fun evaluateFlag(key: String, context: Map<String, JsonElement> = emptyMap(), default: Boolean): Boolean {
        runCatching { evaluateFlagValue(key, context) }.getOrNull()?.value?.asBoolean()?.let { return it }
        cache.evaluation("flag", key)?.value?.asBoolean()?.let { return it }
        return default
    }

    // ── Limits ───────────────────────────────────────────────────────────────

    /** Full limit evaluation (raw number, pre-clamp); throws on failure. */
    public suspend fun evaluateLimitValue(key: String, context: Map<String, JsonElement> = emptyMap()): EvaluationResult =
        evaluate("limits", key, context).also { cache.storeEvaluation("limit", key, it) }

    /**
     * Offline-safe clamped read: live → cached → default, clamped to
     * `[min, max]` when provided (the client-side clamp from ADR-066).
     */
    public suspend fun evaluateLimit(
        key: String,
        context: Map<String, JsonElement> = emptyMap(),
        default: Double,
        min: Double? = null,
        max: Double? = null,
    ): Double {
        var value = runCatching { evaluateLimitValue(key, context) }.getOrNull()?.value?.asDouble()
            ?: cache.evaluation("limit", key)?.value?.asDouble()
            ?: default
        min?.let { value = maxOf(value, it) }
        max?.let { value = minOf(value, it) }
        return value
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────

    private suspend fun evaluate(kind: String, key: String, context: Map<String, JsonElement>): EvaluationResult {
        val response = client.post("${options.apiUrl}/config/app/$kind/${key.encodeURLPathPart()}/evaluate") {
            contentType(ContentType.Application.Json)
            bearer()
            setBody(json.encodeToString(EvaluateRequest.serializer(), EvaluateRequest(options.environment, context)))
        }
        if (!response.status.isSuccess()) throw SmooConfigException("evaluate failed", response.status.value)
        return json.decodeFromString(EvaluationResult.serializer(), response.bodyAsText())
    }

    private suspend fun HttpRequestBuilder.bearer() {
        options.tokenProvider?.invoke()?.let { header(HttpHeaders.Authorization, "Bearer $it") }
    }

    private fun JsonElement.asBoolean(): Boolean? = runCatching { jsonPrimitive.booleanOrNull }.getOrNull()
    private fun JsonElement.asDouble(): Double? = runCatching { jsonPrimitive.doubleOrNull }.getOrNull()
}

/**
 * Offline cache: last-known public values and last evaluation result per
 * flag/limit key. Plain JSON file — only PUBLIC-tier data ever flows through
 * this surface, so no encryption is needed (ADR-073).
 */
internal class DiskCache(directory: File?, private val json: Json) {
    @Serializable
    private data class Payload(
        @SerialName("publicValues") var publicValues: Map<String, JsonElement>? = null,
        @SerialName("evaluations") var evaluations: MutableMap<String, EvaluationResult> = mutableMapOf(),
    )

    private val file: File? = directory?.also { it.mkdirs() }?.resolve("smooai-config-cache.json")
    private var payload: Payload =
        file?.takeIf { it.exists() }
            ?.let { runCatching { json.decodeFromString<Payload>(it.readText()) }.getOrNull() }
            ?: Payload()

    fun publicValues(): Map<String, JsonElement>? = payload.publicValues

    @Synchronized
    fun storePublicValues(values: Map<String, JsonElement>) {
        payload.publicValues = values
        persist()
    }

    fun evaluation(kind: String, key: String): EvaluationResult? = payload.evaluations["$kind:$key"]

    @Synchronized
    fun storeEvaluation(kind: String, key: String, result: EvaluationResult) {
        payload.evaluations["$kind:$key"] = result
        persist()
    }

    private fun persist() {
        val target = file ?: return
        runCatching { target.writeText(json.encodeToString(Payload.serializer(), payload)) }
    }
}
