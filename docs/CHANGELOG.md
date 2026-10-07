# Co nowego w USOS++

## 0.9.12

- **Budynek na mapie prosto z planu** — w szczegółach zajęć wiersz Budynek ma „Zobacz na mapie →" i otwiera mapkę kampusu ze znacznikiem (ten sam wzorzec co lista studentów); na dole jest skok do pełnej Mapy.
- **Skróty z menu działają przy wyłączonym panelu** — kliknięcie Planu, Ocen czy Studencich włącza panel i prowadzi do widoku zamiast na Mój USOSweb (albo w ogóle nic nie robić); menu z góry mówi, że klik włączy panel.
- **Eksport planu do kalendarza** — jeden przycisk „Eksportuj plan" z wyborem PNG, PDF i Kalendarz; Kalendarz pobiera cały semestr jako plik do Google, Apple i Outlooka (tylko tryb Dynamiczny, bo tylko on ma prawdziwe daty), z tytułami [W]/[C]/[L], salą, budynkiem i prowadzącym w każdym wpisie. Importuj do osobnego kalendarza — łatwo cofnąć.
- **Progres semestru na Panelu** — nowa pierwsza karta z ringiem: ile godzin zajęć już za Tobą, a ile w całym semestrze (liczone po czasie, więc 3-godzinne lab waży więcej niż lektorat). Gdy części grup nie da się dociągnąć, wynik ma „≈" i dopisek o niepełnych danych.
- **Kreska „teraz" w planie** — w trybie Dynamicznym, w bieżącym tygodniu, dzisiejsza kolumna ma czerwoną linię na aktualnej godzinie jak w normalnym kalendarzu; pełznie co minutę, a w nocy i poza osią godzin się chowa.
- **Cudze plany pod Twoim planem** — w widoku Planu jest przełącznik „Czyj plan”: wklej link do udostępnionego planu (token spod share w USOS albo os_id, gdy osoba włączyła udostępnianie zalogowanym) i przeglądaj go w tej samej siatce, z nawigacją tygodni. Linki-tokeny żyją ok. 14 dni — gdy wygaśnie, plan sam o tym powie. W tej samej sekcji pokażesz też własny link do wysłania komuś (przycisk Kopiuj) i na żywo zobaczysz, czy masz włączone stałe udostępnianie dla zalogowanych.

## 0.9.11

- **Klasyczny USOS też żyje** — widżety na stronach klasycznych pokazują uczciwy stan pusty zamiast znikać (średnia, plan, podsumowanie w Mój USOSweb — zaległości widać w podsumowaniu, osobny widżet na stronie Płatności wypadł jako zbędny), a w Mój USOSweb jest „Edytuj układ”: przestawianie okienek między kolumnami (mysz, strzałki), ukrywanie do duszków i pomarańczowa kreska pokazująca, gdzie karta wyląduje.
- **Mini „Ten tydzień” na klasycznym planie** — nad planem widać podsumowanie jak w panelu: liczba zajęć i godziny, najbardziej zapracowany dzień, dni wolne i rozbicie na typy; działa w widoku tygodniowym w formacie HTML nowym i starym (w starym liczy z siatki tabeli, łącznie z nakładającymi się zajęciami), a w widoku semestralnym i obrazkowym się nie pokazuje, bo tam nie ma pojedynczego tygodnia do podsumowania.
- **Postęp studiów z prawdziwymi danymi** — karta „Zaliczenia etapów” pokazuje punkty (razem, z etapu, z poprzednich), wymagania warunkowe i pełne, listę braków oraz rozwijane wymagania przedmiotowe z podpięciami i statusami; na dole stan rozliczenia programu z przyciskiem do klasyka (samo zgłoszenie zostaje w USOS), a na dashboardzie przy „Etapie studiów” jest link „więcej →”.

## 0.9.10

- **Generator: nakładki obok siebie, nie na sobie** — terminy w jednym slocie dzielą się na równe pasy lewo/prawo (stary termin i nowy draft też), każdy od razu klikalny; koniec z rozwijanym „N grup” i hoverowaniem.
- **Generator: kropki dzielone na typy zajęć** — kropka statusu zapełnia się ułamkowo (np. pół przy samym wykładzie), a dymek rozpisuje stan per typ.
- **Generator: liczniki zajętości jako zajęte miejsca** — w Zapisach widać „23/26” i „pełna” zamiast wolnych miejsc.
- **Generator: poprawki klikania** — klik bloku rozwija przedmiot, klik przekreślonego terminu cofa decyzję, a odkliknięcie niezapisanej grupy wraca do zapisanej zamiast fałszywego komunikatu o usuwaniu.
- **mLegitymacja w Więcej** — status zamówienia (Oczekuje, Do odbioru, Odebrana…), daty i przycisk „Otwórz w USOS”; do odbioru jest kod QR z klasyka, jego wersja tekstowa i kod aktywacyjny do mObywatela, z kopiowaniem. Kody siedzą za bramką „Pokaż kod odbioru” i chowają się przy wyjściu.
- **Plan pokazuje wszystko** — zajęcia co 2 tygodnie (P/N obok siebie) już nie znikają z Ogólnego, poranne terminy (np. 9:15) wchodzą do boxu Zajęcia, a Ogólny ostrzega, gdy miesza semestry.
- **Dynamiczny bez fałszywego „wolne”** — gdy USOS nie odda terminów, jest „Spróbuj ponownie” zamiast pustego tygodnia, a autorefresh już nie czyści dociągniętych sal i prowadzących. Eksport PNG ma znaczniki (P)/(N) jak ekran.
- **Wyłącznik awaryjny w menu** — w Strefie niebezpiecznej widać stan wtyczki, a po wyłączeniu menu mówi wprost, co jest nieaktywne, z szybką ścieżką powrotu.

## 0.9.9

- **Generator: tryb Planowanie i Zapisy** — przełącznik nad podglądem planu; w Zapisach bloki i lista pokazują wolne miejsca, w Planowaniu plan jest czysty.
- **Generator: klik pokazuje terminy** — klik bloku rozwija przedmiot i odpala duchy (wszystkie w Planowaniu, tylko wolne z licznikami w Zapisach), podglądany zapisany blok ma outline, a Wybrane przedmioty mają przycisk zapisów.
- **Generator: sekcja Moje plany** — wersje planów w osobnej sekcji z kartami (przedmioty, grupy, godziny, kolizje, plan główny) zamiast zakładek; usuwanie z potwierdzeniem, bez przycisku czyszczenia.
- **Sale i prowadzący w planie** — bloki zajęć pokazują salę z budynkiem i prowadzącego, dociągane ze stron grup.
- **Eksport planu do PDF i PNG** — przy planie są przyciski Eksport PDF (sam plan na jednej stronie, bez dopisków przeglądarki) i Eksport PNG (obrazek tego, co widać, z logo USOS++); pustej soboty i niedzieli już nie pokazuje.

## 0.9.8

- **Plan zajęć z Twoich grup** — zamiast suchego terminarza USOSa widzisz plan ułożony z grup, na które jesteś zapisany: przełącznik Dynamiczny/Ogólny, widok Tygodnia i Listy, nawigacja między tygodniami, a po kliknięciu zajęć szczegóły z salą, budynkiem i prowadzącym.
- **Panel mówi, co dalej** — box Zajęcia odlicza na żywo do najbliższych terminów (21 dni do przodu), a obok Podsumowanie tygodnia pokazuje liczbę zajęć i godzin, najbardziej zapracowany dzień i dni wolne.
- **Studenci — kto z Tobą studiuje** — nowy widok zbiera osoby z list Twoich grup w jedną listę ze wspólnymi przedmiotami. Jest wyszukiwarka po nazwisku i przedmiocie, wykluczanie całych przedmiotów oraz tryb „Bez wykładów”; filtry zapamiętują się między wejściami.
- **Generator ostrzega przed kolizjami** — zmiana terminu jasno pokazuje, która grupa zostanie zastąpiona (na siatce i przy przycisku zapisu), a nakładające się terminy widać także w podglądzie — łącznie z alternatywnymi grupami tego samego przedmiotu.
- **W podglądzie widać Twój wybór** — aktualnie zapisana grupa rysuje się stylem „pomiędzy” (pełny kolor + przerywana obwódka z dopiskiem „teraz”), więc nie ginie wśród propozycji. Kliknięcie bloku na siatce rozwija jego przedmiot na liście i do niego przewija.
- **Uczciwa średnia** — do średniej liczą się tylko końcowe oceny liczbowe; wpisy bez oceny już jej nie zafałszowują.
- **Mapa znowu działa** — widok budynków ładuje się poprawnie zamiast komunikatu o błędzie.
- **Studenci bez wieszania** — odświeżenie strony na Studenciach, Egzaminach czy Zapisach dociąga dane samo, a gdyby coś się zawiesiło, jest przycisk „Spróbuj ponownie”.
- **Nowe menu rozszerzenia** — więcej skrótów (Studenci, Mapa, Zapisy, Planer) z własnymi ikonami, skróty przełączają widok w otwartej karcie, widać najbliższe zajęcia, a wyłącznik całej wtyczki trafił na dół jako Strefa niebezpieczna.
- **Tryb ciemny bez białych mignięć** — przewijanie za krawędź ekranu nie błyska już na biało, w panelu i w menu.

## 0.9.7

- **Poprawki pod maską** — szybsze działanie, dodatkowe usprawnienia bezpieczeństwa i naprawiony błąd wykryty tuż po wydaniu 0.9.6.

## 0.9.6 „Zapisy pod plan"

- **Zapisy pod plan** — przy grupach widać zajętość miejsc (pełne oznaczone), przy turach Twój stan zapisu; gwiazdką oznaczasz główny plan, a grupy mówią, czy do niego pasują. Strona zapisów w jednym miejscu: status rejestracji, zajętość i skok do grup przedmiotu.
- **Plany z własnymi nazwami** — zamiast „Plan 1…5" nazwiesz każdy tak, żeby od razu wiedzieć, co w nim jest.
- **Zdjęcia w Aktualnościach** — ogłoszenia z plakatami i ilustracjami wyglądają teraz tak, jak przygotowała je uczelnia.
- **Generator bierze od razu wszystko** — lista przedmiotów do układania planu startuje w pełni zaznaczona; odhaczasz tylko te, których nie chcesz.
- **„Otwórz w USOS" już nie ucieka** — po przejściu na klasyczny widok karta zostaje klasyczna, dopóki sam nie wrócisz do panelu.

## 0.9.5

- **Panel IRK dla kandydata** — ulubione kierunki z gwiazdką, porównywarka do 3 ofert obok siebie, filtry zgłoszeń (opłata, kwalifikacja) z licznikiem nieprzeczytanych; sekcje konta dociągają się leniwie, więc start jest szybszy.
- **Publiczny Katalog uczelni** — sporo treści USOSa jest jawnych: bez konta przejrzysz jednostki, przedmioty, kierunki, programy studiów i budynki z mapą.
- **Lista budynków ładuje się od razu** — bez wcześniejszego zaglądania na Mapę.
- **Kłódki dla niezalogowanych** — na pierwszy rzut oka widać, co działa bez konta, a co wymaga zalogowania (wyszarzone, z kłódką).
- **Ukryte Stypendia, Podania i Ankiety** — niedopracowane widoki zniknęły z menu; wrócą, gdy będą gotowe.

## 0.9.4

- Aktualny numer wersji w `manifest.json`.
