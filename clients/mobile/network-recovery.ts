import { CodeGenerator, type ConfigPlugin, withMainApplication } from "expo/config-plugins";

// Request cancellation leaves a dead HTTP/2 session pooled. Pings retire it within the recovery budget.
const setup = `    com.facebook.react.modules.network.OkHttpClientProvider.setOkHttpClientFactory {
      com.facebook.react.modules.network.OkHttpClientProvider.createClientBuilder(this)
        .pingInterval(5, java.util.concurrent.TimeUnit.SECONDS)
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
