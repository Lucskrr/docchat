import "server-only";
import { z } from "zod";

/**
 * Variáveis de ambiente do servidor, validadas na primeira leitura.
 * Os nomes não começam com AWS_ porque o Amplify Hosting reserva esse prefixo.
 */
const schema = z.object({
  APP_REGION: z.string().min(1).default("sa-east-1"),
  DOCS_BUCKET: z.string().min(1, "DOCS_BUCKET não definido"),
  DOCS_TABLE: z.string().min(1, "DOCS_TABLE não definido"),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY não definido"),
  GEMINI_CHAT_MODEL: z.string().min(1).default("gemini-flash-latest"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`Configuração inválida:\n${issues.join("\n")}`);
    }
    cached = parsed.data;
  }
  return cached;
}
