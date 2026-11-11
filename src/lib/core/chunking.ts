/**
 * Divide o texto de cada página em trechos (chunks) com sobreposição.
 *
 * Por que por página: cada trecho guarda a página de origem, e a resposta do chat
 * pode citar "[p. 3]". A sobreposição evita cortar uma ideia ao meio entre dois trechos.
 */
export interface PageText {
  page: number;
  text: string;
}

export interface Chunk {
  index: number;
  page: number;
  text: string;
}

export interface ChunkOptions {
  /** Tamanho alvo de cada trecho, em caracteres. */
  size?: number;
  /** Quantos caracteres do fim de um trecho se repetem no início do próximo. */
  overlap?: number;
  /** Trechos menores que isso são descartados (rodapés, números de página soltos). */
  minLength?: number;
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/-\n(?=\p{Ll})/gu, "") // junta palavras hifenizadas na quebra de linha
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkPages(pages: PageText[], options: ChunkOptions = {}): Chunk[] {
  const size = options.size ?? 1200;
  const overlap = options.overlap ?? 200;
  const minLength = options.minLength ?? 40;
  if (overlap >= size) throw new Error("overlap precisa ser menor que size");

  const chunks: Chunk[] = [];
  for (const { page, text } of pages) {
    const clean = normalizeWhitespace(text);
    let start = 0;
    while (start < clean.length) {
      let end = Math.min(start + size, clean.length);
      if (end < clean.length) {
        // Prefere cortar no fim de um parágrafo ou frase dentro da segunda metade do trecho.
        const window = clean.slice(start + Math.floor(size / 2), end);
        const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "));
        if (cut !== -1) end = start + Math.floor(size / 2) + cut + 1;
      }
      const piece = clean.slice(start, end).trim();
      if (piece.length >= minLength) {
        chunks.push({ index: chunks.length, page, text: piece });
      }
      if (end >= clean.length) break;
      // Volta `overlap` caracteres e avança até o início da próxima palavra.
      let next = Math.max(end - overlap, start + 1);
      const boundary = clean.slice(next, end).search(/\s/);
      if (boundary !== -1) next += boundary + 1;
      start = next;
    }
  }
  return chunks;
}
