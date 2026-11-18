# REDESIGN.md: Restyle this site after "Creative Reference Library" (CRL)

Reference: https://www.awwwards.com/sites/creative-reference-library
Live site: https://crl-2026.webflow.io/ (Site of the Day, Nov 10, 2026, score 7.44, by Bimo Tri and Josh Bendall)

## Instructions for Claude Code

1. Read this whole file, then read my existing codebase (framework, routes, styling, content). Keep my stack. Do not migrate frameworks unless I say so.
2. Summarize what you found and your plan before editing. Work on a branch named `redesign/crl-style`, commit after each step.
3. Match the feel and patterns of the reference. Do not copy its code, copy text, logo, images, or fonts. Use my own content everywhere.
4. If `./reference/` contains screenshots, view them and treat them as the source of truth where they conflict with this file.

## What the reference is (verified)

CRL is a curated library of creative references (books, albums, videos, playlists, films). It is a single, very restrained, typography-led site with one full-screen WebGL canvas as its hero. Awwwards tags its standout element as a "WebGL Wheel Gallery". It is built in Webflow with Lenis smooth scroll and a custom JS bundle that drives the canvas.

Note: in my inspection the preloader did not finish in a headless pane, so the exact wheel behavior below is inferred from the canvas, the element tag and the DOM class names, not seen live. Check it in a normal browser and adjust.

## Verified design tokens

**Color** (Awwwards lists the palette as just black and white)
- `--black: #000000`
- `--white: #ffffff` (default page background and light surfaces)
- `--dark: #a1a098` (warm gray, used for the preloader and as the dark swatch)
- `--grey: #d9d9d9`
- `--light-faded: #ffffff1a`, `--dark-faded: #3532331a` (10% overlays, hairlines)
- `--brand: #c6fb50` (lime, defined in the system, use sparingly or not at all)
- Theme tokens: background = white, text = black, borders = black.

**Typography**
- Single family everywhere: Neue Haas Grotesk Text Pro (commercial font, weights 400, 500, 700).
- Free substitute if I do not license it: "Inter Tight" or "Geist", with `font-feature-settings: "ss01"` off, weight 500. Ask me before adding a paid font.
- Body weight is 500, not 400. Line-height is 1 on almost everything, with 1.3 on the larger running text.
- Letter-spacing: -0.01em on small text, -0.03em on large text and headings.
- Sizes are fluid between a 20 and 120 viewport-rem range (about 320px to 1920px):
  - small label/body: ~12px to 16px (measured 13.7px at an 800px viewport)
  - text-large: 14px to 32px
  - text-xlarge: 30px to 64px
  - display: 37px to 120px (measured 73.5px at 800px, uppercase variant exists)
  - h1: 24px to 90px
- Hero headings are huge, uppercase in places, tightly tracked.

**Spacing and shape**
- Page margin: fluid 8px to 24px. Gutter: 16px. Section padding: 80px.
- Gap scale (rem): 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4.
- Radius: 0.5rem small, 1rem main, 100vw pills. Border width 0.094rem (hairline).
- Max content width: 80rem for text blocks.

## Layout and content structure (verified from the DOM)

- **Header**: wordmark "Creative Reference Library®" on one side, nav items "Index", "Library" with a count "(20)", "About".
- **Hero** (`home_hero`, 100vh): full-screen canvas behind the content. Overlaid on it:
  - top: a short intro paragraph in a text column
  - middle: a three-part oversized heading ("Creative / Reference Library®"), plus a pill button with an arrow
  - bottom: a category list with counts, shown as parenthesized numbers: Books (2), Albums (9), Videos (3), Playlist (2), Films & documentaries (2)
  - small version tag and year: "CRL® /V.01 (2026)"
- **About block**: numbered label "(1)" followed by one dense paragraph about the library's philosophy.
- **Categories block**: numbered label "(2)" followed by a second paragraph describing the formats.
- **Footer**: tiny credit initials ("J/B").
- Pattern to copy: parenthesized numerals for sections and counts, minimal chrome, almost no decoration, text and one canvas do all the work.

## How to apply it to my site

Map my content onto the CRL structure:
- My projects/work take the role of the library entries. Group them into 3 to 6 categories with counts in parentheses.
- Hero: oversized name or tagline (uppercase, -0.03em tracking, line-height 1), short intro paragraph, category list with counts at the bottom, version/year tag ("/V.01 (2026)" style).
- Hero visual: a full-screen canvas. Implement a "wheel gallery": project thumbnails arranged on a large rotating ring or arc that advances with scroll or drag, the active item eased to the front. Use OGL or Three.js (OGL preferred for size). Fallback for no-WebGL and reduced motion: a plain vertical or horizontal list of images.
- Index/Library page: a clean list of all items with number, title, category, year. Hover highlights the row.
- About: numbered paragraph blocks "(1)", "(2)" in the same oversized-but-light text style.
- Keep the palette to black, white and the warm gray. Add the lime only if I approve.

## Motion and interaction

- Smooth scroll with Lenis. Disable on `prefers-reduced-motion`.
- Preloader: centered logo mark on the warm gray (#a1a098) background, fades into the hero. Keep it under 2 seconds and never block content if assets fail.
- Custom cursor that changes state over interactive elements (the reference uses a "cursor parent" wrapper on buttons).
- Pill buttons with an arrow icon that slides on hover.
- Line-by-line text reveals on load (mask and translateY). Animate only `transform` and `opacity`.
- Easing: `cubic-bezier(0.16, 1, 0.3, 1)`, 600 to 900ms.
- Canvas: cap devicePixelRatio at 2, pause rendering when the tab is hidden or the canvas is off screen.

## Tech guidance

- Stay in my current framework. If I have none, use Astro or Next.js.
- Allowed new dependencies: `lenis`, `ogl` (or `three`), and `gsap` only if needed. Ask before adding anything else.
- Put all tokens above in one CSS variables file. Use `clamp()` for every fluid size.
- Images: lazy loaded, `width`/`height` set, modern formats, textures resized for GPU use (max 1024px).

## Accessibility and performance

- `prefers-reduced-motion`: no smooth scroll, no wheel animation, static list instead.
- The WebGL gallery must have a real DOM equivalent (links to each item) for keyboard and screen readers.
- Visible focus styles, semantic HTML, AA contrast (black on white passes easily, check text on the gray).
- Lighthouse targets: Performance 85+ (canvas sites are heavy), Accessibility 95+.

## Work plan

1. Audit repo and write a one-page summary of what exists.
2. Add tokens (color, type, spacing, radius, easing).
3. Build header, footer, grid, Lenis.
4. Home hero with text overlay, category counts, preloader.
5. Wheel gallery canvas with fallback.
6. Index/Library and project detail pages.
7. Motion pass (reveals, cursor, hover).
8. Responsive, accessibility and performance pass.

Show me screenshots after steps 4 and 5 before continuing.

## Do not

- Copy the reference's code, copy, imagery, logo, or its licensed font files.
- Delete or rewrite my content without asking.
- Break routes, SEO tags, or deployment config.
- Add the lime accent or extra libraries without asking.
