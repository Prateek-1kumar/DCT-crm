import { z } from "zod";

const WHO = "Say who is doing this: pick your name first.";

/** The person a write is recorded against: the "acting as" name the web sends (no login yet; see config listenHost). */
export const By = z.string({ error: WHO }).trim().min(1, { error: WHO }).max(100);
