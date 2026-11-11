"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicDoc } from "@/lib/core/model";

const MAX_BYTES = 10 * 1024 * 1024;
const STORAGE_KEY = "docchat:docs";

interface Source {
  page: number;
  score: number;
  preview: string;
}

interface Message {
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
  error?: boolean;
}

/** Os documentos ficam só no navegador de quem enviou (não há listagem pública). */
function loadDocs(): PublicDoc[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveDocs(docs: PublicDoc[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
  } catch {
    /* modo privado ou armazenamento bloqueado: segue só em memória */
  }
}

const STATUS_LABEL: Record<PublicDoc["status"], string> = {
  PENDING: "Na fila",
  PROCESSING: "Processando",
  READY: "Pronto",
  ERROR: "Erro",
};

const STATUS_STYLE: Record<PublicDoc["status"], string> = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  PROCESSING: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  READY: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  ERROR: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
};

export function DocChat() {
  const [docs, setDocs] = useState<PublicDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = loadDocs();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- leitura única do localStorage após a hidratação
    setDocs(stored);
    setSelectedId(stored[0]?.docId ?? null);
  }, []);

  const updateDoc = useCallback((doc: PublicDoc) => {
    setDocs((prev) => {
      const next = prev.map((d) => (d.docId === doc.docId ? doc : d));
      saveDocs(next);
      return next;
    });
  }, []);

  const removeDoc = useCallback((docId: string) => {
    setDocs((prev) => {
      const next = prev.filter((d) => d.docId !== docId);
      saveDocs(next);
      return next;
    });
    setSelectedId((cur) => (cur === docId ? null : cur));
  }, []);

  // Consulta o status enquanto algum documento estiver na fila ou processando.
  const pending = docs.filter((d) => d.status === "PENDING" || d.status === "PROCESSING");
  const pendingKey = pending.map((d) => d.docId).join(",");
  useEffect(() => {
    if (!pendingKey) return;
    const timer = setInterval(async () => {
      for (const docId of pendingKey.split(",")) {
        const res = await fetch(`/api/documents/${docId}`, { cache: "no-store" }).catch(() => null);
        if (res?.status === 404) removeDoc(docId);
        else if (res?.ok) updateDoc(await res.json());
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [pendingKey, updateDoc, removeDoc]);

  const selected = docs.find((d) => d.docId === selectedId) ?? null;
  const thread = selected ? (messages[selected.docId] ?? []) : [];

  const lastText = thread.at(-1)?.text;
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread.length, lastText]);

  async function handleFile(file: File) {
    setUploadError(null);
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("Envie um arquivo PDF.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploadError("O arquivo passa de 10 MB.");
      return;
    }

    setUploading(true);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "falha ao iniciar o upload");

      // Envio direto ao S3 com o POST pré-assinado: o arquivo não passa pelo servidor do app.
      const form = new FormData();
      for (const [k, v] of Object.entries(data.upload.fields as Record<string, string>)) {
        form.append(k, v);
      }
      form.append("file", file);
      const s3 = await fetch(data.upload.url, { method: "POST", body: form });
      if (!s3.ok) throw new Error("o armazenamento recusou o arquivo");

      const doc = data.meta as PublicDoc;
      setDocs((prev) => {
        const next = [doc, ...prev];
        saveDocs(next);
        return next;
      });
      setSelectedId(doc.docId);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "falha no upload");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function appendToLast(docId: string, patch: (m: Message) => Message) {
    setMessages((prev) => {
      const list = [...(prev[docId] ?? [])];
      list[list.length - 1] = patch(list[list.length - 1]);
      return { ...prev, [docId]: list };
    });
  }

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || selected.status !== "READY" || asking) return;
    const q = question.trim();
    if (q.length < 2) return;

    const docId = selected.docId;
    setQuestion("");
    setAsking(true);
    setMessages((prev) => ({
      ...prev,
      [docId]: [...(prev[docId] ?? []), { role: "user", text: q }, { role: "assistant", text: "" }],
    }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, question: q }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "falha ao responder");
      }
      const sources = JSON.parse(decodeURIComponent(res.headers.get("x-sources") ?? "%5B%5D"));
      appendToLast(docId, (m) => ({ ...m, sources }));

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        appendToLast(docId, (m) => ({ ...m, text: m.text + text }));
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "falha ao responder";
      appendToLast(docId, (m) => ({ ...m, text: `Não consegui responder: ${text}.`, error: true }));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mx-auto flex h-dvh w-full max-w-6xl flex-col px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-2 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">DocChat</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Pergunte qualquer coisa sobre um PDF. Respostas com RAG (Gemini) e citação das páginas.
          </p>
        </div>
        <p className="text-xs text-zinc-400">Arquivos apagados automaticamente em 7 dias</p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        <aside className="flex shrink-0 flex-col gap-3 md:w-72">
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="rounded-lg border-2 border-dashed border-zinc-300 px-4 py-5 text-sm font-medium text-zinc-700 transition hover:border-indigo-400 hover:bg-indigo-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-indigo-950/40"
          >
            {uploading ? "Enviando…" : "+ Enviar PDF (até 10 MB)"}
          </button>
          {uploadError && <p className="text-sm text-rose-600 dark:text-rose-400">{uploadError}</p>}

          <ul className="flex gap-2 overflow-x-auto md:flex-col md:overflow-y-auto">
            {docs.map((d) => (
              <li key={d.docId} className="min-w-52 md:min-w-0">
                <button
                  type="button"
                  onClick={() => setSelectedId(d.docId)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                    d.docId === selectedId
                      ? "border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-950/40"
                      : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                  }`}
                >
                  <span className="block truncate font-medium">{d.fileName}</span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                    <span className={`rounded px-1.5 py-0.5 ${STATUS_STYLE[d.status]}`}>
                      {STATUS_LABEL[d.status]}
                    </span>
                    {d.status === "READY" && `${d.pages} pág. · ${d.chunks} trechos`}
                  </span>
                </button>
              </li>
            ))}
            {docs.length === 0 && (
              <li className="text-sm text-zinc-500">Nenhum documento ainda. Envie um PDF para começar.</li>
            )}
          </ul>
        </aside>

        <main className="flex min-h-0 flex-1 flex-col rounded-xl border border-zinc-200 dark:border-zinc-800">
          {!selected ? (
            <div className="m-auto max-w-sm p-6 text-center text-sm text-zinc-500">
              Envie um PDF (contrato, manual, artigo, edital…) e faça perguntas sobre ele.
            </div>
          ) : (
            <>
              <div className="flex-1 space-y-4 overflow-y-auto p-4">
                {selected.status === "ERROR" && (
                  <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                    Não foi possível processar este documento: {selected.error}
                  </p>
                )}
                {(selected.status === "PENDING" || selected.status === "PROCESSING") && (
                  <p className="animate-pulse text-sm text-zinc-500">
                    Lendo o PDF, dividindo em trechos e gerando embeddings…
                  </p>
                )}
                {selected.status === "READY" && thread.length === 0 && (
                  <p className="text-sm text-zinc-500">
                    Documento pronto. Pergunte, por exemplo: “Resuma os pontos principais”.
                  </p>
                )}
                {thread.map((m, i) => (
                  <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                    <div
                      className={
                        m.role === "user"
                          ? "max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2 text-sm text-white"
                          : `max-w-[95%] text-sm leading-relaxed ${m.error ? "text-rose-600 dark:text-rose-400" : ""}`
                      }
                    >
                      <p className="whitespace-pre-wrap">
                        {m.text || (asking && i === thread.length - 1 ? "…" : "")}
                      </p>
                      {m.sources && m.sources.length > 0 && (
                        <details className="mt-2 text-xs text-zinc-500">
                          <summary className="cursor-pointer select-none">
                            Fontes: {[...new Set(m.sources.map((s) => `p. ${s.page}`))].join(", ")}
                          </summary>
                          <ul className="mt-2 space-y-2">
                            {m.sources.map((s, j) => (
                              <li key={j} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
                                <span className="font-medium">p. {s.page}</span> · similaridade{" "}
                                {s.score.toFixed(2)}
                                <p className="mt-1 line-clamp-3">{s.preview}…</p>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={bottom} />
              </div>

              <form onSubmit={ask} className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  maxLength={1000}
                  disabled={selected.status !== "READY" || asking}
                  placeholder={
                    selected.status === "READY" ? "Pergunte sobre o documento…" : "Aguarde o processamento…"
                  }
                  className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-indigo-500 disabled:opacity-60 dark:border-zinc-700"
                />
                <button
                  type="submit"
                  disabled={selected.status !== "READY" || asking || question.trim().length < 2}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
                >
                  Enviar
                </button>
              </form>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
