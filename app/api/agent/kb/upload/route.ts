import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { ingestDocument } from "@/lib/agent/knowledge";

export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024;
const TEXT_EXTS = [".txt", ".md", ".markdown", ".csv", ".json"];

/** POST multipart: file + optional title → text extraction → ingest. */
export async function POST(req: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload" }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "No file attached" }, { status: 400 });
  }
  const name = file.name || "upload";
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File is over the 10 MB limit" }, { status: 400 });
  }
  const lower = name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  let text = "";
  try {
    if (lower.endsWith(".pdf")) {
      // Dynamically imported so the PDF engine only loads for PDFs.
      const { extractText } = await import("unpdf");
      const res: any = await extractText(new Uint8Array(buf));
      const raw = res?.text;
      text = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
    } else if (TEXT_EXTS.some((ext) => lower.endsWith(ext))) {
      text = buf.toString("utf-8");
    } else {
      return NextResponse.json(
        { error: "Unsupported file type — use .txt, .md, .csv, .json or .pdf" },
        { status: 400 }
      );
    }
  } catch (e: any) {
    return NextResponse.json({ error: `Could not read the file: ${e?.message || e}` }, { status: 400 });
  }
  if (!text.trim()) {
    return NextResponse.json({ error: "No readable text found in the file" }, { status: 400 });
  }
  try {
    const title = (form.get("title") as string | null)?.trim() || name.replace(/\.[^.]+$/, "");
    const { document, chunks } = await ingestDocument({
      title,
      content: text,
      source_type: "file",
      file_name: name,
    });
    return NextResponse.json({ ok: true, document, chunks });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Could not save the document" }, { status: 400 });
  }
}
