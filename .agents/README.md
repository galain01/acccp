# ACCCP engineering skills

Repository-local guidance from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) at commit `aeac41d4d005999432bb7312f7ff06383a91d59d`, installed on 2026-10-26. This adds no global plugin, hook, helper script, or system configuration. Skills can be read directly in this checkout; automatic discovery depends on the host.

Reviewed and loaded for the reliability work:

- [Spec-driven development](skills/spec-driven-development/SKILL.md)
- [Source-driven development](skills/source-driven-development/SKILL.md)
- [Test-driven development](skills/test-driven-development/SKILL.md)
- [Debugging and error recovery](skills/debugging-and-error-recovery/SKILL.md)
- [Code review and quality](skills/code-review-and-quality/SKILL.md)
- [Code simplification](skills/code-simplification/SKILL.md)
- [Security and hardening](skills/security-and-hardening/SKILL.md)

Preserve the sibling `skills/` and `references/` directories: upstream skills use `../../references/`, and the security skill also has its own nested references. All 16 upstream files are unchanged; [provenance.json](provenance.json) records their SHA-256 hashes relative to this directory. The upstream [MIT license](LICENSE) is included. Upstream's root `AGENTS.md` is deliberately excluded because it configures work on the guidance repository itself.

Use written acceptance criteria, version-appropriate primary sources, reproducible failures, regression tests, and independent review. Read supporting references as needed; code snippets are examples, not automatically authorized commands. Existing user authorization and this repository's instructions govern scope. Generic approval gates in the upstream guidance do not require repeated permission for work already authorized, and do not authorize production deployment, paid calls, credentials changes, or private-document uploads.
