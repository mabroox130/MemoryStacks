# Memory Stacks

A quiet flashcard app with CSV and PowerPoint import, Leitner spaced repetition, and offline support. Installs to your phone like a native app.

## What's in here

```
memory-stacks/
├── index.html              Main app shell + styles
├── app.js                  All app logic (IndexedDB, Leitner, UI)
├── jszip.min.js            ZIP library, used for reading .pptx files
├── service-worker.js       Offline support
├── manifest.json           PWA install metadata
├── icon-192.png            Android home screen
├── icon-512.png            Android splash
├── icon-180.png            iOS home screen
├── icon-maskable-512.png   Android adaptive
├── favicon-32.png          Browser tab
└── README.md               This file
```

## Run locally

Service workers won't load over `file://`, so you need a tiny local server. Pick one:

```bash
# Python (almost certainly on your Mac already)
cd memory-stacks
python3 -m http.server 8000

# Or Node
npx serve .
```

Then open http://localhost:8000 in Chrome/Safari. Both DevTools have an "Application" tab where you can verify the manifest is detected and the service worker registered.

## Deploy

Any static host works. The fastest two paths:

**Netlify Drop** — go to https://app.netlify.com/drop, drag the `memory-stacks` folder into the browser, get a public HTTPS URL in about 5 seconds. Free forever for personal use.

**Vercel** — `npx vercel --prod` in the folder, follow prompts. Also free for personal use.

**GitHub Pages** — push to a repo, enable Pages in settings, point at the root. Free; gives you `username.github.io/repo-name` as a URL.

Whichever you pick, you'll need HTTPS for the service worker to register (all three give you HTTPS automatically).

## Install on phone

**iPhone (Safari):** Open the URL in Safari → tap the Share button → "Add to Home Screen." It now lives on your home screen with the Memory Stacks icon and opens full-screen without the Safari chrome.

**Android (Chrome):** Open the URL. Chrome will show an install prompt automatically, or use menu → "Install app." Same result — a real app icon, standalone window.

## Importing flashcards

Memory Stacks accepts two file formats. The Import button takes whichever you pick.

### CSV (recommended for spreadsheet workflow)

Two columns: front, back. A header row (`front,back`) is detected and skipped if present.

```csv
front,back
Defenestration,Throwing someone out a window
Ephemeral,Lasting a short time
"Capital of Mongolia?","Ulaanbaatar"
```

Use quotes around any field that contains a comma or newline. Standard CSV — Google Sheets, Excel, and Numbers all export this format directly.

To import from cloud storage on your phone, just tap **Import** — iOS and Android both show iCloud Drive, Google Drive, OneDrive, and Dropbox as sources in the file picker (assuming you have those apps installed).

### PowerPoint (.pptx)

If you already have study material in PowerPoint, drop the .pptx in directly. **Odd slides become card fronts, even slides become backs** (slide 1 + 2 → card 1, slide 3 + 4 → card 2, etc.).

- Bold, italic, underline, and **direct sRGB colors** are preserved automatically — whatever you formatted on the slide will appear on the card.
- Text from every text box on a slide is included, joined with newlines in source order. Long slides become multi-line cards.
- An odd number of slides leaves the last one orphaned; it's skipped with a note.
- Theme colors (the ones tied to the slide's color scheme rather than a literal hex value) are not preserved — only direct sRGB colors come through. Workaround: in PowerPoint, set text color via "More Colors → Custom" with a hex value.
- Images, charts, tables, and shape geometry are not extracted. Text only.

### Rich text inside cells

CSV cells are plain text, but Memory Stacks recognizes two notations inside them: Markdown (quick to type) and a tightly whitelisted subset of HTML (for color). Both work in the same cell, mix freely. PPTX import generates this same notation automatically.

**Markdown:**

| Write          | See              |
|----------------|------------------|
| `**bold**`     | **bold**         |
| `*italic*`     | *italic*         |
| `__underline__`| underline        |

**HTML** (use when you want color):

```html
<b>bold</b>   <i>italic</i>   <u>underline</u>
<span style="color: red">red</span>
<span style="color: #2a6">forest green</span>
```

Colors accept any CSS named color (`red`, `darkblue`, `tomato`, …) or hex (`#fff`, `#a14d29`). Anything else is silently rejected for safety — only color is allowed as an inline style; no other HTML tags or attributes pass through. All `<script>`, event handlers, and unknown tags are escaped and shown as literal text.

**Example CSV with rich content:**

```csv
front,back
"How to brew tea","**Steps:**
1. Boil <span style=""color: #a14d29"">water</span>
2. Add *leaves*
3. Wait __4 minutes__
4. Strain"
```

(Note the doubled `""` — that's how CSV escapes a literal quote character inside a quoted field. Google Sheets does this automatically when you export.)

## Editing a deck

Tap the small ✎ icon in the upper-right of any deck card to open the editor. From there you can:

- Edit any card's front or back inline (changes save automatically when you tap out of the field — you'll see a brief green border flash)
- Add new cards with the **+ Add card** button
- Delete individual cards with the × on each card row
- Rename the deck by tapping its title
- Export the deck back to CSV
- Delete the entire deck

## Export a deck to CSV

Inside the editor, tap **Export CSV**. The download includes:
- A `front,back` header row
- All cards in their original order
- Proper quoting for fields with commas, quotes, or newlines
- A UTF-8 byte-order mark so Excel correctly handles non-ASCII characters

The exported file is fully round-trippable — re-importing it produces an identical deck (minus the Leitner box state, which is intentionally not exported since it's tied to your personal study history).

## How the spaced repetition works

Standard Leitner with 5 boxes. Every card starts in Box 1.

| Box | Review interval |
|-----|----------------|
| 1   | 1 day          |
| 2   | 2 days         |
| 3   | 4 days         |
| 4   | 8 days         |
| 5   | 16 days        |

- **Got it** → card moves up one box (max 5), next review scheduled at the new interval
- **Review again** → card drops back to Box 1, due again tomorrow

When you open a deck, you'll see only cards that are *due now*, sorted by lowest box first (the ones you've been struggling with). If nothing is due, you can choose to practice the whole deck — but doing so won't change any card's schedule.

## Data

Everything lives in IndexedDB on the device. There's no server, no account, no telemetry. Clearing your browser data for the site (or uninstalling the PWA) will erase your decks.

If you want sync across devices later, that's the big next step — and it's the point where you'd need to add a backend (Firebase, Supabase, or a tiny custom service).

## Keyboard shortcuts (desktop)

- `Space` / `Enter` — flip card
- `←` / `→` — previous / next
- `1` or `N` — mark "Review again"
- `2` or `Y` — mark "Got it"

## Customizing

- **Box intervals:** edit `BOX_INTERVALS` at the top of `app.js`
- **Session cap:** `SESSION_CAP` (default 50) controls how many due cards a single session will show
- **Colors:** all in the `:root` CSS variables at the top of `index.html`
- **Fonts:** the Google Fonts `<link>` in `index.html`

## Long-press to delete a deck

Hold down on a deck card (on phone or with mouse) for ~0.7s to get the delete confirmation.
