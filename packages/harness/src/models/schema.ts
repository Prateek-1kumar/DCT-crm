import { z } from "zod";
import { ModelError } from "./reader";

export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...json } = z.toJSONSchema(schema, {
    // zod bounds every integer to the safe-integer range; both providers' strict modes reject number bounds
    override: ({ jsonSchema }) => {
      delete jsonSchema.minimum;
      delete jsonSchema.maximum;
    },
  });
  return json;
}

export function parseAnswer<T>(name: string, text: string, schema: z.ZodType<T>, usd: number): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ModelError(`The model's answer for "${name}" wasn't valid JSON, so it was discarded.`, usd);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ModelError(`The model's answer for "${name}" didn't match the expected shape (${issue?.path.join(".") || "top level"}: ${issue?.message}), so it was discarded.`, usd);
  }
  return parsed.data;
}
