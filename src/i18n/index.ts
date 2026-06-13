/**
 * App internationalization.
 *
 * - English is the source-of-truth baseline; everything else is a
 *   per-locale resource file under `./locales/`.
 * - Detection order: explicit Preferences override → `navigator.language`
 *   / `navigator.languages` → English fallback.
 * - We deliberately avoid the heavier i18next-browser-languagedetector
 *   plugin; the detection logic here is a dozen lines and is enough.
 *
 * Add a new locale by:
 *   1. Drop `./locales/<code>.json` mirroring the English shape.
 *   2. Register it in `LOCALES` below.
 *   3. Add it to the Preferences dialog's locale picker.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import fr from "./locales/fr.json";

/** Codes that we ship today. Add to extend. */
export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

const PREF_KEY = "nembrix.locale.v1";

/** Pick the most plausible locale at boot. */
function detectLocale(): Locale {
  // 1) explicit override
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v && (LOCALES as readonly string[]).includes(v)) return v as Locale;
  } catch { /* localStorage may throw in some sandboxes */ }
  // 2) OS / browser preference. navigator.languages lists fallbacks
  // in user-preferred order; match on the base tag (en-GB → en).
  const candidates = typeof navigator !== "undefined"
    ? [...(navigator.languages ?? []), navigator.language ?? "en"]
    : ["en"];
  for (const tag of candidates) {
    const base = tag.toLowerCase().split("-")[0];
    if ((LOCALES as readonly string[]).includes(base)) return base as Locale;
  }
  // 3) Fallback.
  return "en";
}

export function setLocale(loc: Locale): void {
  try { localStorage.setItem(PREF_KEY, loc); } catch { /* ignore */ }
  void i18n.changeLanguage(loc);
}

export function currentLocale(): Locale {
  return (i18n.language as Locale) ?? "en";
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
    },
    lng: detectLocale(),
    fallbackLng: "en",
    interpolation: { escapeValue: false }, // React already escapes
    // We don't use namespaces today — everything lives under "translation".
    // If the strings table grows big enough that's a clean split point.
  });

export default i18n;
