/**
 * tools.js — Core PDF operations for PagePress.
 *
 * Deliberately UI-independent: no DOM access except inside
 * renderPdfToImages (it needs a <canvas>). Everything takes plain
 * ArrayBuffers / Uint8Arrays and returns plain bytes, so the same
 * functions can be exercised outside the browser (the project test
 * harness imports this module in Node with the PDFLib global provided).
 *
 * Libraries are read off globalThis at call time (not import time) so a
 * missing CDN script produces a clear, specific error instead of a
 * module-load failure that takes the whole page down.
 */

const A4 = { width: 595.28, height: 841.89 }; // points
const PAGE_MARGIN = 36; // 0.5 inch on every side

function requirePdfLib() {
  const lib = globalThis.PDFLib;
  if (!lib || !lib.PDFDocument) {
    throw new Error(
      "The pdf-lib library failed to load, so PDF editing is unavailable. Check your connection and reload the page.",
    );
  }
  return lib;
}

function requirePdfJs() {
  const lib = globalThis.pdfjsLib;
  if (!lib || !lib.getDocument) {
    throw new Error(
      "The PDF.js library failed to load, so pages cannot be rendered. Check your connection and reload the page.",
    );
  }
  return lib;
}

/** Best-effort conversion of library errors into messages a person can act on. */
export function friendlyError(err, action = "process this file") {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/encrypt/i.test(raw) || (err && err.name === "EncryptedPDFError")) {
    return "This PDF is password-protected, and PagePress cannot open encrypted files. Remove the password (for example by printing it to a new PDF) and try again.";
  }
  if (err && (err.name === "PasswordException" || err.code === 1 || err.code === 2)) {
    return "This PDF is password-protected, and PagePress cannot open encrypted files. Remove the password and try again.";
  }
  if (/Invalid PDF|invalid pdf structure|No PDF header|Failed to parse/i.test(raw)) {
    return `That file could not be read as a PDF, so PagePress cannot ${action}. It may be corrupt, or it may not be a real PDF.`;
  }
  if (raw) return raw;
  return `Something went wrong while trying to ${action}.`;
}

/** Load a PDF with pdf-lib, mapping failures to friendly errors. */
async function loadPdf(bytes, action) {
  const { PDFDocument } = requirePdfLib();
  try {
    return await PDFDocument.load(bytes);
  } catch (err) {
    throw new Error(friendlyError(err, action));
  }
}

/** Number of pages in a PDF given as bytes. */
export async function getPageCount(bytes) {
  const doc = await loadPdf(bytes, "read this file");
  return doc.getPageCount();
}

/**
 * Merge several PDFs (array of ArrayBuffers/Uint8Arrays) into one.
 * Source order is preserved: all pages of file 1, then file 2, and so on.
 * Returns the merged PDF as a Uint8Array.
 */
export async function mergePdfs(buffers) {
  if (!Array.isArray(buffers) || buffers.length === 0) {
    throw new Error("Add at least one PDF to merge.");
  }
  const { PDFDocument } = requirePdfLib();
  const out = await PDFDocument.create();
  for (const buffer of buffers) {
    const src = await loadPdf(buffer, "merge this file");
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const page of copied) out.addPage(page);
  }
  if (out.getPageCount() === 0) {
    throw new Error("None of the files had any pages to merge.");
  }
  return out.save();
}

const RANGE_TOKEN = /^(\d+)\s*(?:-\s*(\d+))?$/;

/**
 * Parse a human page-range string ("1-3, 5, 8-10") into sorted, unique,
 * 0-based page indices. Pages in the string are 1-based, like every PDF
 * reader shows them. Throws an Error with a specific message for every
 * invalid shape: empty input, unknown characters, a page below 1, a page
 * beyond the document, or a backwards range.
 */
export function parsePageRange(input, totalPages) {
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    throw new Error("The document has no pages to extract from.");
  }
  const text = String(input ?? "").trim();
  if (!text) {
    throw new Error('Type the pages you want first — for example "1-3, 5, 8-10".');
  }
  const pages = new Set();
  for (const rawPart of text.split(",")) {
    const part = rawPart.trim();
    if (!part) continue; // tolerate a trailing comma
    const match = RANGE_TOKEN.exec(part);
    if (!match) {
      throw new Error(`"${part}" is not a page or a range. Use single pages and ranges like "2", "1-3", separated by commas.`);
    }
    const start = Number.parseInt(match[1], 10);
    const end = match[2] === undefined ? start : Number.parseInt(match[2], 10);
    if (start < 1) {
      throw new Error("Page numbers start at 1 — there is no page 0.");
    }
    if (end < start) {
      throw new Error(`The range "${part}" runs backwards. Write the smaller page first, like "3-5".`);
    }
    if (end > totalPages) {
      throw new Error(
        `Page ${end} does not exist — this document has ${totalPages} page${totalPages === 1 ? "" : "s"}.`,
      );
    }
    for (let p = start; p <= end; p += 1) pages.add(p - 1);
  }
  if (pages.size === 0) {
    throw new Error('Type the pages you want first — for example "1-3, 5, 8-10".');
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Copy the given 0-based page indices out of a PDF into a new document.
 * Indices appear in the output in ascending page order.
 */
export async function extractPages(bytes, indices) {
  if (!Array.isArray(indices) || indices.length === 0) {
    throw new Error("No pages were selected to extract.");
  }
  const { PDFDocument } = requirePdfLib();
  const src = await loadPdf(bytes, "extract pages from this file");
  const total = src.getPageCount();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      throw new Error(`Page ${index + 1} does not exist — this document has ${total} pages.`);
    }
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices);
  for (const page of copied) out.addPage(page);
  return out.save();
}

/**
 * Split a PDF into one single-page PDF per page.
 * Returns [{ page (1-based), bytes }] in document order — the caller
 * decides between a ZIP and sequential downloads.
 */
export async function splitIntoPages(bytes) {
  const { PDFDocument } = requirePdfLib();
  const src = await loadPdf(bytes, "split this file");
  const parts = [];
  for (let i = 0; i < src.getPageCount(); i += 1) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(src, [i]);
    single.addPage(page);
    parts.push({ page: i + 1, bytes: await single.save() });
  }
  return parts;
}

/**
 * Sniff an image's real type from its magic bytes. File extensions and
 * MIME types lie often enough that the bytes are the only honest check.
 * Returns "png", "jpeg", or null.
 */
export function detectImageKind(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return null;
}

/** True when the bytes start with a PDF header ("%PDF-"). */
export function looksLikePdf(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
}

/**
 * Build one PDF from a list of images, one image per A4 page.
 * images: [{ bytes }] — the kind is sniffed from the bytes, so a PNG
 * named ".jpg" still works. Each image is scaled to fit inside the page
 * margins (never upscaled past its natural size, which would only add
 * blur) and centred on the page.
 */
export async function imagesToPdf(images) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error("Add at least one image to build a PDF.");
  }
  const { PDFDocument } = requirePdfLib();
  const doc = await PDFDocument.create();
  const contentW = A4.width - PAGE_MARGIN * 2;
  const contentH = A4.height - PAGE_MARGIN * 2;

  for (let i = 0; i < images.length; i += 1) {
    const bytes = images[i].bytes;
    const kind = detectImageKind(bytes);
    let embedded;
    try {
      if (kind === "png") embedded = await doc.embedPng(bytes);
      else if (kind === "jpeg") embedded = await doc.embedJpg(bytes);
      else throw new Error("not an image");
    } catch {
      throw new Error(`Image ${i + 1} could not be read. PagePress accepts JPG and PNG images only.`);
    }
    const scale = Math.min(contentW / embedded.width, contentH / embedded.height, 1);
    const drawW = embedded.width * scale;
    const drawH = embedded.height * scale;
    const page = doc.addPage([A4.width, A4.height]);
    page.drawImage(embedded, {
      x: (A4.width - drawW) / 2,
      y: (A4.height - drawH) / 2,
      width: drawW,
      height: drawH,
    });
  }
  return doc.save();
}

/**
 * Render every page of a PDF to an image with PDF.js.
 * Options: { scale = 2, format = "png" | "jpeg", onProgress(done, total) }.
 * Returns [{ page (1-based), blob, width, height }].
 *
 * A copy of the bytes is handed to PDF.js because it is allowed to
 * detach the buffer it is given; the caller's copy stays usable.
 */
export async function renderPdfToImages(bytes, { scale = 2, format = "png", onProgress } = {}) {
  const pdfjs = requirePdfJs();
  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  } catch (err) {
    throw new Error(friendlyError(err, "open this file"));
  }

  const results = [];
  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Your browser could not create a drawing surface to render the pages.");
      if (format === "jpeg") {
        // JPEG has no alpha channel; without this the transparent parts
        // of a page would come out black.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error(`Page ${pageNo} could not be encoded as an image.`))),
          mime,
          format === "jpeg" ? 0.92 : undefined,
        );
      });
      results.push({ page: pageNo, blob, width: canvas.width, height: canvas.height });
      if (typeof onProgress === "function") onProgress(pageNo, pdf.numPages);
      page.cleanup();
    }
  } finally {
    await pdf.destroy().catch(() => {});
  }
  return results;
}

/* ---------- Small shared helpers ---------- */

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "report.final.pdf" -> "report.final"; a name without an extension is returned as-is. */
export function fileBaseName(name) {
  const clean = String(name ?? "file").split(/[\\/]/).pop() || "file";
  const dot = clean.lastIndexOf(".");
  return dot > 0 ? clean.slice(0, dot) : clean;
}
