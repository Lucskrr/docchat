import { isDocId } from "@/lib/core/model";
import { getMeta, publicMeta } from "@/lib/server/documents";
import { jsonError } from "@/lib/server/http";

/** Status do processamento do documento (o navegador consulta até ficar READY ou ERROR). */
export async function GET(_request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  const { id } = await ctx.params;
  if (!isDocId(id)) return jsonError(400, "id inválido");

  const meta = await getMeta(id);
  if (!meta) return jsonError(404, "documento não encontrado ou expirado");
  return Response.json(publicMeta(meta), { headers: { "Cache-Control": "no-store" } });
}
