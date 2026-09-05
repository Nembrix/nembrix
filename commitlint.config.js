// Commit message validation — Conventional Commits.
// Runs locally via the husky commit-msg hook and in CI (see
// .github/workflows/commitlint.yml). Format:
//
//   <type>(<optional scope>): <subject>
//
// e.g. "feat(desktop): add connection pooling"  or  "chore: bump deps".
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allowed types. Conventional defaults plus nothing exotic — keep
    // the set small so changelogs stay readable.
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'chore',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'revert',
      ],
    ],
    // Scope is optional, but when present keep it lowercase. Common
    // scopes map to the workspaces: desktop, docs, release, deps.
    'scope-case': [2, 'always', 'lower-case'],
    // Subject style: no trailing period, not empty, reasonable length.
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
    // Body lines: keep the 100-char guidance for prose, but don't fail on
    // lines that CAN'T be wrapped. Dependabot bodies always carry compare
    // URLs 140-400 chars long, so config-conventional's error-level
    // body-max-line-length rejected every single dependency PR — a check that
    // no author, human or bot, could satisfy by editing anything.
    //
    // Downgraded to a warning rather than removed: it still nudges humans to
    // wrap prose, and it's the PR *title* that becomes the commit subject on
    // main (the repo squash-merges, and the title job validates it
    // separately), so an unwrapped bot body never lands in history anyway.
    'body-max-line-length': [1, 'always', 100],
  },
}
