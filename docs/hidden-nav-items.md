# Tymczasowo ukryte pozycje menu

Te widoki są niedopracowane, więc nie ma ich w sidebarze — ale cały kod
za nimi został i działa przy wejściu bezpośrednim:

- `stypendia`
- `podania`
- `ankiety`

## Jak odblokować

1. W `usos/app.js` usuń dane id z setu `HIDDEN_NAV_ITEMS` (obok `MORE_NAV_ITEMS`).
2. Przywróć wzmianki w docsach:
   - `README.md` — linijka `- 🎓 Stypendia, podania i ankiety w tym samym panelu`
     w sekcji „Najważniejsze funkcje”,
   - `landing/llms.txt` — linijka `- Stypendia, podania i ankiety w tym samym panelu.`
     w sekcji „Funkcje”.
3. Nic więcej nie trzeba ruszać: `VALID_VIEWS`, `TITLES`,
   `UNVERIFIED_SOURCES`, rendery (`renderStypendia`, `renderPodania`,
   `renderAnkiety`), `navItemDot`, scraping (`PATHS` + fetch w `collectAll`)
   i skróty klawiszowe są nietknięte.

## Co przetestować po odblokowaniu

- Pozycje wracają do „Więcej” zalogowanym; niezalogowanym mają kłódkę
  (mechanizm `PUBLIC_VIEWS`).
- Kropka przy Anketach (`pendingSurveys`) po zwiniętym „Więcej”.
- Odtworzenie widoku po reloadzie (sessionStorage).
- `node --check usos/app.js`.
