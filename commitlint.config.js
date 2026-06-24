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
  },
}
