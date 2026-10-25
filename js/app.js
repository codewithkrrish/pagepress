/**
 * app.js — PagePress application wiring and state.
 *
 * Four tools share one panel factory: each panel owns an ordered file
 * list, a status line, an error box and a results area. Order in the
 * list is meaningful everywhere — it is the merge order and the page
 * order — so rows are numbered and the factory keeps DOM and state in
 * lockstep. tools.js does the actual PDF work; this file never touches
 * pdf-lib or PDF.js directly.
 */

import {
  mergePdfs,
  extractPages,
  splitIntoPages,
  imagesToPdf,
  renderPdfToImages,
  getPageCount,
  parsePageRange,
  looksLikePdf,
  detectImageKind,
  friendlyError,
  formatBytes,
  fileBaseName,
} from "./tools.js";
import { buildFileRow, renumberRows, showResultCard, buildPageCard, showToast } from "./ui.js";

const $ = (selector) => document.querySelector(selector);

const els = {
  tabs: [...document.querySelectorAll("[data-tab]")],
  toastRegion: $("#toastRegion"),
};

let activeTool = "merge";
/** @type {Map<string, object>} panel name -> panel API */
const panels = new Map();

function createId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Extract File objects from a drop/paste DataTransfer. `files` is the
 * fast path; some browsers (and drags sourced from other apps) expose
 * dragged files only through `items`, so fall back to getAsFile().
 */
function filesFromDataTransfer(dt) {
  if (!dt) return [];
  if (dt.files?.length) return [...dt.files];
  return [...(dt.items || [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  // The CDN script tag in index.html is the primary path; this dynamic
  // retry covers the tag being blocked while a fresh fetch can succeed.
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return window.JSZip || null;
}

/**
 * Download many files as one ZIP. If JSZip is unavailable, fall back to
 * downloading the files one by one (staggered, because browsers throttle
 * simultaneous programmatic downloads). Duplicate names are suffixed.
 */
async function downloadAsZip(items, zipName, panel) {
  if (!items.length) return;
  if (items.length === 1) {
    const url = URL.createObjectURL(items[0].blob);
    triggerDownload(url, items[0].name);
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    return;
  }
  try {
    const JSZipCtor = await loadJSZip();
    if (!JSZipCtor) throw new Error("JSZip unavailable");
    const zip = new JSZipCtor();
    const used = new Set();
    for (const item of items) {
      let name = item.name;
      let counter = 2;
      while (used.has(name)) {
        name = item.name.replace(/(\.[^.]+)$/, `-${counter++}$1`);
        if (!name.includes(".")) name = `${item.name}-${counter - 1}`;
      }
      used.add(name);
      zip.file(name, item.blob);
    }
    // STORE: PDFs and rendered images are already compressed formats.
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, zipName);
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    panel.setStatus(`${items.length} files downloaded as ${zipName}.`);
    showToast(els.toastRegion, `${items.length} files downloaded as a ZIP.`, true);
  } catch {
    panel.setStatus("ZIP was unavailable, so the files are downloading one by one.");
    showToast(els.toastRegion, "ZIP was unavailable, so the files will download one by one.");
    items.forEach((item, index) => {
      window.setTimeout(() => {
        const url = URL.createObjectURL(item.blob);
        triggerDownload(url, item.name);
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      }, index * 350);
    });
  }
}

/* ---------- Panel factory ---------- */

/**
 * Create one tool panel.
 * config:
 *   multiple   — accept more than one file (single-file panels replace)
 *   validate   — async (file, entry) => void; throw Error to reject the
 *                file with a human-readable reason. May enrich the entry
 *                (e.g. cache bytes / page count) for later steps.
 *   onFilesChanged(panel) — after adds/removes/clears
 *   canProcess(panel)     — whether the primary action may run
 *   onProcess(panel)      — the primary action
 */
function createPanel(name, config) {
  const root = document.querySelector(`[data-panel="${name}"]`);
  const refs = {
    root,
    dropzone: root.querySelector(".dropzone"),
    input: root.querySelector('input[type="file"]'),
    listWrap: root.querySelector("[data-list-wrap]"),
    list: root.querySelector("[data-file-list]"),
    processBtn: root.querySelector("[data-process]"),
    clearBtn: root.querySelector("[data-clear]"),
    status: root.querySelector("[data-status]"),
    error: root.querySelector("[data-error]"),
    results: root.querySelector("[data-results]"),
    resultName: root.querySelector("[data-result-name]"),
    resultMeta: root.querySelector("[data-result-meta]"),
    resultDownload: root.querySelector("[data-result-download]"),
  };

  const panel = {
    name,
    refs,
    /** @type {{id: string, file: File, bytes: ArrayBuffer|null, pageCount: number|null}[]} */
    files: [],
    busy: false,
    resultUrl: null,
  };

  panel.setStatus = (text, { spinner = false } = {}) => {
    refs.status.textContent = "";
    if (spinner) {
      const s = document.createElement("span");
      s.className = "spinner";
      s.setAttribute("aria-hidden", "true");
      refs.status.appendChild(s);
    }
    if (text) refs.status.appendChild(document.createTextNode(text));
  };

  panel.setError = (message) => {
    if (message) {
      refs.error.textContent = message;
      refs.error.hidden = false;
    } else {
      refs.error.textContent = "";
      refs.error.hidden = true;
    }
  };

  panel.setBusy = (busy) => {
    panel.busy = busy;
    panel.refreshButtons();
  };

  panel.refreshButtons = () => {
    refs.processBtn.disabled = panel.busy || !config.canProcess(panel);
    if (refs.clearBtn) refs.clearBtn.disabled = panel.busy || panel.files.length === 0;
  };

  panel.hideResult = () => {
    if (panel.resultUrl) {
      URL.revokeObjectURL(panel.resultUrl);
      panel.resultUrl = null;
    }
    if (refs.results && refs.resultName) refs.results.hidden = true;
  };

  /** Show the single-file result card (merge / extract / images-to-PDF). */
  panel.showResult = (blob, filename, meta) => {
    panel.hideResult();
    panel.resultUrl = URL.createObjectURL(blob);
    const url = panel.resultUrl;
    showResultCard(refs, {
      name: filename,
      meta,
      onDownload: () => triggerDownload(url, filename),
    });
  };

  panel.renderList = () => {
    refs.list.textContent = "";
    panel.files.forEach((entry, i) => {
      refs.list.appendChild(buildFileRow(entry, { position: i + 1, onRemove: (id) => panel.removeFile(id) }));
    });
    refs.listWrap.hidden = panel.files.length === 0;
    panel.refreshButtons();
  };

  panel.addFiles = async (fileList) => {
    const incoming = [...fileList];
    if (!incoming.length) return;
    const reasons = [];
    for (const file of incoming) {
      if (!config.multiple && panel.files.length > 0) {
        // Single-file tools: the new file replaces the old one outright.
        panel.clearFiles({ silent: true });
      }
      const entry = { id: createId(), file, bytes: null, pageCount: null };
      try {
        await config.validate(file, entry);
      } catch (err) {
        reasons.push(err instanceof Error ? err.message : `${file.name} could not be added.`);
        continue;
      }
      panel.files.push(entry);
      panel.hideResult();
      panel.setError(null);
    }
    panel.renderList();
    if (reasons.length) {
      panel.setError(reasons[0]);
      if (reasons.length > 1) showToast(els.toastRegion, `${reasons.length} files were rejected. See the message in the tool.`);
    }
    config.onFilesChanged?.(panel);
  };

  panel.removeFile = (id) => {
    const index = panel.files.findIndex((f) => f.id === id);
    if (index === -1) return;
    panel.files.splice(index, 1);
    panel.hideResult();
    panel.setError(null);
    panel.setStatus("");
    panel.renderList();
    config.onFilesChanged?.(panel);
  };

  panel.clearFiles = ({ silent = false } = {}) => {
    panel.files = [];
    panel.hideResult();
    panel.setError(null);
    if (!silent) panel.setStatus("");
    panel.renderList();
    config.onFilesChanged?.(panel);
  };

  /* Intake wiring: click, keyboard, drag & drop on this panel's zone. */
  refs.dropzone.addEventListener("click", () => refs.input.click());
  refs.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      refs.input.click();
    }
  });
  refs.input.addEventListener("change", () => {
    panel.addFiles(refs.input.files);
    // Reset so choosing the same file again after removal still fires "change".
    refs.input.value = "";
  });
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const evt of ["dragenter", "dragover"]) {
    refs.dropzone.addEventListener(evt, (e) => {
      stop(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      refs.dropzone.classList.add("is-dragover");
    });
  }
  refs.dropzone.addEventListener("dragleave", (e) => {
    stop(e);
    // Moving across the zone's children fires dragleave on the zone
    // itself; only clear the highlight when the drag truly left.
    if (e.relatedTarget && refs.dropzone.contains(e.relatedTarget)) return;
    refs.dropzone.classList.remove("is-dragover");
  });
  refs.dropzone.addEventListener("drop", (e) => {
    stop(e);
    refs.dropzone.classList.remove("is-dragover");
    document.body.classList.remove("is-dragging");
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) panel.addFiles(files);
  });

  refs.processBtn.addEventListener("click", () => config.onProcess(panel));
  refs.clearBtn?.addEventListener("click", () => panel.clearFiles());

  panel.renderList();
  panels.set(name, panel);
  return panel;
}

/** Shared validator: reject anything whose first bytes are not "%PDF-". */
async function validatePdfFile(file, entry) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!looksLikePdf(head)) {
    throw new Error(`"${file.name}" is not a PDF file.`);
  }
  return entry;
}

/** Validator for the single-PDF tools: also cache bytes + page count. */
async function validateSinglePdf(file, entry) {
  await validatePdfFile(file, entry);
  entry.bytes = await file.arrayBuffer();
  try {
    entry.pageCount = await getPageCount(entry.bytes);
  } catch (err) {
    throw new Error(friendlyError(err, "open this file"));
  }
  return entry;
}

/* ---------- Tool controllers ---------- */

function setupMerge() {
  return createPanel("merge", {
    multiple: true,
    validate: validatePdfFile,
    canProcess: (panel) => panel.files.length >= 2,
    onFilesChanged: (panel) => {
      if (panel.busy) return;
      if (panel.files.length === 1) panel.setStatus("One PDF added — merging needs at least two.");
      else if (panel.files.length > 1) panel.setStatus(`${panel.files.length} PDFs ready to merge.`);
    },
    onProcess: async (panel) => {
      panel.setError(null);
      panel.setBusy(true);
      panel.setStatus(`Merging ${panel.files.length} PDFs…`, { spinner: true });
      try {
        const buffers = await Promise.all(panel.files.map((f) => f.file.arrayBuffer()));
        const bytes = await mergePdfs(buffers);
        const pageCount = await getPageCount(bytes);
        const blob = new Blob([bytes], { type: "application/pdf" });
        panel.showResult(
          blob,
          "merged.pdf",
          `${pageCount} page${pageCount === 1 ? "" : "s"} · ${formatBytes(blob.size)} · combined from ${panel.files.length} files`,
        );
        panel.setStatus("Done — your merged PDF is ready to download.");
        showToast(els.toastRegion, "PDFs merged.", true);
      } catch (err) {
        panel.setStatus("");
        panel.setError(friendlyError(err, "merge these files"));
      } finally {
        panel.setBusy(false);
      }
    },
  });
}

function setupSplit() {
  const panel = createPanel("split", {
    multiple: false,
    validate: validateSinglePdf,
    canProcess: (p) => p.files.length === 1,
    onFilesChanged: (p) => {
      const entry = p.files[0];
      if (entry) {
        p.setStatus(`${entry.file.name} — ${entry.pageCount} page${entry.pageCount === 1 ? "" : "s"}.`);
        rangeHint.textContent = `This document has ${entry.pageCount} page${entry.pageCount === 1 ? "" : "s"}. Type page numbers between 1 and ${entry.pageCount}.`;
      } else {
        rangeHint.textContent = "Add a PDF first — its page count will show here.";
      }
      rangeHint.classList.remove("is-error");
      refreshSplitButtons();
    },
    onProcess: async (p) => {
      const entry = p.files[0];
      if (!entry) return;
      let indices;
      try {
        indices = parsePageRange(rangeInput.value, entry.pageCount);
      } catch (err) {
        p.setError(err instanceof Error ? err.message : "That page selection is not valid.");
        rangeInput.focus();
        return;
      }
      p.setError(null);
      p.setBusy(true);
      p.setStatus(`Extracting ${indices.length} page${indices.length === 1 ? "" : "s"}…`, { spinner: true });
      try {
        const bytes = await extractPages(entry.bytes, indices);
        const blob = new Blob([bytes], { type: "application/pdf" });
        panel.showResult(
          blob,
          `${fileBaseName(entry.file.name)}-extracted.pdf`,
          `${indices.length} page${indices.length === 1 ? "" : "s"} extracted · ${formatBytes(blob.size)}`,
        );
        p.setStatus("Done — your extracted PDF is ready to download.");
        showToast(els.toastRegion, "Pages extracted.", true);
      } catch (err) {
        p.setStatus("");
        p.setError(friendlyError(err, "extract pages from this file"));
      } finally {
        p.setBusy(false);
      }
    },
  });

  const rangeInput = panel.refs.root.querySelector("#rangeInput");
  const rangeHint = panel.refs.root.querySelector("[data-range-hint]");
  const splitAllBtn = panel.refs.root.querySelector("[data-split-all]");

  const baseRefresh = panel.refreshButtons.bind(panel);
  function refreshSplitButtons() {
    baseRefresh();
    splitAllBtn.disabled = panel.busy || panel.files.length !== 1;
  }
  panel.refreshButtons = refreshSplitButtons;

  rangeInput.addEventListener("input", () => {
    const entry = panel.files[0];
    rangeHint.classList.remove("is-error");
    if (!entry) return;
    const value = rangeInput.value.trim();
    if (!value) {
      rangeHint.textContent = `This document has ${entry.pageCount} pages. Type page numbers between 1 and ${entry.pageCount}.`;
      return;
    }
    try {
      const indices = parsePageRange(value, entry.pageCount);
      const shown = indices.slice(0, 8).map((i) => i + 1).join(", ");
      rangeHint.textContent = `Will extract ${indices.length} page${indices.length === 1 ? "" : "s"}: ${shown}${indices.length > 8 ? "…" : ""}`;
    } catch (err) {
      rangeHint.textContent = err instanceof Error ? err.message : "That page selection is not valid.";
      rangeHint.classList.add("is-error");
    }
  });

  splitAllBtn.addEventListener("click", async () => {
    const entry = panel.files[0];
    if (!entry || panel.busy) return;
    panel.setError(null);
    panel.setBusy(true);
    panel.setStatus(`Splitting into ${entry.pageCount} separate PDFs…`, { spinner: true });
    try {
      const parts = await splitIntoPages(entry.bytes);
      const base = fileBaseName(entry.file.name);
      const width = String(parts.length).length;
      const items = parts.map((part) => ({
        name: `${base}-page-${String(part.page).padStart(width, "0")}.pdf`,
        blob: new Blob([part.bytes], { type: "application/pdf" }),
      }));
      await downloadAsZip(items, `${base}-pages.zip`, panel);
    } catch (err) {
      panel.setStatus("");
      panel.setError(friendlyError(err, "split this file"));
    } finally {
      panel.setBusy(false);
    }
  });

  refreshSplitButtons();
  return panel;
}

function setupImg2Pdf() {
  return createPanel("img2pdf", {
    multiple: true,
    validate: async (file) => {
      const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      if (!detectImageKind(head)) {
        throw new Error(`"${file.name}" is not a JPG or PNG image.`);
      }
    },
    canProcess: (panel) => panel.files.length >= 1,
    onFilesChanged: (panel) => {
      if (panel.busy) return;
      if (panel.files.length) {
        panel.setStatus(`${panel.files.length} image${panel.files.length === 1 ? "" : "s"} — one page each, in list order.`);
      }
    },
    onProcess: async (panel) => {
      panel.setError(null);
      panel.setBusy(true);
      panel.setStatus(`Building a PDF from ${panel.files.length} image${panel.files.length === 1 ? "" : "s"}…`, { spinner: true });
      try {
        const images = [];
        for (const entry of panel.files) {
          images.push({ bytes: await entry.file.arrayBuffer() });
        }
        const bytes = await imagesToPdf(images);
        const blob = new Blob([bytes], { type: "application/pdf" });
        const name =
          panel.files.length === 1 ? `${fileBaseName(panel.files[0].file.name)}.pdf` : "images-combined.pdf";
        panel.showResult(
          blob,
          name,
          `${panel.files.length} page${panel.files.length === 1 ? "" : "s"} · A4 · ${formatBytes(blob.size)}`,
        );
        panel.setStatus("Done — your PDF is ready to download.");
        showToast(els.toastRegion, "PDF created.", true);
      } catch (err) {
        panel.setStatus("");
        panel.setError(friendlyError(err, "build a PDF from these images"));
      } finally {
        panel.setBusy(false);
      }
    },
  });
}

function setupPdf2Img() {
  const panel = createPanel("pdf2img", {
    multiple: false,
    validate: validateSinglePdf,
    canProcess: (p) => p.files.length === 1,
    onFilesChanged: (p) => {
      clearRendered();
      const entry = p.files[0];
      if (entry && !p.busy) {
        p.setStatus(`${entry.file.name} — ${entry.pageCount} page${entry.pageCount === 1 ? "" : "s"} to render.`);
      }
    },
    onProcess: async (p) => {
      const entry = p.files[0];
      if (!entry) return;
      const format = formatSelect.value;
      p.setError(null);
      p.setBusy(true);
      clearRendered();
      p.setStatus("Rendering pages…", { spinner: true });
      try {
        const rendered = await renderPdfToImages(entry.bytes, {
          scale: 2,
          format,
          onProgress: (done, total) => p.setStatus(`Rendering page ${done} of ${total}…`, { spinner: true }),
        });
        const base = fileBaseName(entry.file.name);
        const ext = format === "jpeg" ? "jpg" : "png";
        const width = String(rendered.length).length;
        panel.rendered = rendered.map((r) => ({
          ...r,
          url: URL.createObjectURL(r.blob),
          name: `${base}-page-${String(r.page).padStart(width, "0")}.${ext}`,
        }));
        for (const item of panel.rendered) {
          pageGrid.appendChild(
            buildPageCard(item, { name: item.name, onDownload: (it) => triggerDownload(it.url, it.name) }),
          );
        }
        resultsWrap.hidden = false;
        p.setStatus(`Rendered ${rendered.length} page${rendered.length === 1 ? "" : "s"} at 2x.`);
        showToast(els.toastRegion, "Pages rendered.", true);
      } catch (err) {
        p.setStatus("");
        p.setError(friendlyError(err, "render this file"));
      } finally {
        p.setBusy(false);
      }
    },
  });

  const formatSelect = panel.refs.root.querySelector("#imgFormatSelect");
  const pageGrid = panel.refs.root.querySelector("[data-page-grid]");
  const resultsWrap = panel.refs.results;
  const downloadAllBtn = panel.refs.root.querySelector("[data-download-all]");
  panel.rendered = [];

  function clearRendered() {
    for (const item of panel.rendered ?? []) URL.revokeObjectURL(item.url);
    panel.rendered = [];
    pageGrid.textContent = "";
    resultsWrap.hidden = true;
  }

  downloadAllBtn.addEventListener("click", async () => {
    if (!panel.rendered.length || panel.busy) return;
    const entry = panel.files[0];
    const base = entry ? fileBaseName(entry.file.name) : "pages";
    const items = panel.rendered.map((r) => ({ name: r.name, blob: r.blob }));
    await downloadAsZip(items, `${base}-pages.zip`, panel);
  });

  return panel;
}

/* ---------- Tabs ---------- */

function activateTab(name) {
  activeTool = name;
  for (const tab of els.tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const [panelName, panel] of panels) {
    panel.refs.root.hidden = panelName !== name;
  }
}

function bindTabs() {
  for (const tab of els.tabs) {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  }
  const tablist = els.tabs[0]?.parentElement;
  tablist?.addEventListener("keydown", (e) => {
    const order = els.tabs.map((t) => t.dataset.tab);
    const current = order.indexOf(activeTool);
    let next = null;
    if (e.key === "ArrowRight") next = order[(current + 1) % order.length];
    else if (e.key === "ArrowLeft") next = order[(current - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (next) {
      e.preventDefault();
      activateTab(next);
      els.tabs.find((t) => t.dataset.tab === next)?.focus();
    }
  });
}

/* ---------- Init ---------- */

function init() {
  // PDF.js renders through a worker; point it at the same CDN build.
  if (globalThis.pdfjsLib?.GlobalWorkerOptions) {
    globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  setupMerge();
  setupSplit();
  setupImg2Pdf();
  setupPdf2Img();
  bindTabs();
  activateTab("merge");

  // A drop anywhere on the page goes to the active tool — users aim at
  // the page, not always precisely at the zone. Drops on a zone itself
  // never reach this handler: the zone's listener stops propagation.
  window.addEventListener("dragenter", () => document.body.classList.add("is-dragging"));
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("is-dragging");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("is-dragging");
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) panels.get(activeTool)?.addFiles(files);
  });
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) panels.get(activeTool)?.addFiles(files);
  });

  // Tiny handle for debugging and for the project's smoke tests.
  window.__pagepress = { panels, activateTab, getActiveTool: () => activeTool };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
