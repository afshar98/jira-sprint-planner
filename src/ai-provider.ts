export type StructuredGenerationRequest = {
  instructions: string;
  input: unknown;
  schemaName: string;
  schema: Record<string, unknown>;
};

export interface GenerationProvider {
  generateStructured(request: StructuredGenerationRequest): Promise<unknown>;
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

function extractResponseText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  throw new ProviderError("The AI response did not contain a draft. Please try again.");
}

export class OpenAIResponsesProvider implements GenerationProvider {
  async generateStructured(request: StructuredGenerationRequest): Promise<unknown> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ProviderError("Add OPENAI_API_KEY to .env before generating drafts.", 503);

    const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses").replace(/\/$/, "");
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 75_000);
    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          store: false,
          instructions: request.instructions,
          input: JSON.stringify(request.input),
          text: {
            format: {
              type: "json_schema",
              name: request.schemaName,
              strict: true,
              schema: request.schema,
            },
          },
        }),
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const message = data.error && typeof data.error === "object" && typeof (data.error as Record<string, unknown>).message === "string"
          ? String((data.error as Record<string, unknown>).message)
          : `The generation service returned ${response.status}. Check the API key and model configuration.`;
        throw new ProviderError(message, response.status);
      }
      return JSON.parse(extractResponseText(data));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new ProviderError("Draft generation timed out. Please try again.", 504);
      if (error instanceof SyntaxError) throw new ProviderError("The AI response could not be read. Please generate again.");
      throw new ProviderError("Could not reach the AI service. Check your connection and API configuration.");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const generationProvider: GenerationProvider = new OpenAIResponsesProvider();
