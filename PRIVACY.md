# Polityka prywatności — USOS++

Ostatnia aktualizacja: 2026-09-14

USOS++ to rozszerzenie do Chrome, które przebudowuje interfejs USOSweb
(np. `web.usos.pwr.edu.pl`) na nowocześniejszy, jednostronicowy panel.
Rozszerzenie **nie zbiera, nie sprzedaje i nie wysyła żadnych danych
użytkownika na żadne serwery** — całość działa lokalnie, w przeglądarce
użytkownika.

## Jakie dane są odczytywane

USOS++ odczytuje wyłącznie treści stron USOSweb, które zalogowany
użytkownik i tak już widzi we własnej przeglądarce (oceny, plan zajęć,
egzaminy, sprawdziany, płatności, stypendia, podania, ankiety,
ogłoszenia, dane katalogu przedmiotów/jednostek/programów). Robi to
zwykłym `fetch`/parsowaniem DOM tej samej strony, na której użytkownik
jest zalogowany — z jego własną sesją przeglądarki.

Rozszerzenie **nigdy** nie korzysta z wewnętrznego, zabezpieczonego
tokenem CSRF proxy USOS API (`usosapiProxy.php`) — ten endpoint w swojej
własnej odpowiedzi wprost zabrania takiego użycia — i nigdy nie próbuje
obchodzić zabezpieczeń strony (np. `X-Frame-Options`).

## Gdzie te dane trafiają

- **Nigdzie poza urządzeniem użytkownika.** Dane pobrane ze stron USOSweb
  są przetwarzane w pamięci karty i wyświetlane w przebudowanym
  interfejsie. Nie są wysyłane do żadnego serwera należącego do autora
  rozszerzenia ani do jakiejkolwiek strony trzeciej.
- Ustawienia rozszerzenia (włączony/wyłączony redesign, motyw, włączone
  funkcje) są zapisywane w `chrome.storage.sync`, czyli standardowej,
  szyfrowanej synchronizacji ustawień Google Chrome powiązanej z kontem
  użytkownika — nie mamy do tego dostępu poza samą przeglądarką
  użytkownika.
- Centrum powiadomień w USOS++ (dzwonek w górnym pasku) zapisuje lokalnie
  (`chrome.storage.local`, tylko na urządzeniu użytkownika) sygnaturę
  ostatnio widzianych ogłoszeń, żeby wiedzieć, czy pojawiło się coś nowego
  od ostatniej wizyty w zakładce Aktualności. Nic z tego nie opuszcza
  urządzenia i jest usuwane po odinstalowaniu rozszerzenia. USOS++ nie
  wysyła żadnych powiadomień systemowych — wystarcza wbudowane centrum
  powiadomień.

## Brak śledzenia i reklam

USOS++ nie zawiera żadnego kodu analitycznego, telemetrii, reklam ani
narzędzi śledzących. Nie ładuje też żadnego zdalnego/kodu wykonywalnego —
cały kod rozszerzenia jest zawarty w jego pakiecie i podlega przeglądowi
Chrome Web Store.

## Uprawnienia i ich wykorzystanie

- **`storage`** — zapisuje lokalnie/w Chrome Sync tylko ustawienia
  użytkownika (patrz wyżej).
- **`activeTab`** — pozwala popupowi rozszerzenia bezpiecznie sprawdzić
  adres i stan aktualnie otwartej karty tylko w momencie, gdy użytkownik
  sam otworzy popup — bez stałego dostępu do historii przeglądania.
- **`scripting`** — służy wyłącznie do zarejestrowania skryptu redesignu
  na dodatkowej domenie USOSweb innej uczelni, i tylko wtedy, gdy
  użytkownik sam o to poprosi i potwierdzi żądanie uprawnienia w oknie
  Chrome.
- **`host_permissions` (`web.usos.pwr.edu.pl`)** — umożliwia wstrzyknięcie
  skryptu redesignu i odczyt strony USOSweb Politechniki Wrocławskiej,
  na której użytkownik jest już zalogowany.
- **`optional_host_permissions` (`*://*/*`)** — nie jest używane
  automatycznie. Chrome prosi o nie dopiero wtedy, gdy użytkownik kliknie
  „Dodaj obsługę tej uczelni” dla konkretnej, otwartej właśnie domeny
  innego USOSweb — i wtedy dotyczy tylko tej jednej domeny.

## Kontakt

Pytania dotyczące prywatności: [zuukie/USOS++ na GitHubie](https://github.com/zuukie/USOS--)
(zgłoszenie w zakładce Issues) lub e-mail: michalwyszk@gmail.com.
