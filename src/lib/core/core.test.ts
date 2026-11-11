import { describe, expect, it } from "vitest";
import { chunkPages, normalizeWhitespace } from "./chunking";
import { cosineSimilarity, decodeVector, encodeVector, topK } from "./vectors";
import { buildPrompt } from "./prompt";
import { chunkSk, docIdFromKey, uploadKey } from "./model";

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `palavra${i}`).join(" ") + ".";

describe("chunkPages", () => {
  it("mantém a página de origem e numera os trechos em sequência", () => {
    const chunks = chunkPages([
      { page: 1, text: words(400) },
      { page: 2, text: words(50) },
    ]);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks.at(-1)!.page).toBe(2);
  });

  it("respeita o tamanho máximo e começa cada trecho numa palavra inteira", () => {
    const chunks = chunkPages([{ page: 1, text: words(600) }], { size: 500, overlap: 100 });
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(500);
      expect(c.text).toMatch(/^palavra\d+/);
    }
  });

  it("repete o fim de um trecho no início do próximo (sobreposição)", () => {
    const [a, b] = chunkPages([{ page: 1, text: words(300) }], { size: 400, overlap: 120 });
    const firstWordOfB = b.text.split(" ")[0];
    expect(a.text).toContain(firstWordOfB);
  });

  it("descarta páginas sem texto útil", () => {
    expect(chunkPages([{ page: 1, text: "  12  " }])).toEqual([]);
  });

  it("rejeita sobreposição maior que o trecho", () => {
    expect(() => chunkPages([], { size: 100, overlap: 100 })).toThrow();
  });
});

describe("normalizeWhitespace", () => {
  it("junta palavras hifenizadas e colapsa espaços", () => {
    expect(normalizeWhitespace("pro-\ncesso   de   dados\n\n\n\nfim")).toBe("processo de dados\n\nfim");
  });
});

describe("vetores", () => {
  it("codifica e decodifica Float32 sem perda relevante", () => {
    const v = [0.1, -0.5, 0.25, 1];
    const back = Array.from(decodeVector(encodeVector(v)));
    back.forEach((x, i) => expect(x).toBeCloseTo(v[i], 6));
  });

  it("decodifica fatias desalinhadas de um buffer maior", () => {
    const bytes = encodeVector([1, 2, 3]);
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes, 1);
    expect(Array.from(decodeVector(padded.subarray(1)))).toEqual([1, 2, 3]);
  });

  it("calcula similaridade de cosseno", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it("topK ordena pelo score e aplica o mínimo", () => {
    const items = [
      { id: "a", v: [1, 0] },
      { id: "b", v: [0.7, 0.7] },
      { id: "c", v: [0, 1] },
    ];
    const result = topK([1, 0], items, (i) => i.v, 2, 0.1);
    expect(result.map((r) => r.item.id)).toEqual(["a", "b"]);
  });
});

describe("prompt e chaves", () => {
  it("inclui a página de cada trecho e a pergunta", () => {
    const prompt = buildPrompt("  Qual o prazo? ", [{ page: 4, text: "O prazo é 30 dias." }]);
    expect(prompt).toContain('pagina="4"');
    expect(prompt).toContain("Pergunta: Qual o prazo?");
  });

  it("extrai o id do documento só de chaves válidas", () => {
    const id = "0b6f3f1e-6a3c-4c2e-9d8e-1f2a3b4c5d6e";
    expect(docIdFromKey(uploadKey(id))).toBe(id);
    expect(docIdFromKey("uploads/../segredo.pdf")).toBeNull();
    expect(docIdFromKey(`outra/${id}.pdf`)).toBeNull();
  });

  it("ordena trechos pela chave de ordenação", () => {
    expect(chunkSk(7) < chunkSk(12)).toBe(true);
  });
});
