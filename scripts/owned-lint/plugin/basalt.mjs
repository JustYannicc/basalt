// Basalt's own Oxlint rules. Each one stops a shortcut that shipped a production failure:
// a value read from a provider echoed into a request, a strict decode of a provider response,
// an exact compare of a write with its read-back, and test stand-ins that agree with the code
// because they echo it or were written by hand. Syntactic only: Oxlint gives no type info.
import {
  noDirectCloudflareApi,
  noExactReadbackCompare,
  noSpreadIntoProviderRequest,
  noStrictProviderDecode,
} from "./provider.mjs";
import { noEchoStub, noHandwrittenProviderResponse } from "./stand-ins.mjs";
import { noDiscardedChildOutput, noNodeTestDoubles, noNodeTestFlakeMasking } from "./tests.mjs";

export default {
  meta: { name: "basalt" },
  rules: {
    "no-direct-cloudflare-api": noDirectCloudflareApi,
    "no-spread-into-provider-request": noSpreadIntoProviderRequest,
    "no-strict-provider-decode": noStrictProviderDecode,
    "no-exact-readback-compare": noExactReadbackCompare,
    "no-echo-stub": noEchoStub,
    "no-handwritten-provider-response": noHandwrittenProviderResponse,
    "no-discarded-child-output": noDiscardedChildOutput,
    "no-node-test-doubles": noNodeTestDoubles,
    "no-node-test-flake-masking": noNodeTestFlakeMasking,
  },
};
