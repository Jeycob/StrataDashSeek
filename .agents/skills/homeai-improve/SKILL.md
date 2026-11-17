---
name: homeai-improve
description: "Realizace a koordinace změn HomeAI / StrataDashSeek, produktového QA a párovaných benchmarků. Použij při zlepšování této aplikace od konkrétního problému po ověřený uživatelský výsledek."
---

# Zlepšování HomeAI

Navazuj na rozpracovanou práci a doruč nejbližší použitelný výsledek v rozsahu zadání. Samotný dotaz na stav nebo návrh zůstává čtením či doporučením. Skill nepřidává oprávnění; novější pokyny uživatele mají přednost před jeho postupem.

## Načti jen potřebné podklady

Cesty níže jsou relativní ke koordinačnímu pracovnímu prostoru HomeAI. Hledej jej nejprve v kontextu zadání; známé místní umístění je `C:/Users/jkremer/Documents/ChatGPT/SaturdayNight`. Rozliš tento prostor od implementátorových checkoutů. Pokud chybí podklad nezbytný pro provozní zásah, pojmenuj jej; dostupná nezávislá lokální práce může pokračovat.

| Potřeba | Podklad |
| --- | --- |
| Navázání na společnou práci, prostředí a platná rozhodnutí | `work/homeai-control/CURRENT_STATE.md` a poslední relevantní handoff |
| Vlastnictví souborů, úkolů a existujících chatů | `work/homeai-control/TASK_MATRIX.md`, `TEAM.json`, případně `CONTRACTS.md` v témže adresáři |
| Podrobný pracovní postup | `work/homeai-workflow/HomeAI-pracovni-postup.md`; vyber relevantní sekce podle činnosti |
| Produktové QA a benchmarky | `work/homeai-control/benchmarks/PRODUCT_QA.md`, `BENCHMARK_REPORT.md` a zmrazená karta/manifest, na které odkazují |

Místní workflow je autoritativní; [Page](https://chatgpt.com/space/page_deb3a569b7908191af15cb4d66b4dbb0) je jeho čitelná kopie. Nepřepisuj do skillu aktuální SHA, kapacity, modely, vlastníky, výsledky ani dočasné staging výjimky. Při přesunu projektu ověř nové umístění místo domýšlení chybějících údajů.

Pro malou lokální opravu nevyžaduj celý provozní audit. Historické chaty a dlouhé logy otevři až kvůli konkrétní nejasnosti.

## Doruč použitelný celek

Urči uživatelský výsledek a skutečné závislosti: session → správný model → nástroje → preview → přijetí, pokud je tato cesta součástí úkolu. Infrastrukturní práci spoj s konkrétním chybějícím krokem. Zachovej všechny požadavky zadání.

Rozděl nezávislé části podle vlastníků. Připrav QA, přístup do prohlížeče, přijímací scénáře a cestu k důkazům souběžně s implementací. Koordinátor vlastní společný stav; další autoři dodávají vlastní handoffy. Nasazuje jediný operátor.

Ověř dotčené chování a požadované CI přesné verze. U SDK použij skutečný kontrakt a deklarované služby; mock nesmí poskytovat závislosti, které runtime nemá. U služeb ověř jejich UID a dostupnost cest. U UI kontroluj správnost výsledku i relevantní změny kontextu, například draft během ukládání.

Po milníku pokračuj zbývajícím autorizovaným rozsahem. Pokud další krok blokuje prostředí, pokračuj nezávislou částí. Opakování nákladného buildu či stejné chyby vyžaduje novou hypotézu nebo změněné podmínky; nejprve využij malou reprodukci.

## Použij podrobnosti podle činnosti

- **Nasazení:** přečti sekce „Staging a průběžné nasazování“ a „Nasazení a návrat“. Z platných rozhodnutí zjisti režim a oprávnění; nezaváděj nový souhlas pro již povolený release. Zachovej fungující nástroje při nedostupné nové závislosti. Ověř skutečně podávanou verzi, uživatelskou cestu a obnovení dočasně změněného provozního nastavení i po selhání.
- **Runtime a kapacita:** použij „Kapacita a opakovatelné buildy“. Odliš hostitelský disk od guestu, fyzickou alokaci od logické velikosti a RAM od virtuálních či procesních limitů. Instalovaná služba sama neprokazuje použitelnou funkci.
- **QA a benchmarky:** použij „Předání prostředí produktovému QA“, „Testování úměrné změně“ a „Experimenty se Strata a Qwen“. Platný manifest určuje scénáře, limity a rozsah opakování. Zaznamenej session ID/URL před inferencí nebo z jediného submitu podle SDK, skutečný backend/model a runtime SHA. Nejasný submit dohledávej bez duplikování zadání. Offline příprava se nepočítá jako živý benchmark.
- **Odmítnutí nástroje či systémové blokování:** použij odpovídající sekci workflow. Zastav dotčenou operaci, popiš konkrétní důvod a pokračuj pouze nezávislou povolenou prací; nepřeváděj odmítnutou akci na jiného vykonavatele.

## Uzavři výsledek důkazem

Vykazuj zvlášť **nasazeno**, **funkčně přijato** a **změřeno benchmarkem**, s verzí, prostředím, časem pozorování a odkazem na důkaz. Neprovedené, blokované a uživatelem odložené části zůstávají rozlišené.

Koordinátor nahradí zastaralý aktuální snapshot; historie zůstává v existující evidenci. Nezakládej další deník ani kopie reportů. Předání končí konkrétním dalším krokem a vlastníkem; procento a odhad času opři o zbývající přijetí, nikoli počet commitů.
