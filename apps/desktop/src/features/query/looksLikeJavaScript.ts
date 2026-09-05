// Extracted from QueryTab so that file exports only its component — a
// component module with extra exports breaks React Fast Refresh
// (react-refresh/only-export-components).

/**
 * Heuristic: does this text look like a JavaScript script rather than SQL?
 * Used to catch a script typed into a SQL-mode tab (which would otherwise be
 * sent to Postgres and fail with a cryptic "syntax error at or near const").
 * Matches tokens that appear in the scripting API / JS syntax but never in
 * plain SQL. Scans the whole text so a leading comment can't hide the opener.
 */
export function looksLikeJavaScript(text: string): boolean {
  return (
    /\bdb\.query\s*\(/.test(text) ||       // the scripting API
    /\bconsole\.(log|warn|error)\s*\(/.test(text) ||
    /\bawait\b/.test(text) ||              // SQL has no await
    /=>/.test(text) ||                     // arrow functions
    /\$\{[^}]*\}/.test(text) ||            // template literals
    /\bfor\s*\(\s*(const|let|var)\b/.test(text) || // JS for-of/for-let
    /^\s*(const|let|var|function|async)\b/m.test(text) // JS declarations, any line
  );
}
