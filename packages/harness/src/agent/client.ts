import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export type ModelMessage = BetaMessage;
export type ModelParams = BetaMessageStreamParams;

/** The one call the loop makes, so a test can hand in a scripted fake. The real `new Anthropic()` fits. */
export interface ModelClient {
  beta: { messages: { stream(params: ModelParams): { finalMessage(): Promise<ModelMessage> } } };
}
