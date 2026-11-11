import { z } from "zod";
import { LIMITS, isDocId } from "@/lib/core/model";
import { embedTexts } from "@/lib/core/embeddings";
import { SYSTEM_INSTRUCTION, buildPrompt } from "@/lib/core/prompt";
import { topK } from "@/lib/core/vectors";
import { gemini } from "@/lib/server/clients";
import { getMeta, loadChunks } from "@/lib/server/documents";
import { env } from "@/lib/server/env";
import { jsonError } from "@/lib/server/http";

const body = z.object({
  docId: z.string().refine(isDocId, "id inválido"),
  question: z.string().trim().min(2).max(LIMITS.maxQuestionLength),
});

/** Score mínimo de similaridade para um trecho entrar no contexto. */
const MIN_SCORE = 0.3;

/**
 * RAG: gera o embedding da pergunta, recupera os trechos mais parecidos do documento
 * e envia ao Gemini como contexto. A resposta volta em streaming (texto puro);
 * as fontes usadas vão no cabeçalho x-sources.
 */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "requisição inválida");
  const { docId, question } = parsed.data;

  const meta = await getMeta(docId);
  if (!meta) return jsonError(404, "documento não encontrado ou expirado");
  if (meta.status !== "READY") return jsonError(409, "o documento ainda está sendo processado");

  const ai = gemini();
  const [chunks, [queryVector]] = await Promise.all([
    loadChunks(docId),
    embedTexts(ai, [question], "RETRIEVAL_QUERY"),
  ]);

  const best = topK(queryVector, chunks, (c) => c.vector, LIMITS.topK, MIN_SCORE);
  const sources = best.map(({ item, score }) => ({
    page: item.page,
    score: Number(score.toFixed(3)),
    preview: item.text.slice(0, 220),
  }));

  if (best.length === 0) {
    return new Response("Não encontrei no documento nenhum trecho relacionado a essa pergunta.", {
      headers: { "Content-Type": "text/plain; charset=utf-8", "x-sources": "%5B%5D" },
    });
  }

  const stream = await ai.models.generateContentStream({
    model: env().GEMINI_CHAT_MODEL,
    contents: buildPrompt(question, best.map((b) => b.item)),
    config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.2 },
  });

  const encoder = new TextEncoder();
  const body$ = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const part of stream) {
          if (part.text) controller.enqueue(encoder.encode(part.text));
        }
      } catch (err) {
        console.error("streaming do Gemini falhou", err);
        controller.enqueue(encoder.encode("\n\n[Erro ao gerar a resposta. Tente novamente.]"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body$, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "x-sources": encodeURIComponent(JSON.stringify(sources)),
    },
  });
}
