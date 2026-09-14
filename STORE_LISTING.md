# Wpis w Chrome Web Store — USOS++

Materiały do wklejenia w [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
przy publikacji rozszerzenia.

## Krótki opis (max 132 znaki, pole "Summary")

```
Nowoczesna wersja systemu USOSweb: oceny, plan zajęć, płatności i egzaminy w jednym, szybkim panelu — bez zbędnego klikania.
```

(124 znaki — dokładnie ten sam tekst, co pole `description` w manifeście.)

## Pełny opis (pole "Description" na stronie sklepu)

```
USOS++ to nowoczesna wersja systemu USOSweb — ten sam system, ale w
jednym, szybkim panelu zamiast rozjeżdżających się podstron. Bez
osobnego logowania i bez utraty żadnej funkcji, z której korzystasz na
co dzień.

Na pierwszy rzut oka:
• Oceny i średnia — bez liczenia w kalkulatorze
• Plan zajęć — czytelny, na dziś i na cały tydzień
• Płatności — ile i za co zostało do zapłaty
• Egzaminy i sprawdziany — terminy w jednym miejscu
• Szybkie wyszukiwanie przedmiotów, jednostek i programów studiów
• Aktualności wydziału bez wchodzenia w USOSmail

Dodatkowo:
• Czytelny, estetyczny redesign z trybem ciemnym
• Wbudowane centrum powiadomień o nowych ogłoszeniach — żadnych
  powiadomień systemowych
• Pasek szybkich akcji i drobne podpowiedzi (np. średnia, zaległości
  płatnicze) działające nawet wtedy, gdy pełny redesign jest wyłączony
• Do tego stypendia, podania i ankiety — też w tym samym panelu
• Jasne oznaczenie, gdy dana podstrona jest jeszcze w wersji beta

Jak to działa:
USOS++ nie korzysta z żadnego wewnętrznego, niepublicznego API USOS-a i
nie omija żadnych zabezpieczeń strony. Czyta wyłącznie to, co Twoja
zalogowana przeglądarka i tak już widzi na stronach USOSweb, i buduje z
tego lepszy interfejs — lokalnie, u Ciebie w przeglądarce. Nic nie trafia
na żaden zewnętrzny serwer. Szczegóły: polityka prywatności.

Zweryfikowane na USOSweb Politechniki Wrocławskiej. Obsługę innej
uczelni na tej samej platformie USOS można dodać jednym kliknięciem, z
jawnym potwierdzeniem uprawnień w oknie Chrome.

Projekt studencki, nieoficjalny i niezwiązany formalnie z USOS ani z
uczelnią. Wciąż w wersji beta — część podstron może jeszcze nie działać
idealnie, a rozszerzenie zawsze Cię o tym uprzedzi.
```

## Kategoria

`Productivity` (lub `Education` — dashboard pozwala wybrać jedną kategorię, `Productivity` lepiej opisuje realną funkcję).

## Zakładka "Privacy practices" w dashboardzie

**Single purpose** (opis jednego, konkretnego celu rozszerzenia):

```
USOS++ przebudowuje interfejs strony USOSweb (system dziekanatowy dla
studentów polskich uczelni) w jeden, szybszy panel — czytając wyłącznie
treści stron, które zalogowany użytkownik i tak już widzi we własnej
przeglądarce, bez użycia wewnętrznego API USOS-a.
```

**Uzasadnienia uprawnień** (jedno pole tekstowe per uprawnienie —
skopiuj odpowiedni fragment z [PRIVACY.md](PRIVACY.md#uprawnienia-i-ich-wykorzystanie)):

| Uprawnienie | Uzasadnienie (skrót) |
|---|---|
| `storage` | Zapis ustawień użytkownika (włączony/wyłączony redesign, motyw, przełączniki funkcji) w `chrome.storage.sync`. |
| `activeTab` | Popup sprawdza adres/tytuł tylko aktualnie otwartej karty, tylko gdy użytkownik go otworzy — bez stałego dostępu do przeglądania. |
| `scripting` | Rejestracja skryptu redesignu na dodatkowej domenie USOSweb, wyłącznie po świadomym kliknięciu użytkownika i potwierdzeniu uprawnienia przez Chrome. |
| `host_permissions` (`web.usos.pwr.edu.pl`) | Wstrzyknięcie redesignu i odczyt USOSweb Politechniki Wrocławskiej, na której użytkownik jest zalogowany. |
| `optional_host_permissions` (`*://*/*`) | Żądane dynamicznie i tylko dla jednej, konkretnej domeny — kiedy użytkownik sam poprosi o dodanie obsługi innej uczelni. |

**Czy rozszerzenie zbiera dane użytkownika?**
→ **Nie.** Wszystkie dane pozostają lokalnie w przeglądarce użytkownika;
nic nie jest wysyłane, sprzedawane ani udostępniane. (Zaznacz w
dashboardzie: brak zbierania danych / "I do not collect or use user
data" — jeśli formularz wymusi wybór kategorii danych, opisz to jako
"Website content" używane wyłącznie lokalnie, nigdy nie przesyłane.)

**Remote code**
→ **Nie.** Cały kod jest zawarty w pakiecie rozszerzenia (brak `eval`,
brak zdalnie ładowanych skryptów) — zweryfikowane w kodzie.

**Adres polityki prywatności**
→ link do [`PRIVACY.md`](PRIVACY.md) w repo GitHub, np.
`https://github.com/zuukie/USOS--/blob/main/PRIVACY.md` (po wypchnięciu
zmian na `main`).

## Zrzuty ekranu / grafika

Dashboard wymaga min. 1 zrzutu ekranu (1280×800 lub 640×400) i ikony
128×128 (już jest: [icons/icon128.png](icons/icon128.png)). Warto dorobić
1–3 zrzuty pokazujące: dashboard główny, wyszukiwarkę w topbarze i
tryb ciemny.

## Przed wgraniem — zrobione już w tej sesji

- [x] Wersja ustawiona na `0.9.0` w [manifest.json](manifest.json) (nadal beta — podnieś do `1.0.0`, gdy uznasz, że jest gotowe na pełne wydanie).
- [x] Sprawdzono `node --check` na wszystkich plikach JS — brak błędów.
- [x] Brak `console.log`/`debugger`/`TODO`/`eval` w kodzie.
- [x] Uprawnienia w manifeście odpowiadają faktycznemu użyciu w kodzie (`storage`/`activeTab`/`scripting` — sprawdzone ponownie po dodaniu Stypendiów/Sprawdzianów/Podań/Ankiet i widżetów na stronach klasycznych; żadna z tych funkcji nie wymagała nowego uprawnienia).
- [x] Dodano [.gitignore](.gitignore) (`.DS_Store`, `*.zip`).
- [x] Dodano [PRIVACY.md](PRIVACY.md) — zaktualizowane o nowe podstrony czytane przez rozszerzenie.
- [x] Opis (krótki i długi) przepisany, żeby odzwierciedlał pełny aktualny zestaw funkcji.

## Przed wgraniem — do zrobienia przez Ciebie

- [ ] Wypchnij zmiany na GitHub, żeby link do `PRIVACY.md` działał.
- [ ] Zrób 1–3 zrzuty ekranu rozszerzenia w akcji.
- [ ] Spakuj do ZIP-a **tylko** pliki potrzebne do działania — pomiń
      `design/`, `design.zip`, `scripts/gen_icons.py` i
      `USOS++ Brand System.pdf` (to zasoby deweloperskie, nieużywane w
      manifeście; nie zaszkodzą w recenzji, ale niepotrzebnie powiększają
      pakiet). Najprościej:
      ```bash
      zip -r usospp.zip manifest.json background content popup shared fonts icons -x '*.DS_Store'
      ```
- [ ] Zarejestruj konto dewelopera Chrome Web Store (jednorazowa opłata
      $5), jeśli jeszcze nie masz.
- [ ] Wgraj ZIP, wklej opisy i uzasadnienia z tego pliku, dodaj zrzuty
      ekranu i wyślij do recenzji.
