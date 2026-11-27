export const nativeControlPath = "/native/v1/control";
export const nativeSessionPath = "/native/v1/session";
export const nativeSessionHeader = "x-basalt-native-session";
export const nativeModelHeader = "x-basalt-native-assertion";
export const nativeAuthenticationHeader = "x-basalt-native";
export const nativeControlPrefix = "sbn1";
export const nativeModelPrefix = "sbnm1";
// The pool Worker abandons the tools service's membership read after this long. The tools
// service derives its mirror budget from it, so the two cannot drift apart.
export const nativeMembershipReadTimeoutMs = 10_000;
