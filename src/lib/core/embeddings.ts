import { LIMITS } from "./model";

/**
 * Embeddings com a API do Gemini, usados na ingestão (documentos) e no chat (pergunta).
 * O taskType diferente para documento e consulta melhora a qualidade da busca.
 */
export const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
const BATCH_SIZE = 100; // limite de textos por chamada da API

export type EmbedTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/**
 * O mínimo do cliente `GoogleGenAI` que este módulo usa. Tipado de forma estrutural para o
 * núcleo não depender do pacote (o app e a Lambda têm cada um a sua instalação).
 */
export interface EmbedClient {
  models: {
    embedContent(params: {
      model: string;
      contents: string[];
      config: { taskType: string; outputDimensionality: number };
    }): Promise<{ embeddings?: { values?: number[] }[] }>;
  };
}

export async function embedTexts(
  ai: EmbedClient,
  texts: string[],
  taskType: EmbedTask,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await withRetry(() =>
      ai.models.embedContent({
        model: EMBED_MODEL,
        contents: batch,
        config: { taskType, outputDimensionality: LIMITS.embeddingDimensions },
      }),
    );
    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== batch.length) {
      throw new Error(`API retornou ${embeddings.length} embeddings para ${batch.length} textos`);
    }
    for (const e of embeddings) {
      if (!e.values?.length) throw new Error("embedding vazio na resposta da API");
      vectors.push(e.values);
    }
  }
  return vectors;
}

/** Repete chamadas que falham por limite de taxa (429) ou erro temporário (5xx). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const retryable = status === 429 || (status !== undefined && status >= 500);
      if (!retryable || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}
