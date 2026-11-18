---
name: homeai-improve
description: "Realizace a koordinace změn HomeAI / StrataDashSeek, produktového QA a párovaných benchmarků. Použij při zlepšování této aplikace od konkrétního problému po ověřený uživatelský výsledek."
---

# Zlepšování HomeAI

Navazuj na rozpracovanou práci a doruč nejbližší použitelný výsledek v rozsahu zadání. Samotný dotaz na stav nebo návrh zůstává čtením či doporučením. Skill nepřidává oprávnění; novější pokyny uživatele mají přednost před jeho postupem.

**Trvalé projektové oprávnění:** uživatel 17. 11. 2026 přímo schválil současné i budoucí opravy HomeAI / StrataDashSeek do `main` a všechny potřebné projektové přenosy mezi jeho pracovním prostorem, GitHubem projektu a stávajícím Vast prostředím. Souhlas platí do změny či odvolání; nežádej jej znovu pro jednotlivé SHA, merge ani dávky těchto přenosů. Přesné výroky a zdroj jsou v osobním workflow a projektovém předání. Ověření výsledku, ochrana tajemství a omezení nástrojů zůstávají; toto oprávnění se nepřenáší na nesouvisející projekty ani nové placené prostředky.

**Původní benchmarková sada:** uživatel 18. 11. 2026 přímo v koordinačním chatu potvrdil všech 20 již zadaných běhů HomeAI/DS na stávajícím Vastu podle původního zmrazeného manifestu, včetně jeho omezených opravných pokusů. Nežádej další souhlas pro jednotlivé běhy této sady. Oprávnění platí do jejího dokončení nebo změny či odvolání uživatelem; nezahrnuje nové placené prostředky, neomezené opakování ani rozšíření sady. Původní časové limity a omezení nástrojů zůstávají; případné konkrétní nové odmítnutí řeš podle jeho skutečného důvodu. Přesný výrok a zdroj uchovává osobní workflow a projektové předání.

**Trvalé staging nasazování:** uživatel 18. 11. 2026 přímo schválil běžná nasazení oprav HomeAI / StrataDashSeek na stávající Vast až do odvolání, včetně krátkého zastavení předem ověřeného klidového runtime, změny source pinu, startu nové verze a obnovy guardu. Pro jednotlivá taková nasazení nežádej znovu o souhlas. Jde jen o tento projekt a stávající prostředí; souhlas nezahrnuje mazání uživatelských dat ani nové placené prostředky. Nasazuje jediný operátor; relevantní CI, připnutí zdrojů, funkční ověření, obnova původního guardu a omezení nástrojů zůstávají. Přesnou otázku, přímou odpověď „ano“, datum a zdroj uchovává osobní workflow a projektové předání.

**Pokračování již zadaných úloh:** uživatel 18. 11. 2026 přímo schválil obnovu existujícího Doomu i běžná pokračování již zadaných úloh HomeAI / StrataDashSeek na stávajícím Vastu až do odvolání, včetně potřebné modelové práce. Pro takové pokračování nežádej znovu o souhlas. Zachovej původní zadání, soubory, historii, počítadla a limity; nevytvářej tím nové zadání ani nové placené prostředky. Tento souhlas nerozšiřuje benchmarkovou sadu a nemění její zmrazené podmínky. Ověření výsledku a omezení nástrojů zůstávají. Přesná otázka, odpověď a zdroj jsou v osobním workflow a projektovém předání.

## Načti jen potřebné podklady

Cesty níže jsou relativní ke koordinačnímu pracovnímu prostoru HomeAI. Hledej jej nejprve v kontextu zadání; známé místní umístění je `C:/Users/jkremer/Documents/ChatGPT/SaturdayNight`. Rozliš tento prostor od implementátorových checkoutů. Pokud chybí podklad nezbytný pro provozní zásah, pojmenuj jej; dostupná nezávislá lokální práce může pokračovat.

| Potřeba | Podklad |
| --- | --- |
| Navázání na společnou práci, prostředí a platná rozhodnutí | `work/homeai-control/CURRENT_STATE.md` a poslední relevantní handoff |
| Vlastnictví souborů, úkolů a existujících chatů | `work/homeai-control/TASK_MATRIX.md`, `TEAM.json`, případně `CONTRACTS.md` v témže adresáři |
| Podrobný pracovní postup | `work/homeai-workflow/HomeAI-pracovni-postup.md`; vyber relevantní sekce podle činnosti |
| Produktové QA a benchmarky | `work/homeai-control/benchmarks/PRODUCT_QA.md`, `BENCHMARK_REPORT.md` a zmrazená karta/manifest, na které odkazují |

Místní workflow je autoritativní; [Page](https://chatgpt.com/space/page_deb3a569b7908191af15cb4d66b4dbb0) je jeho čitelná kopie. Nepřepisuj do skillu aktuální SHA, kapacity, modely, vlastníky, výsledky ani dočasné staging výjimky. Při přesunu projektu ověř nové umístění místo domýšlení chybějících údajů.

Pro malou lokální opravu nevyžaduj celý provozní audit. Historii otevři kvůli konkrétní nejasnosti. Přenositelný postup pro práci v checkoutu je v `docs/homeai-delivery.md`; osobní workflow a živá evidence mohou být v odděleném koordinačním prostoru.

## Doruč použitelný celek

Urči uživatelský výsledek a skutečné závislosti: session → správný model → nástroje → preview → přijetí, pokud je tato cesta součástí úkolu. Infrastrukturní práci spoj s konkrétním chybějícím krokem. Zachovej všechny požadavky zadání.

Rozděl nezávislé části podle vlastníků. Připrav QA, přístup do prohlížeče, přijímací scénáře a cestu k důkazům souběžně s implementací. Koordinátor vlastní společný stav; další autoři dodávají vlastní handoffy. Nasazuje jediný operátor.

U změny SDK integrace ověř nejmenší skutečnou cestu co nejdříve, před dlouhou přípravou release. Použij připnuté SDK, deklarované služby, skutečné datové typy a procesní kontext; mock je musí respektovat. Následně ověř dotčené chování a požadované CI přesné verze. Platné výsledky bez změny či konkrétní pochybnosti neopakuj. U UI kontroluj správnost výsledku i draft během ukládání; u služeb jejich UID a dostupnost cest.

Po milníku pokračuj zbývajícím autorizovaným rozsahem. Pokud další krok blokuje prostředí, pokračuj nezávislou částí. Opakování nákladného buildu či stejné chyby vyžaduje novou hypotézu nebo změněné podmínky; nejprve využij malou reprodukci.

## Odstraň čekání před prvním použitelným během

U každého blockeru nejbližšího milníku uveď pozorovaný dopad, vlastníka, další výstup a podmínku uzavření. Nález bez vazby na tento milník patří do zbývajícího backlogu; povinné přijetí tím neruš. Jediný live operátor neznamená jediného autora oprav, revizí a sběru výsledků. Připravenému QA předej konkrétní slot nebo událost, která jej uvolní, a další krok; obecné „čeká na koordinátora“ nestačí.

Po opravě známých překážek ověř dotčené chování a skutečné propojení, potom proveď první autorizovaný pilot. Nový obalový skript nebo další kontrolu přidávej kvůli konkrétnímu chybějícímu chování; dokončený smoke bez změny neopakuj. Při úpravě ukončování běhů použij část „Řízení prvního běhu“ workflow nebo `docs/homeai-delivery.md`: uzavřené preview nemusí znamenat ukončený proces a timeout pozorovatele nemusí zastavit operaci.

## Udržuj navazující práci

V týmovém režimu má každý implementátor jeden aktivní a jeden připravený nezávislý úkol ze schváleného backlogu. V existující matici uveď vlastníka, soubory, nejbližší výstup, přijetí a konkrétní blokující událost. Po předání změny nebo při čekání na CI či live slot autor pokračuje připraveným úkolem; druhou závislou změnu nerozpracovává. Koordinátor ověří skutečné převzetí, protože odeslaná zpráva není běžící práce.

Koordinátor deleguje vymezenou diagnostiku a implementaci, drží integraci a je jediným operátorem změn sdíleného runtime. Rozpracované soubory předává s výslovným převodem vlastnictví. QA dostane přesnou verzi artefaktu či session, způsob spuštění a očekávaný výsledek; lokální ověření oddělí od živého přijetí. Předání obsahuje stručný výsledek, SHA, relevantní kontroly a další krok. Nezávislé hotové bloky nečekají na celý backlog.

Udržuj krátký současný stav; staré zápisy zachovej v označené historii. Aktuální dostupnost a čekání eviduj v existujících registrech, nezakládej další reporting. Podrobnosti jsou v části „Plynulé předávání práce“ workflow nebo v `docs/homeai-delivery.md`. Souběžná práce nesmí měnit zátěž měřeného prostředí ani zmrazené podmínky benchmarku.

## Použij podrobnosti podle činnosti

- **Nasazení:** použij aktuální staging rozhodnutí a postup návratu. V existujícím předání uveď konkrétní lidskou autorizaci, povolený účinek a cíl pro push, nasazení či přenos souborů. Již povolenou akci neschvaluj znovu jen kvůli postupu. Pomocné kroky připrav před maintenance oknem. Zachovej fungující nástroje, ověř podávanou verzi a skutečnou uživatelskou cestu; dočasné provozní nastavení obnov i po selhání.
- **GitHub SSH:** existující GitHub klíč a ověřený SSH profil jsou dohledatelné v historii koordinačního chatu a v sekci „SSH přístup pro GitHub“ osobního workflow. Nejprve využij známou referenci a ověř přístup čtením vzdálené větve; bez potřeby nezakládej nové přihlášení HTTPS. GitHub a Vast mají odlišné identity. Přenášej pouze reference, nikdy obsah soukromého klíče; zachovej kontrolu host key a neinteraktivní režim.
- **Runtime a kapacita:** použij „Kapacita a opakovatelné buildy“. Odliš hostitelský disk od guestu, fyzickou alokaci od logické velikosti a RAM od virtuálních či procesních limitů. Instalovaná služba sama neprokazuje použitelnou funkci.
- **QA a benchmarky:** použij „Předání prostředí produktovému QA“, „Testování úměrné změně“ a „Experimenty se Strata a Qwen“. Platný manifest určuje scénáře, limity a rozsah opakování. Zaznamenej session ID/URL před inferencí nebo z jediného submitu podle SDK, skutečný backend/model a runtime SHA. Nejasný submit dohledávej bez duplikování zadání. Offline příprava se nepočítá jako živý benchmark.
- **Odmítnutí nástroje či systémové blokování:** zastav dotčenou operaci a uveď přesný důvod. Pokud kontrola konkrétně odmítne přenesený souhlas, odkaž uživatele na připravenou otázku v chatu vykonavatele; neopakuj předávání ani náhradního operátora. Není to univerzální požadavek dalšího schvalování. Nezávislá povolená práce pokračuje.

## Uzavři výsledek důkazem

Vykazuj zvlášť **nasazeno**, **funkčně přijato** a **změřeno benchmarkem**, s verzí, prostředím, časem pozorování a odkazem na důkaz. Neprovedené, blokované a uživatelem odložené části zůstávají rozlišené.

Koordinátor při uzavření milníku sjednotí dotčené současné snapshoty: souhrn, řádek úkolu, registry a benchmarkový report. Historické důkazy zachová. Rozliš připravené session, skutečně odeslaná zadání a dokončené běhy; rozpor v textu sám znovu neotevírá již ověřenou závadu. Uveď poslední skutečný uživatelský výsledek a jeho čas; odděl aktivní práci, přípravy a čekání. Čas do prvního pilotu není rychlost modelu a nečinný chat není běžící práce. Používej existující evidenci. Předání zakonči dalším krokem a vlastníkem; procento a odhad času opři o zbývající přijetí.
