# Architektura USOS++

Jeden Chrome Extension, jeden `manifest.json`, jeden build (brak bundlera —
pliki JS ładowane bezpośrednio jako kolejne content scripty i komunikujące
się przez współdzielone `window.USOSPP_*`).

## core/

Kod niezależny od USOSweb i IRK:

- `state.js` — ustawienia (`enabled`, `irkEnabled`, `darkMode`, `features`) w `chrome.storage.sync`, ES module używany przez popup. `enabled`/`irkEnabled` to dwa niezależne przełączniki w JEDNYM systemie ustawień — włączenie dashboardu na karcie IRK nie powinno dotykać USOS na innej karcie (i odwrotnie).
- `state-bridge.js` — ten sam storage, w wersji dla content scriptów (izolowany świat JS, bez `import`).
- `detect.js` — rejestr detektorów platformy: `USOSPP_CORE.registerDetector(platform, matchFn)` / `USOSPP_CORE.detectPlatform()`. Nie zna selektorów USOS/IRK — każdy moduł rejestruje się sam.
- `sanitize-html.js` — `USOSPP_CORE_SANITIZE.sanitizeHtml(nodes, doc, allowedTags?)`: czyści HTML z zaufanego, ale nie wykonywanego, pobranego dokumentu (allowlist tagów) przed wstawieniem go do naszego DOM. Współdzielone przez `usos/adapters.js` (Aktualności) i `irk/adapters.js` (Aktualności + opisy kierunków) — pierwszy realny przypadek "obu modułów", nie spekulacja.
- `ui/design-system.css` — tokeny (kolory/spacing/typografia) + generyczne komponenty (Card, Modal, Dropdown, Badge, Notification, hub-tiles, przyciski, formularze, sidebar/topbar shell). Wydzielone z `usos/usos.css` w momencie, gdy `irk/` dostał pierwszy realny ekran (dashboard) — patrz niżej.

## usos/

Wszystko specyficzne dla USOSweb: `adapters.js` (parsery DOM per instalacja uczelniana), `scraping.js` (fetch+parse wielu podstron), `planner-store.js` (generator planu zajęć), `app.js` (SPA — sidebar/topbar/modale + widoki), `inject.js` (punkt wejścia), `usos.css` (TYLKO klasy specyficzne dla widoków USOS — timetable, planner, classic-widgets, kalkulator ECTS; reszta w `core/ui/design-system.css`).

## irk/

Realny, ale celowo ograniczony moduł dla Internetowej Rekrutacji Kandydatów, zweryfikowany na żywo (2026-09-14) na `irk.usos.pwr.edu.pl`:

- `detect.js` — heurystyka wykrywania IRK (nazwa systemu w tytule/nagłówku/stopce, odporna na odmianę).
- `adapters.js` — parsery: `recruitmentSlug()`/`recruitmentLabel()` (który `/pl/{home,offer,news}/<SLUG>/...` jest aktualnie wybrany), `getOfferList` (Oferta — kierunki pogrupowane alfabetycznie), `getProgrammeDetail` (szczegóły kierunku: tabela pól, status zapisów, opisane sekcje), `getFieldVariants` (kierunek oferowany w kilku wariantach — inne miasto/tryb studiów — linkuje do huba `/field/<kod>/` zamiast prosto do `/programme/...`; wybór wariantu prowadzi z powrotem do `getProgrammeDetail`), `getNews` (Aktualności).
- `scraping.js` — `collectAll(slug)` łączy Ofertę + Aktualności w jeden model danych; `slug === null` gdy odwiedzający nie wybrał jeszcze rekrutacji. `fetchUnitsByUrl(urls)` dociąga "Jednostkę organizacyjną" dla każdego kierunku z jego własnej strony szczegółów (równolegle, raz) — **celowo nie** przez sesyjny filtr strony (`/filter/?org_units=...`), bo ten zmienia stan sesji i zanieczyszcza kolejne, niefiltrowane zapytania (zweryfikowane live).
- `app.js` — SPA (Dashboard / Aktualności / Oferta z wyszukiwarką i filtrem wydziałów / szczegóły kierunku / wybór wariantu), ten sam wzorzec co `usos/app.js`, dużo mniejszy zakres.
- `inject.js` — mount/unmount sterowany przez `irkEnabled`, chowa natywny `header`/`main`/`footer#footer`.

**Celowo NIE zeskrobane**: „Terminy”/„Wymagane dokumenty”/„Opłaty” prowadzą z IRK na OSOBNĄ stronę uczelni (np. `rekrutacja.pwr.edu.pl`) — to nie jest część IRK/MUCI i nie jest ustandaryzowane między uczelniami, więc zostają zwykłymi linkami zewnętrznymi (`data-action="openIrk"`), nie parserem. „Status zgłoszenia” i „wyniki kwalifikacji” wymagają zalogowanego konta kandydata, którego nie mieliśmy do weryfikacji — też zostają linkiem zewnętrznym zamiast zgadywanego parsera (patrz "UNVERIFIED" niżej).

**UNVERIFIED**: `getProgrammeDetail`'s status zapisów rozpoznaje tylko stan "zamknięte" (`.register-disabled`, zweryfikowany live) — stan "otwarte" (prawdziwy termin, przycisk zapisu) to zgadywana nazwa klasy (`.register-enabled`), bo żadna tura nie była akurat otwarta przy weryfikacji. Widok pokazuje wtedy `.usospp-beta-notice`, ten sam wzorzec co niezweryfikowane sekcje USOS.

Nie ma statycznego wpisu w `manifest.json`'s `matches` (nie zakładamy jednej domeny IRK) — moduł jest **wyłącznie dynamiczny**: `popup.js` wykrywa kartę wyglądającą jak IRK (po tytule/adresie karty — słabszy podzbiór tego, co `irk/detect.js` sprawdza na pełnym DOM) i pokazuje „Dodaj obsługę tej uczelni (IRK)”, która przez `chrome.permissions.request` + `background.js`'s `registerModule(pattern, 'irk')` (ten sam mechanizm co USOS) rejestruje zestaw plików IRK dla tej jednej domeny. Po dodaniu, popup pokazuje realny przełącznik Włącz/Wyłącz (`irkEnabled`).

Stopka PWr-owego IRK ma ten sam podpis „Międzyuniwersyteckie Centrum Informatyzacji” co USOSweb — sugeruje wspólny szablon MUCI, ale to nie jest jeszcze potwierdzone na drugiej uczelni; selektory w `irk/adapters.js` mogą wymagać dostrojenia.

**Zasada bezpieczeństwa IRK**: żadnych automatycznych, nieodwracalnych operacji (wysyłka zgłoszenia, zatwierdzanie dokumentów, zmiana preferencji, płatności) bez wyraźnej akcji użytkownika. `irk/app.js` dziś tylko czyta i linkuje — niczego nie wysyła.

## Detekcja platformy

`usos/adapters.js` rejestruje `isUsosPage` (to samo `hasModernShell() || looksLikeUsos()`, którego już dziś używa `selectAdapter()`). `irk/detect.js` rejestruje `looksLikeIrk`. `USOSPP_CORE.detectPlatform()` zwraca `'usos'`, `'irk'` albo `'unknown'` — `'unknown'` oznacza, że żaden moduł się nie uruchamia.

Dziś aktywność `usos/` i tak wynika z `manifest.json`'s `matches` (host USOSweb) + istniejącej logiki `selectAdapter()` w `inject.js`; aktywność `irk/` wynika z dynamicznej rejestracji przez popup (patrz wyżej). `detectPlatform()` to wspólna warstwa nad tym samym sygnałem, używana przez oba `inject.js` jako pierwszy guard.

## Dodawanie nowych funkcji

- Kod USOS-specyficzny → `usos/`. Kod IRK-specyficzny → `irk/`. Nigdy odwrotnie i nigdy w `core/` „na wszelki wypadek".
- Coś trafia do `core/` tylko gdy realnie używają tego oba moduły (dziś: storage, detekcja, sanitizer HTML, design system).
- Kolejne widoki IRK (Jednostki, Status zgłoszenia, Terminy z zewnętrznej strony uczelni jako link) — dodawać jako kolejne `renderX()` w `irk/app.js` + `getX()` w `irk/adapters.js`, zweryfikowane na żywej stronie tak jak `getOfferList`/`getProgrammeDetail`/`getNews`. Nie zgadywać selektorów bez realnej strony do sprawdzenia — oznaczać `UNVERIFIED` i degradować łagodnie, jak reszta projektu.
- Adaptery pod kolejne uczelnie: `usos/adapters.js` już ma ten wzorzec (`pwrAdapter` + `legacyAdapter` placeholder) — jeśli kiedyś będzie potrzebny per-uczelniany wariant (dla USOS lub IRK), dodać podobnie, bez przebudowy całości.
