import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings, X } from "lucide-react";
import { DEFAULT_PREFS, loadPrefs, savePrefs, type Prefs } from "./prefs";
import { LOCALES, currentLocale, setLocale, type Locale } from "@/i18n";

/**
 * Global app preferences. Today: CSV defaults that seed the import /
 * export dialogs. We deliberately keep this dialog tiny — each new
 * section should be a clear concept, not a kitchen sink of toggles.
 */
export default function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  const [locale, setLocaleState] = useState<Locale>(() => currentLocale());

  const apply = () => {
    savePrefs(prefs);
    // Locale change writes through to i18next + localStorage so future
    // boots pick the same language.
    setLocale(locale);
    onClose();
  };
  const restoreDefaults = () => setPrefs(DEFAULT_PREFS);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <Settings size={14} />
          <span>{t("preferences.title")}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="section-title">{t("preferences.csv.section")}</div>

            <label htmlFor="pref-null">NULL token</label>
            <input
              id="pref-null"
              type="text"
              value={prefs.csv.nullToken}
              onChange={(e) => setPrefs({
                ...prefs,
                csv: { ...prefs.csv, nullToken: e.target.value },
              })}
              placeholder={`"NULL", "\\N", or anything that signals "this is null"`}
            />

            <label htmlFor="pref-delim">Delimiter</label>
            <select
              id="pref-delim"
              value={prefs.csv.delimiter}
              onChange={(e) => setPrefs({
                ...prefs,
                csv: { ...prefs.csv, delimiter: e.target.value },
              })}
            >
              <option value=",">Comma</option>
              <option value=";">Semicolon</option>
              <option value={"\t"}>Tab</option>
              <option value="|">Pipe</option>
            </select>

            <label htmlFor="pref-line">Line ending</label>
            <select
              id="pref-line"
              value={prefs.csv.lineEnding}
              onChange={(e) => setPrefs({
                ...prefs,
                csv: { ...prefs.csv, lineEnding: e.target.value as "\n" | "\r\n" },
              })}
            >
              <option value="\n">LF (Unix / macOS)</option>
              <option value="\r\n">CRLF (Windows / Excel)</option>
            </select>

            <div className="section-title">{t("preferences.language.section")}</div>
            <label htmlFor="pref-locale">{t("preferences.language.label")}</label>
            <select
              id="pref-locale"
              value={locale}
              onChange={(e) => setLocaleState(e.target.value as Locale)}
            >
              {LOCALES.map((code) => (
                <option key={code} value={code}>
                  {code === "en" ? "English" : code === "fr" ? "Français" : code}
                </option>
              ))}
            </select>

            <label htmlFor="pref-empty-null">Treat empty cells as NULL</label>
            <div>
              <input
                id="pref-empty-null"
                type="checkbox"
                checked={prefs.csv.emptyIsNull}
                onChange={(e) => setPrefs({
                  ...prefs,
                  csv: { ...prefs.csv, emptyIsNull: e.target.checked },
                })}
              />
              <span className="muted" style={{ marginLeft: 6 }}>
                When off, empty cells stay as empty strings so the empty-vs-null distinction round-trips through CSV.
              </span>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-link" onClick={restoreDefaults}>
            {t("preferences.restoreDefaults")}
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn-pill" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn-pill primary" onClick={apply}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
