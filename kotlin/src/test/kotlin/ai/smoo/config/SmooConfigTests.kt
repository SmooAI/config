package ai.smoo.config

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/** Twin of the Swift SmooConfigTests — same parity rows, Ktor MockEngine. */
class SmooConfigTests {
    private lateinit var tempDir: File
    private var lastAuthHeader: String? = null

    // Canned responses keyed by path suffix, mirroring the app's stub pattern.
    private var handlers: List<Triple<String, HttpStatusCode, String>> = emptyList()

    @BeforeTest
    fun setUp() {
        tempDir = File.createTempFile("smooai-config-test", "").apply {
            delete()
            mkdirs()
        }
        handlers = emptyList()
        lastAuthHeader = null
    }

    @AfterTest
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    private fun engine() = MockEngine { request ->
        lastAuthHeader = request.headers["Authorization"]
        val path = request.url.encodedPath
        val handler = handlers.firstOrNull { path.endsWith(it.first) }
            ?: return@MockEngine respond("not stubbed", HttpStatusCode.ServiceUnavailable)
        respond(handler.third, handler.second, headersOf("Content-Type", "application/json"))
    }

    private fun writeBundle(jsonText: String): File =
        tempDir.resolve("smooai-config.json").apply { writeText(jsonText) }

    private fun makeConfig(bundle: String? = null, token: String? = "user-jwt") = SmooConfig(
        SmooConfigOptions(
            apiUrl = "https://api.example.test",
            environment = "production",
            bundledConfigFile = bundle?.let { writeBundle(it) },
            tokenProvider = token?.let { jwt -> suspend { jwt } },
            engine = engine(),
            cacheDir = tempDir,
        ),
    )

    // ── Public config ──

    @Test
    fun bundledPublicValue() {
        val config = makeConfig(bundle = """{"values":{"supabaseHost":"db.smoo.ai","retries":3}}""")
        assertEquals("db.smoo.ai", config.publicValue("supabaseHost")?.jsonPrimitive?.content)
        assertEquals("3", config.publicValue("retries")?.jsonPrimitive?.content)
        assertNull(config.publicValue("nope"))
    }

    @Test
    fun refreshedValuesWinOverBundle() = runTest {
        handlers = listOf(Triple("/config/app/values", HttpStatusCode.OK, """{"values":{"supabaseHost":"db2.smoo.ai"}}"""))
        val config = makeConfig(bundle = """{"values":{"supabaseHost":"db.smoo.ai"}}""")
        config.refreshPublicValues()
        assertEquals("db2.smoo.ai", config.publicValue("supabaseHost")?.jsonPrimitive?.content)
        assertEquals("Bearer user-jwt", lastAuthHeader)
    }

    @Test
    fun refreshFailureKeepsBundle() = runTest {
        handlers = listOf(Triple("/config/app/values", HttpStatusCode.InternalServerError, "{}"))
        val config = makeConfig(bundle = """{"values":{"supabaseHost":"db.smoo.ai"}}""")
        assertFailsWith<SmooConfigException> { config.refreshPublicValues() }
        assertEquals("db.smoo.ai", config.publicValue("supabaseHost")?.jsonPrimitive?.content)
    }

    // ── Feature flags ──

    @Test
    fun flagEvaluationLive() = runTest {
        handlers = listOf(
            Triple("/config/app/feature-flags/mobilePush/evaluate", HttpStatusCode.OK, """{"value":true,"source":"rollout","rolloutBucket":7}"""),
        )
        val config = makeConfig()
        assertTrue(config.evaluateFlag("mobilePush", mapOf("platform" to JsonPrimitive("ios")), default = false))
    }

    @Test
    fun flagFallsBackToCacheThenDefault() = runTest {
        // Live success populates the cache.
        handlers = listOf(Triple("/config/app/feature-flags/mobilePush/evaluate", HttpStatusCode.OK, """{"value":true,"source":"default"}"""))
        makeConfig().evaluateFlag("mobilePush", default = false)

        // Server down → cached value survives (fresh client, same cache dir).
        handlers = listOf(Triple("/config/app/feature-flags/mobilePush/evaluate", HttpStatusCode.InternalServerError, "{}"))
        val offline = makeConfig()
        assertTrue(offline.evaluateFlag("mobilePush", default = false))

        // Unknown key with server down → caller default.
        assertTrue(offline.evaluateFlag("neverSeen", default = true))
    }

    // ── Limits ──

    @Test
    fun limitEvaluationClamps() = runTest {
        handlers = listOf(
            Triple("/config/app/limits/syncInterval/evaluate", HttpStatusCode.OK, """{"value":600,"source":"rule","matchedRuleId":"r1"}"""),
        )
        val config = makeConfig()
        assertEquals(120.0, config.evaluateLimit("syncInterval", default = 30.0, min = 5.0, max = 120.0))
    }

    @Test
    fun limitDefaultWhenOffline() = runTest {
        val config = makeConfig()
        assertEquals(30.0, config.evaluateLimit("syncInterval", default = 30.0, min = 5.0, max = 120.0))
    }

    @Test
    fun limitStepSnapsBeforeClamp() = runTest {
        // 118 with step 25 snaps to 125 first, THEN clamps to max 120 — the
        // TS clampLimit / Rust clamp_limit order (ADR-066).
        handlers = listOf(Triple("/config/app/limits/syncInterval/evaluate", HttpStatusCode.OK, """{"value":118,"source":"rule"}"""))
        val config = makeConfig()
        assertEquals(120.0, config.evaluateLimit("syncInterval", default = 30.0, min = 5.0, max = 120.0, step = 25.0))

        // In-bounds snap: 47 with step 10 → 50.
        handlers = listOf(Triple("/config/app/limits/batchSize/evaluate", HttpStatusCode.OK, """{"value":47,"source":"raw"}"""))
        assertEquals(50.0, config.evaluateLimit("batchSize", default = 10.0, min = 0.0, max = 100.0, step = 10.0))
    }

    // ── Typed evaluate errors ──

    @Test
    fun evaluateThrowsTypedExceptions() = runTest {
        handlers = listOf(
            Triple("/config/app/feature-flags/missingFlag/evaluate", HttpStatusCode.NotFound, "{}"),
            Triple("/config/app/feature-flags/badContext/evaluate", HttpStatusCode.BadRequest, "{}"),
            Triple("/config/app/limits/missingLimit/evaluate", HttpStatusCode.NotFound, "{}"),
            Triple("/config/app/limits/brokenLimit/evaluate", HttpStatusCode.ServiceUnavailable, "{}"),
        )
        val config = makeConfig()

        assertEquals("missingFlag", assertFailsWith<FeatureFlagNotFoundException> { config.evaluateFlagValue("missingFlag") }.key)
        assertEquals("badContext", assertFailsWith<FeatureFlagContextException> { config.evaluateFlagValue("badContext") }.key)
        assertEquals("missingLimit", assertFailsWith<LimitNotFoundException> { config.evaluateLimitValue("missingLimit") }.key)
        val broken = assertFailsWith<LimitEvaluationException> { config.evaluateLimitValue("brokenLimit") }
        assertEquals(503, broken.statusCode)
    }

    @Test
    fun closeReleasesClient() {
        // Closeable contract (twin nit: the Ktor client used to leak).
        makeConfig().close()
    }
}
