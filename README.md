# PagePress

Every "free PDF tool" site wants the same thing: your file. You upload a bank statement or a signed contract to a server you know nothing about, wait in a queue, and hope for the best. I never liked that trade, so PagePress does the whole job in your browser instead. **Your files never leave your device** — there is no upload because there is nothing to upload to.

## The tools

- **Merge PDF** — combine any number of PDFs into one. The list order is the merge order.
- **Split / Extract** — pull pages out of a PDF with ranges like `1-3, 5, 8-10`, or split a document into one PDF per page and get them all as a ZIP.
- **Images to PDF** — turn JPG and PNG images into a single PDF, one image per A4 page, fitted inside the margins.
- **PDF to Images** — render every page of a PDF as a PNG or JPG at 2x resolution, downloaded one by one or as a ZIP.

## How it works

Two libraries do the heavy lifting, both running locally in the tab:

- [pdf-lib](https://pdf-lib.js.org/) copies real pages between documents for merging, extracting and splitting — so text stays selectable and vectors stay sharp, nothing gets flattened into a picture.
- [PDF.js](https://mozilla.github.io/pdf.js/) (the engine inside Firefox's PDF viewer) renders pages to a canvas for the PDF-to-images tool.

PagePress itself is plain HTML, CSS and vanilla JavaScript modules. No build step, no framework, no analytics. The only network requests the page makes are the library files and the font.

## Honest limitations

- **Password-protected PDFs will not open.** Browserside tools cannot guess your password, and I am not going to pretend otherwise — you get a clear error instead of a silent failure. Remove the password first (most PDF readers can "print to PDF" an unlocked copy).
- **Very large files are bounded by your device's memory.** A 300-page scan is fine on a laptop and rough on an old phone. Everything is local, so your hardware is the limit.
- **PDF to Images renders at a fixed 2x scale.** That is sharp enough for slides and sharing; it is not a print-shop setting, and there is deliberately no giant quality panel pretending otherwise.
- **Merging copies pages, not document furniture.** Bookmarks, outlines and form fields from the source files do not carry into the merged file.
- **Images are placed on A4 pages** at their natural size or smaller — PagePress never upscales an image just to fill the page.

## Running it locally

Serve the folder with any static server and open it in a browser:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Double-clicking `index.html` will not work — browsers refuse to load ES modules from `file://`, so the page needs to be served over HTTP. Everyone trips on that once.

## Layout

- `index.html` — markup for the four tools
- `styles.css` — the design system (shared with my PixelPress project)
- `js/tools.js` — the PDF operations, kept free of DOM code so they can be tested outside a browser
- `js/ui.js` — list and result rendering
- `js/app.js` — state, file intake (click, drag and drop, paste) and wiring

## License

MIT — use it, fork it, ship something with it. A link back is appreciated but not required.
