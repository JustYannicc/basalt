import { CodeGenerator, type ConfigPlugin, withMainApplication } from "expo/config-plugins";

// Request cancellation leaves a dead HTTP/2 session pooled. Pings retire it within the recovery budget.
const setup = `    com.facebook.react.modules.network.OkHttpClientProvider.setOkHttpClientFactory {
      val attempts = java.util.concurrent.ConcurrentHashMap<okhttp3.Call, java.util.concurrent.atomic.AtomicBoolean>()
      com.facebook.react.modules.network.OkHttpClientProvider.createClientBuilder(this)
        .pingInterval(5, java.util.concurrent.TimeUnit.SECONDS)
        .eventListenerFactory { call ->
          val headersStarted = java.util.concurrent.atomic.AtomicBoolean(false)
          attempts[call] = headersStarted
          object : okhttp3.EventListener() {
            override fun requestHeadersStart(call: okhttp3.Call) { headersStarted.set(true) }
            override fun callEnd(call: okhttp3.Call) { attempts.remove(call) }
            override fun callFailed(call: okhttp3.Call, failure: java.io.IOException) { attempts.remove(call) }
          }
        }
        .addInterceptor { chain ->
          // Capture once across all internal retries; a later DNS failure cannot erase an earlier send.
          val headersStarted = attempts[chain.call()]
          try {
            chain.proceed(chain.request())
          } catch (failure: java.io.IOException) {
            val cause = failure.cause
            val notConnected = failure is java.net.UnknownHostException ||
              failure is java.net.ConnectException || failure is java.net.NoRouteToHostException ||
              (failure is java.net.SocketException && cause is android.system.ErrnoException &&
                cause.errno in setOf(android.system.OsConstants.ENETDOWN, android.system.OsConstants.ENETUNREACH,
                  android.system.OsConstants.EHOSTUNREACH, android.system.OsConstants.ECONNREFUSED))
            if (headersStarted?.get() == false && notConnected && chain.request().method == "POST" &&
              chain.request().url.encodedPath == "/api/auth/oauth2/token") {
              // Expo drops native causes and codes but preserves this fixed exception message.
              throw java.io.IOException("SIGNALBOX_REFRESH_NOT_SENT", failure)
            }
            throw failure
          }
        }
        .build()
    }`;

const withNetworkRecovery: ConfigPlugin = (config) =>
  withMainApplication(config, (config) => {
    if (config.modResults.language !== "kt")
      throw new Error("The phone's network recovery requires a Kotlin MainApplication.");
    config.modResults.contents = CodeGenerator.mergeContents({
      src: config.modResults.contents,
      newSrc: setup,
      tag: "signalbox-network-recovery",
      anchor: /super\.onCreate\(\)/u,
      offset: 1,
      comment: "//",
    }).contents;
    return config;
  });

export default withNetworkRecovery;
