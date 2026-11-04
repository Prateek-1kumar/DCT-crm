interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// USD per million tokens
const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export function priceFor(model: string): Price {
  const price = PRICES[model];
  if (!price) throw new Error(`No price is known for the model "${model}", so its spend can't be limited. Add it to the price table first.`);
  return price;
}

export const usdFor = (p: Price, u: Usage) =>
  (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheWriteTokens * p.cacheWrite + u.cacheReadTokens * p.cacheRead) / 1e6;
