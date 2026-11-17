# Doručování změn HomeAI

Postup vychází z integračních zkušeností 16.–17. listopadu 2026. Cílem je rychleji doručovat ověřené uživatelské výsledky a omezit přípravy, které jejich dostupnost neposouvají.

1. **Vyber nejbližší použitelný výsledek.** Popiš cestu od viditelné konverzace přes skutečný model a nástroje k dostupnému preview. Každá infrastrukturní práce musí určit, kterou její část odblokuje. Guest runtime rozvíjej souběžně; podporovaný HOST pilot na něj nečeká, pokud jej jeho zadání nevyžaduje. Docker scénář ovšem potřebuje skutečný Docker. Přijetí ani izolaci kvůli alternativní cestě neoslabuj.

2. **Ověř kontrakt brzy na skutečném SDK.** Před rozšiřováním řešení proveď malý scénář přes připnuté SDK a skutečnou browserovou cestu. Chybějící deklarace `sessionQuery` v `inject` zastavila první UI submit. Volání `archivedSessionIds.has()` zase předpokládalo `Set`, zatímco SDK vracelo pole. Mock musí respektovat dostupné služby, datové typy a procesní kontext. Zelený mock ani HTTP 200 samotné nedokazují fungující preview.

3. **Připrav QA souběžně s implementací.** Scénáře, nástroje, potřebná oprávnění a cestu k důkazům připrav před rezervací runtime slotu. Před inferencí zachyť identitu session; vzniká-li až při submitu, převezmi ji z jediného odeslání. Při nejistém výsledku dohledávej původní požadavek. První funkční okno využij pro páry B03 a B10 podle zmrazených zadání, pořadí a limitů. Příprava ani smoke se nepočítají jako dokončený benchmark.

4. **Používej existující důkazy přesné verze.** Relevantní zelené výsledky využij znovu, pokud odpovídají kandidátovi a prostředí; neopakuj je bez změny či konkrétní pochybnosti. Povinné CI zachovej. Buildy, pomocné skripty a ostatní přípravu dokonči mimo maintenance okno. Jediný live operátor provede krátké nasazení, skutečné ověření a obnoví původní provozní nastavení i při selhání.

5. **Udržuj konkrétní autorizační oporu.** V existujícím předání uveď datum, výrok uživatele, povolený účinek a cílový repozitář či prostředí. Nový souhlas „Schvaluju push“ z 17. listopadu 2026 pokrývá vyžádaný push do projektového repozitáře; nenahrazuje oprávnění k jinému exportu, mazání či placenému prostředku. Při odmítnutí pojmenuj přesnou operaci a důvod. Pokud kontrola výslovně odmítne přenesenou autorizaci, odkaž uživatele na připravenou otázku v určeném chatu; neopakuj předávání, přeformulování ani náhradního operátora. Nejde o obecný požadavek opakovat souhlas v každém chatu. Nezávislá povolená práce pokračuje.

6. **Sleduj doručený výsledek a čekání odděleně.** Jeden aktuální snapshot obsahuje poslední uživatelský výsledek, čas jeho pozorování, verzi, skutečný blocker a další krok s vlastníkem. Zaznamenaných 8 h 41 min do první živé kontroly preview je uplynulý čas, nikoli změřená aktivní práce ani důkaz funkčního preview. Aktivní práci, přípravy a čekání vykazuj zvlášť; nové zapsání statusu neobnovuje stáří důkazu.

7. **Po milníku pokračuj.** Odděluj nasazeno, funkčně přijato a změřeno. Hotové použitelné bloky doručuj průběžně a předávej připravenému QA. Konec milníku není konec zakázky. Používej existující stav a benchmarkový report; nezaváděj další deník ani univerzální schvalovací krok. Vyřazené či odložené požadavky neobnovuj bez nového rozhodnutí uživatele a nevykazuj je jako PASS.
