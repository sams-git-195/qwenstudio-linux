// Dependabot's automated commit bodies routinely include long changelog/compare URLs that
// would otherwise trip config-conventional's default body-max-line-length; relax that rule
// for everyone rather than special-case URL lines. The commitlint step itself is also skipped
// entirely for github.actor == 'dependabot[bot]' PRs in .github/workflows/ci.yml, since
// Dependabot's commit subjects/bodies aren't authored to satisfy the full conventional-commit
// rule set -- this repo's own Conventional PR title check (amannn/action-semantic-pull-request)
// still applies to those PRs.
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-max-line-length": [0, "always"],
  },
};
