# Inviter — jednoduchý nástroj pro rychlé pozvání

Jednoduché doplňkové rozšíření, které prochází tlačítka "Pozvat" ve Facebook seznamu reakcí. Skript automaticky posouvá seznam, aby načetl všechny osoby, a postupně na tlačítka kliká.

## 🔧 Použití

1. Otevřete příspěvek na Facebooku a klikněte na počet reakcí, aby se otevřel seznam reakcí.
2. Otevřete rozšíření (popup) a stiskněte tlačítko **Start**.
3. Skript nejprve automaticky posouvá seznam v okně s pozvánkami dolů, dokud nenačte všechny dostupné lidi. Poté začne postupně zvat lidi a klikat na tlačítka. Scrollování je omezeno pouze na okno s pozvánkami, nikoli na celou stránku.

## ⚙️ Konfigurace

- Selektor tlačítek najdete v `popup.js`:

```js
// např. změňte pokud máte jiný jazyk Facebooku
document.querySelectorAll('div[aria-label="Pozvat"]');
```

- Pokud Facebook používá jiný jazyk, upravte text v selektoru (např. "Invite", "Pozvat").

## Instalace v Orion Browseru (iOS)

1.  **Stáhněte si ZIP archiv rozšíření.**
    - Stahnout zip soubor z https://github.com/mathew8e/inviter-orion/archive/refs/heads/main.zip.
2.  **Rozbalte stažený ZIP archiv.**
    - Tím získáte složku obsahující soubory rozšíření (např. `manifest.json`, `popup.js` atd.).
3.  **Přidejte rozšíření do Orion Browseru:**
    - Otevřete Orion Browser na svém iOS zařízení.
    - Přejděte do nastavení rozšíření (obvykle přes menu -> "Extensions" nebo "Doplňky").
    - Vyhledejte možnost "Load unpacked extension" nebo "Načíst nerozbalené rozšíření".
    - Vyberte složku, kterou jste rozbalili v kroku 2.

## ❗ Upozornění

- Používejte zodpovědně a respektujte zásady Facebooku (Terms of Service).
- Tento skript může být detekován jako automatizace; používejte na vlastní riziko.

## 🛠️ Kde upravovat

- Hlavní logika je v `popup.js` — změny v selektoru, rychlosti nebo textu hlášení zde proveďte přímo.

## Kontakt

- Chcete-li změny lokalizace, limity nebo další funkce (pauza, stop, limit pozvánek), napište a já je doplním.

---

_Vytvořeno rychle pro osobní použití._
