/**
 * The pool Worker's runtime settings, read by its deployment and by the workerd tests.
 * `enable_request_signal` makes an incoming request's signal fire when its caller disconnects, so a
 * cell lets go of a call whose controller instance is gone. Only that flag: moving the date past
 * 2026-11-17 would also switch the module registry, pipeTo error propagation and cache-option
 * handling.
 */
export const poolWorkerCompatibility = {
  date: "2026-09-08",
  flags: ["nodejs_compat", "enable_request_signal"],
};
