# AGENTS.ignore.md

## Commit scopes

**The wrong route.** Reading a convention out of the sibling plugin repositories and out of Conventional Commits examples, then writing it into `AGENTS.md` as though the maintainer had chosen it. A rule stating that this repository does not use a scope arrived that way, and the rule was wrong.

**What is settled.** A scope is allowed. Write `fix(build): ...` when naming the area reads better than leaving it out, and write `fix: ...` when it does not. Conventional Commits defines the scope as optional, so neither form is a deviation. Do not add a rule that restricts scopes, and do not treat an earlier message without one as a precedent.

**Upstream.** Conventional Commits v1.0.0 places the scope in parentheses after the type and marks it optional. The specification constrains it in no other way, so scopes missing from a repository's history are history and not a convention.

## Inventing conventions from other repositories

**The wrong route.** Inferring this repository's rules from what sibling repositories happen to do, rather than from its own `AGENTS.md` and from the maintainer. A sibling that generates its build output needs a `prepare` script; this repository commits its output and must not carry one. A sibling's history may never use a scope; that says nothing about this repository.

**What is settled.** Sibling repositories are evidence about the ecosystem, not about this one. When their arrangement differs, the difference is usually deliberate, and the reason belongs in `CONTEXT.md`. Ask the maintainer before adopting or forbidding a practice on the strength of a sibling alone.
