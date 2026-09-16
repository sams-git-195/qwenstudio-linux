# Summary

<!-- What and why -->

## Checklist

- [ ] PR title follows Conventional Commits (it becomes the squash commit message)
- [ ] Unit tests added or updated (`npm run test:unit`)
- [ ] `npm run typecheck` passes
- [ ] Docs updated (README / docs/ARCHITECTURE.md / CHANGELOG.md `[Unreleased]`) where behaviour changed
- [ ] `npm run build && npm run verify` passes locally, or I rely on CI's build-and-test job
- [ ] If this should ship to users, `wrapper_revision` in `upstream.json` is incremented
