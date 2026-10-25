/**
 * ui.js — All DOM rendering for PagePress.
 *
 * app.js owns state and events; tools.js owns the PDF work. This module
 * is the only place that builds list/result markup, so markup changes
 * never touch business logic. File names are user-controlled data, so
 * they are always set via textContent, never innerHTML.
 */

import { formatBytes } from "./tools.js";

export function createElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

/**
 * One row of a tool's file list: position, name, size, remove button.
 * The position number is the order the tools consume — merge order and
 * page order both follow the list — so it is rendered, not implied.
 */
export function buildFileRow(entry, { position, onRemove }) {
  const row = createElement("li", "file-row");
  row.dataset.id = entry.id;

  const index = createElement("span", "file-index", String(position));
  index.setAttribute("aria-hidden", "true");

  const name = createElement("span", "file-name", entry.file.name);
  name.title = entry.file.name;

  const size = createElement("span", "file-size", formatBytes(entry.file.size));

  const removeBtn = createElement("button", "icon-btn", "×");
  removeBtn.type = "button";
  removeBtn.title = `Remove ${entry.file.name}`;
  removeBtn.setAttribute("aria-label", `Remove ${entry.file.name}`);
  removeBtn.addEventListener("click", () => onRemove(entry.id));

  row.append(index, name, size, removeBtn);
  return row;
}

/** Re-number the position badges after an add or remove. */
export function renumberRows(listEl) {
  listEl.querySelectorAll(".file-row .file-index").forEach((badge, i) => {
    badge.textContent = String(i + 1);
  });
}

/** Fill a panel's single-result card and wire its download button. */
export function showResultCard(refs, { name, meta, onDownload }) {
  refs.results.hidden = false;
  refs.resultName.textContent = name;
  refs.resultMeta.textContent = meta;
  // Clone-free rebinding: keep a single stored handler per button.
  if (refs.resultDownload._pagepressHandler) {
    refs.resultDownload.removeEventListener("click", refs.resultDownload._pagepressHandler);
  }
  const handler = () => onDownload();
  refs.resultDownload._pagepressHandler = handler;
  refs.resultDownload.addEventListener("click", handler);
}

export function hideResult(refs) {
  if (refs.results) refs.results.hidden = true;
}

/** One rendered-page card for the PDF-to-images result grid. */
export function buildPageCard(rendered, { name, onDownload }) {
  const card = createElement("article", "page-card");
  const img = document.createElement("img");
  img.alt = `Rendered page ${rendered.page}`;
  img.loading = "lazy";
  img.src = rendered.url;

  const body = createElement("div", "page-card-body");
  const title = createElement("div", "page-card-name", `Page ${rendered.page}`);
  const meta = createElement(
    "div",
    "page-card-meta",
    `${rendered.width} × ${rendered.height} · ${formatBytes(rendered.blob.size)}`,
  );
  const btn = createElement("button", "btn btn-secondary btn-small", `Download ${name}`);
  btn.type = "button";
  btn.addEventListener("click", () => onDownload(rendered));

  body.append(title, meta, btn);
  card.append(img, body);
  return card;
}

export function showToast(region, message, isSuccess = false) {
  if (!region) return;
  const toast = createElement("div", `toast${isSuccess ? " is-success" : ""}`, message);
  toast.setAttribute("role", "status");
  region.appendChild(toast);
  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    window.setTimeout(() => toast.remove(), 320);
  }, 3600);
}
