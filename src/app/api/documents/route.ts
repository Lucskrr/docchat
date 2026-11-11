import { z } from "zod";
import { createUpload } from "@/lib/server/documents";
import { jsonError } from "@/lib/server/http";

const body = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((n) => n.toLowerCase().endsWith(".pdf"), "o arquivo precisa ser .pdf"),
});

/** Cria o registro do documento e devolve a URL pré-assinada para o navegador enviar o PDF ao S3. */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "requisição inválida");

  try {
    const result = await createUpload(crypto.randomUUID(), parsed.data.fileName);
    return Response.json(result, { status: 201 });
  } catch (err) {
    console.error("createUpload falhou", err);
    return jsonError(500, "não foi possível iniciar o upload");
  }
}
