# Bilde-quiz på gruble.net (Elementor)

Quizen lever som statiske filer i `frontend/` i dette repoet. Designet er tilpasset gruble.nets fargeblokker (rødt panel, fersken-knapper, kremkort, **Outfit**-typografi) og wrapper **`#gruble-visual-quiz-root`**.

## Filer du trenger

| Fil | Formål |
|-----|--------|
| `visual-quiz.css` | Layout, panel, typografi, variabler |
| `styles.css` | Grunnleggende quiz-komponenter (resultat, protest-layout, m.m.) |
| `visual-quiz-shared.css` | Gruble-spesifikke overstyringer scope’et til `#gruble-visual-quiz-root` + protest |
| `visual-quiz.js` | Logikk og API |

Last filene opp til et **fast sted** (f.eks. undertema, mediebibliotek med direkte lenke, eller samme host som API-et) og bruk **full URL** i lenker.

## Kolonnelayout (desktop / mobil)

1. I Elementor: legg en **seksjon** med **flere kolonner** på desktop (som forsiden).
2. Sett **én kolonne** til quizen og lim inn HTML-widgeten der.
3. I kolonneinnstillinger: **bredde** som passer raden; på **mobil** (Elementors responsive modus) sett kolonnen til **100 %** slik at quizen blir **solo-kolonne** under de andre blokkene.

Quizen bruker `width: 100%` og `max-width: 100%` på `#gruble-visual-quiz-root`, så den fyller kolonnen den står i.

## HTML-widget (fragment)

1. Åpne [`frontend/visual-quiz.html`](../frontend/visual-quiz.html).
2. Kopier innholdet fra `<div id="gruble-visual-quiz-root" ...>` gjennom hele `</div>` som lukker root (rett før protest-modal).
3. Kopier hele **protest-modal**-blokken (`<div id="protest-modal" ...> ... </div>`).
4. Lim inn i Elementor → **HTML**-widget.

**Merk:** Mange WordPress-installasjoner **fjerner eller blokkerer `<script>`** i HTML-widget. Da har du disse alternativene:

- **Anbefalt:** Legg quizen i en **iframe** som peker til den hostede `visual-quiz.html` (da kjører script normalt).
- Eller: **Elementor Custom Code** / **Code Snippets** / kortkode-plugin som skriver ut `<script src="https://DITT-DOMENE/.../visual-quiz.js" defer></script>` i **footer** på siden der quizen vises.
- Eller: **WPCode** / tilsvarende for inline script.

Script-tag (tilpass URL):

```html
<script src="https://EKSEMPEL.NO/sti/visual-quiz.js" defer></script>
```

## CSS

**Alternativ A – tre lenker i `<head>` via Elementor (Site Settings → Custom CSS fungerer ikke for eksterne link-tags):**  
Bruk et plugin som tillater å legge inn `<link rel="stylesheet" href="...">`, eller legg lenkene i **undertemaets `header.php`**, eller bruk **iframe** (da trenger du ikke å lime inn CSS på WP).

**Alternativ B – Tilpass → Tilpass CSS:**  
Lim inn innholdet fra [`frontend/gruble-visual-quiz-embed.css`](../frontend/gruble-visual-quiz-embed.css) etter at du har satt riktige `@import`-URL-er til de tre CSS-filene, **eller** lim inn de tre filene etter hverandre (én lang CSS) i tilpasset CSS.

## Iframe (enkleste drift)

1. Host `visual-quiz.html` (samme mappe som css/js).
2. Quizen sender **`postMessage`** til foreldervinduet med type **`gruble-visual-quiz-height`** og feltet **`height`** (piksler), slik at du kan sette `iframe.style.height` og unngå dobbel scrolling inni siden.

### `embed_parent` (anbefalt)

Legg inn **foreldresidens origin** som query-parameter (URL-enkodet), f.eks. for `https://gruble.net`:

- Rå verdi: `https://gruble.net`
- I `src`: `?embed_parent=https%3A%2F%2Fgruble.net`

Da bruker quizen denne som **mål-origin** for `postMessage` i stedet for `"*"`, som er tryggere.

### HTML + lytter på foreldresiden

- **`QUIZ_HOST`**: origin der `visual-quiz.html` ligger (må være lik starten av `iframe.src`, f.eks. `https://gruble-quiz-api.onrender.com`).
- **`embed_parent`**: URL-enkodet origin for **WordPress-siden** (f.eks. `https://gruble.net` → `https%3A%2F%2Fgruble.net`).

```html
<iframe
  id="gruble-visual-quiz-iframe"
  src="https://QUIZ_HOST/sti/visual-quiz.html?embed_parent=https%3A%2F%2Fgruble.net"
  title="Gruble bilde-quiz"
  style="width:100%;min-height:400px;border:0;border-radius:28px;display:block;"
  loading="lazy"
></iframe>
<script>
  (function () {
    var QUIZ_HOST = "https://QUIZ_HOST";
    window.addEventListener("message", function (e) {
      if (e.origin !== QUIZ_HOST) return;
      if (!e.data || e.data.type !== "gruble-visual-quiz-height") return;
      var h = Number(e.data.height);
      if (!Number.isFinite(h) || h < 1) return;
      var el = document.getElementById("gruble-visual-quiz-iframe");
      if (el) el.style.height = Math.ceil(h) + "px";
    });
  })();
</script>
```

**WordPress / Elementor:** HTML-widgeten kan strippe `<script>`. Legg da lytteren i **Elementor → Custom Code**, **WPCode**, undertema **footer**, eller tilsvarende — med samme `QUIZ_HOST`-sjekk.

Uten `embed_parent` fungerer quizen fortsatt, men sender med target `"*"`. Foreldrelytteren bør uansett **alltid** sjekke `e.origin` mot quiz-hosten som vist over.

## ID-er som ikke bør dupliseres

Kun **én** quiz per side: `id="gruble-visual-quiz-root"`, `id="protest-modal"`, `id="visual-app"` osv. må være unike i DOM.
