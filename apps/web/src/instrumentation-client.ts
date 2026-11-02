// Zod (inside @dct/shared) probes `new Function("")` once to choose its fast path. The CSP forbids eval, and the browser
// reports the probe as a violation even though zod catches it. `jitless` skips the probe (zod's advice for strict CSPs).
// Zod keeps its config on globalThis, so this needs no zod import and runs before any schema is built.
type ZodGlobal = { __zod_globalConfig?: { jitless?: boolean } };
((globalThis as ZodGlobal).__zod_globalConfig ??= {}).jitless = true;
