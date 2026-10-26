# Block Blast

A polished **Block Blast–style** block puzzle game built with **vanilla HTML, CSS and JavaScript**. No frameworks, no build tools, no external assets — just open `index.html` and play, or host it for free on GitHub Pages.

## Features

- 8×8 board with a tray of three weighted-random pieces
- Drag and drop with unified pointer events (mouse + touch)
- Live ghost preview — green where the piece fits, red where it does not
- Row and column clears, multi-line clears and consecutive-clear combos
- Score count-up, floating score popups, "Combo x2!" bursts, snap and clear animations
- Generates piece sets that are solvable when possible, so runs rarely end unfairly
- Best score in `localStorage`, Web Audio sound effects (no audio files) and a mute toggle
- Mobile vibration feedback on line clears
- Fully responsive layout for phones, tablets, desktop and landscape phones

## How to play

1. Drag one of the three pieces from the tray onto the 8×8 board.
2. A piece can be placed only when all of its squares land on empty squares.
3. Fill a complete row or column to clear it. Clear several lines at once for a bigger bonus.
4. Keep clearing lines on consecutive placements to build a combo multiplier.
5. All three pieces are replaced when you place all three.
6. The game ends when none of the remaining pieces fit anywhere. Try to beat your best score!

Pieces cannot be rotated — the shape is the shape. You can restart any time with the ↻ button (or the **R** key) and mute sound with the speaker button (or **M**).

## Scoring

- **+2 points** for every block you place.
- **Line bonus** for each line cleared: 1 line = 20, 2 = 50, 3 = 90, 4 = 140, 5 = 200, 6 = 270, 7 = 350, 8 = 440 (more than 8 lines adds 100 per extra line).
- **Combo multiplier** applies to the line bonus: the first clearing placement is ×1, a second consecutive clearing placement is ×2, then ×3, and so on. A placement that clears nothing resets the combo.
- The best score is saved locally in your browser (`localStorage`).

## Run locally

The game is completely static, so the simplest option is to double-click `index.html`.

For a local web server (recommended if you want to test the exact hosted behaviour):

```bash
# Python 3 (already installed on most systems)
python -m http.server 8000

# or with Node.js installed
npx serve .
```

Then open <http://localhost:8000> in your browser.

## Deploy on GitHub Pages

1. Create a new repository on GitHub (for example `block-blast`). Do **not** initialise it with a README if you already have these files locally.
2. From this folder, push the files:

   ```bash
   git init
   git add .
   git commit -m "Add Block Blast game"
   git branch -M main
   git remote add origin https://github.com/USERNAME/block-blast.git
   git push -u origin main
   ```

3. On GitHub open **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Set the branch to **main** and the folder to **/ (root)**, then click **Save**.
6. Wait a minute or two. The site will be published at:

   ```text
   https://USERNAME.github.io/block-blast/
   ```

   If you name the repository `USERNAME.github.io`, it is published at `https://USERNAME.github.io/` instead.

No build step or configuration is required. Every push to `main` updates the live site automatically.

## Project structure

```text
.
├── index.html    # page structure
├── style.css     # theme, layout, animations
├── script.js     # game logic, rendering, input, audio
├── README.md     # this file
└── .gitignore    # files git should ignore
```

## Notes

- Sound starts after the first tap/click because browsers require a user gesture before playing audio.
- The best score and mute preference are stored only in the current browser.
- Tested with the current Chrome/Edge browser engines; it uses standard pointer events and CSS, so it is designed to work in current versions of Chrome, Edge, Firefox and Safari.
