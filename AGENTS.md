# AGENTS.md

**Where the current state of this repository violates the rules below, leave it alone.** Do not tidy it, reformat it, translate it or migrate it on your own initiative, and do not treat an existing violation you happen to pass as part of the task. Cleanup of pre-existing material happens only when the user asks for it, and that request is the only trigger.

Rules for AI coding agents working in this repository. Follow them exactly. When a rule and your own judgement disagree, the rule wins. The rules govern the code and the prose you write or change; material you are not touching stays as it is until the user asks for it to be brought into line.

## 1. Git: commits and pushes always need the user's approval

- **Never create a commit without asking first.** Ask for approval every time, even if you have committed in this same session before.
- **Commit messages must be reviewed by the user before the commit exists.** Draft the message, show it, and wait for approval. There is no exception to this, not even when the commit itself is already approved.
- **A request to stage is a request to stage and nothing more.** When the user asks to stage, run `git add` and stop there. Staging is not permission to commit, and finishing the thought with a commit is the mistake this rule exists to prevent.
- **Never push without asking first.** Ask every time. Approval to commit is not approval to push.
- The only relief is an explicit statement from the user, during the current session, that further pushes need no further asking. That waiver covers pushes only, is session scoped, and does not carry into later sessions. It never covers commits or commit message review.
- **A local modification you did not make is the maintainer's own edit.** Assume that first rather than treating it as stray state to revert or as a defect to fix. Leave it in place, account for it when reading a diff, commit only what you changed, and ask the maintainer when its purpose is unclear.
- **Never rewrite history that is already on `origin`.** A local commit may be amended or rebased before it is pushed. Once it is pushed, leave it alone: do not force push, do not amend, do not rebase.
- **Do not commit secrets, tokens or personal absolute paths.** Credentials live in `~/.dsh/.credentials.yaml` and are read through a reference name such as `BILIBILI_SESSDATA`. The value behind a reference never appears in a file this repository tracks, and neither does a path like `/home/<user>/...`.
- Commits are signed (`commit.gpgsign` is on, `gpg.format = ssh`). A commit should verify as `G`; check with `git log --show-signature -1`.
- **A release tag points at its release commit and nothing else.** The repository has no release pipeline yet. When one is added, `CONTEXT.md` owns the mechanism and this rule starts applying to it.

## 2. Commit messages: Conventional Commits

Follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```plaintext
<type>: <description>

[optional body]

[optional footer(s)]
```

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `style`, `revert`. Any other type needs a reason in review.
- **This repository does not use a scope.** Write `feat: manage several live rooms from one ball`, not `feat(client): ...`. Introducing a scope is a maintainer decision, not an agent's.
- **Description** is lowercase, imperative and carries no trailing period. Describe the change, not the file. Write "keep the ball inside the viewport safe area" rather than "update ball.tsx".
- **Body** explains why the change was made. It is mandatory for a bug fix or for a change to a persisted format, because a one line subject cannot justify either of them.
- **Do not wrap the message by hand.** The subject and each body paragraph are one complete line, with no limit on how many characters that line holds. Where a body benefits from separate points, use a Markdown list with one point per line rather than hard-wrapped prose; section 7 states the rule and the reason it exists.
- **Footers:** use `BREAKING CHANGE: <description>` or a `!` after the type for any change to the published surface. That surface covers the `dsh.bundle` patch, the exported subpaths in `package.json`, the `cordis.patch.yml` entry id and its configuration schema, the routes mounted under `/bili-danmaku-overlay`, and the shape of the state the page keeps in localStorage. Reference issues as `Closes #123`.
- **The initial commit is the one exception to the type list.** It reads `feat: init source code` by the maintainer's decision, and it is not to be reworded.
- **One logical change per commit.** Do not mix an unrelated refactor, a formatting sweep or a dependency bump into a behavioural fix.

Examples that fit this repository:

```plaintext
fix: keep the ball menu inside the viewport safe area
feat: fold a closed window into the ball without stopping its stream
refactor: move the room state helpers out of the ball module
docs: describe what a temporary room title survives
```

The message is still reviewed by the user before the commit exists, as rule 1 requires. This section only defines what that message must look like.

## 3. Docstrings and comments

### Docstrings

Every module, public class and public function carries a docstring in the standard documentation format of the language it is written in.

- **TypeScript** (`host.ts`, `src/**/*.ts`, `src/**/*.tsx`): JSDoc. Put a `/** ... */` block on every exported symbol. The type signature carries the types; use `@param`, `@returns` and `@throws` only for the part of the contract the signature cannot express, such as units, ordering and failure conditions. A docstring in this repository is usually one summary line plus a short paragraph of reason, and that is the right shape while the signature says the rest.

A docstring states a contract. It does not restate the signature. Say what the code does, what it owns, what it may throw and which invariant the caller must uphold. Units, ordering guarantees and lifetime rules belong here. Where a React component encodes a layout decision that is not obvious from its style object, the reason belongs in the docstring or next to the value it constrains.

### Comments

Keep comments to a minimum. Prefer a clearer name or a smaller function over a comment that explains the code.

- **Do not** write a comment that restates the code, narrates the diff, keeps a changelog or leaves commented out code behind.
- **Do not** scatter one off notes through a function, and do not use decorative banners, separator runs or emoji markers to organise code.
- **Do** keep a comment when it records something the code cannot express, such as a non obvious invariant, a workaround for a bug in a dependency or in the runtime, a security relevant reason or an ordering constraint that is easy to break. Place that comment immediately next to the code it constrains and give the reason rather than the history.
- Knowledge that must outlive the function belongs in `CONTEXT.md` or `README.md`, not in an inline comment.

Existing comments that violate this rule are not a licence to imitate them, and they are not yours to clean up either. Leave them where they are unless the user asks for a cleanup pass. See the note at the top of this file.

## 4. Documentation layers

Each document has one job. When a sentence does not fit the document it is in, move the sentence to the document that owns it instead of stretching the boundary.

| Document | Audience | Holds |
| --- | --- | --- |
| `AGENTS.md` | AI coding agents, maintainers | coding conventions and development rules, and nothing else |
| `CONTEXT.md` | agents, maintainers | technical detail: architecture axioms, invariants, command recipes, pitfalls, protocol notes |
| `README.md`, `README.zh.md` | ordinary users of this plugin | short, readable, task oriented material about what it does and how to use it |

### `AGENTS.md`

Rules and conventions only. An invariant or a technical fact that lands here has landed in the wrong file. Move it to `CONTEXT.md`, then reference the section by name if the rule depends on it.

### `CONTEXT.md`

**All technical detail converges here.** A fact precise enough to need care, such as a detection order, an ordering constraint, a timeout, a wire format or a workaround for a dependency bug, belongs in `CONTEXT.md` rather than in `AGENTS.md` or `README.md`. Keep it current, because a behavioural change that leaves `CONTEXT.md` stale is an incomplete change. Its module map is part of that contract: a new, renamed or removed module updates the map in the same change.

### `README.md` and `README.zh.md`

Written for a user who wants to install the plugin and get it working, not for someone reading the source. Prefer shortening over explaining.

- Lead with what the project is and what the user gets from it, then how to install and use it.
- Keep the path to a first success short and copy pastable.
- Cut implementation detail, which means no internal file walkthroughs, no protocol frames, no design rationale and no exhaustive configuration tables. Move that material to `CONTEXT.md`.
- A technical statement that survives here must still be true. Simplification is not permission to be inaccurate.
- The two files mirror each other: same headings, same claims. A change to one without the other is an incomplete change.

### `docs/`

This repository has no `docs/` directory. Do not create it speculatively. Normative material about the plugin contract stays in `CONTEXT.md`.

### Cross-cutting

- One fact, one home. Link to it instead of repeating it, because duplicated prose drifts out of sync. **`CONTEXT.md` is the exception.** It exists so that an agent can load the working model of the system from one file, so it repeats a fact that also lives in `AGENTS.md` or in `README.md` whenever the second copy saves the reader another file, and it keeps detail those documents leave out. That repetition is deliberate, so a change updates the `CONTEXT.md` copy even when the authoritative statement lives elsewhere.
- A change to behaviour, to the published contract or to an invariant must update the owning document in the same change, including `CONTEXT.md` whenever it describes the affected area.

## 5. Technical changes: document the new state, delete the old one

A change is not a story about a change. Once it lands, the repository describes only how the system works now.

- **Write the new behaviour in the present tense, as the only behaviour.** Do not write "used to be", "previously", "now we instead" or "changed in v0.2". Do not compare before and after, and do not add version history tables to reference material.
- **Delete what the change made obsolete** in the same commit. That covers dead functions and branches, the superseded code path, retired configuration keys and their defaults, stale examples and documentation sections that are no longer true.
- **Rename in place rather than aliasing.** Substitute the new name everywhere. Do not leave the old name pointing at the new one "for clarity".
- Leaving obsolete material behind with a note, a `// removed` marker or a deprecation comment is not acceptable. It is the same debt in smaller pieces.
- If removing the old behaviour leaves a documentation section empty, remove the section rather than filling it with an explanation of what disappeared.
- **No tombstones.** Nothing in a comment or a doc says what the text used to claim or why it was removed. Rationale is not history: keep the forward-looking reason that still describes the code in front of you, and cut the backward-looking kind. A reader who never saw the old version does not need its obituary, and a reader who did is better served by `git log`.
- **In the commit message,** state the turning point in the fewest possible words. Do not write a migration narrative or a recap of the diff. Section 2 asks for the reason for the change, which is not a licence to explain the behaviour that was replaced.

### Compatibility transitions

- **Do not build one unless it is genuinely required.** Old behaviour is removed, not supported in parallel. A shim, a legacy fallback or a dual code path is a deliberate exception and never a courtesy.
- A transition is genuinely required when an artifact already exists outside this repository. In this plugin that means state a browser already holds: today's localStorage keys, which a page keeps across a refresh and which a newer build must still read, and the single-room form those keys had before the multi-room model existed.
- Do only the minimum necessary: read the old input, convert it, and document the conversion where the operator would look for it. Every transition is bounded, so state the removal condition and record the transition in `CONTEXT.md`.
- Everything in a transition is temporary and must read as temporary. Never let the old shape return to the general documentation as though it were a supported form.

## 6. Build and verification

```sh
npm run build
npm run typecheck
```

- `npm run build` runs `node build.mjs` and writes `index.js` (Host half, ESM) and `client.js` (Client half, IIFE). `npm run typecheck` runs `tsc --noEmit` and must print nothing.
- **The build output is committed for now, as a development stage accommodation and not as the final shape of this repository.** Its only purpose is that installing straight from the GitHub source works before a release exists, since the Harness loads `index.js` and `client.js` from the package directory and a clone without them would fail. The target state is a source-only repository where `index.js` and `client.js` are generated by the build and ignored by Git, exactly like the sibling plugin repositories, and that switch happens when the plugin is released rather than when an agent finds the current arrangement untidy.
- While the output is still committed: rebuild before committing anything that touches `src/` or `host.ts`, and commit the rebuilt `index.js` and `client.js` in the same commit as the source that produced them. A commit that changes the source without a matching rebuild is incomplete, and a hand-edited `index.js` or `client.js` is never acceptable because their banner says they are generated.
- **Do not flip the repository to source-only on your own initiative.** That includes adding `index.js` and `client.js` to `.gitignore`, removing them from `package.json` → `files`, deleting them from Git, or introducing a `prepare` script or a release workflow to replace them. All of it belongs to the release work, and the release work is the maintainer's call.
- There is no test suite and no formatter. Do not describe a build or a type check as a passing test.
- **Verify before a handoff** by running both commands and confirming that `git status` shows no unexpected change afterwards. A result reported to the user as passing must come from these commands, not from a narrower ad hoc check.
- Build only. **Do not install this bundle into a live profile, restart that profile, or reload the page as an incidental development check.** See section 8.
- The installed plugin is a symlink from the profile to this working copy, so a rebuild reaches the running Host with no copy step. The Client half still needs the page reloaded before it runs.

## 7. Prose style in comments and documentation

Comments and documentation are read by people, so write them as prose a person can read once and understand.

- **Avoid the em-dash (`U+2014`) and do not use dash characters as connectors.** This applies to code comments, JSDoc and every Markdown file in the repository. Use a comma, a colon, a semicolon, a full stop or parentheses, or split the sentence in two.
- Do not use runs of hyphens, equals signs or box drawing characters as decorative separators in comments. Section breaks belong in headings.
- Write complete sentences. Every sentence has a subject and a verb, and it says one thing. If a sentence needs three clauses to stay true, it needs to be three sentences.
- Prefer the plain word. Use "use" rather than "utilise", "because" rather than "due to the fact that", and "must" rather than "it is required that".
- Keep the terminology consistent with the code. If a value is named `view`, the prose says view everywhere, not "state" in one paragraph and "mode" in the next.
- Punctuation carries the emphasis. Reach for a colon, a list or a shorter sentence rather than an intensifier.

This rule applies to every sentence you write, including the ones in this file. It is not a mandate to rewrite prose that already exists. See the note at the top of this file.

### Line wrapping

- **Write a paragraph as one complete text line.** Do not break it at a column, a word count or any other width, and do not treat a long line as a problem to be fixed. No limit applies to the number of characters in a line. This covers every Markdown document in the repository and every commit message, the subject line included.
- **The renderer wraps the line, not the author.** Front ends such as the GitHub web interface set their own width and reflow a paragraph to fit the window, so a complete line arrives there as readable prose. A break written into the source reaches the renderer as a hard break inside the paragraph, which renders wrongly and interrupts reading.
- **Keep the newline that ends a block.** A heading, a table row, a list item, a code block, a block quote and the blank line between two blocks each stay on their own line. Only the newline that a soft wrap would have inserted inside a paragraph goes away.
- **Keep CJK text joined without a space.** A Chinese paragraph is one line, and a translation that joins two fragments has no space where an English sentence would need one.
- **`.markdownlint.json` encodes this choice.** `MD013` (line length) is off, which is what makes a long line compliant instead of a defect, and `MD024` permits the same heading text under different parents. markdownlint is a local convenience and not a gate, because nothing in this repository runs it: run `npx --yes markdownlint-cli2 AGENTS.md CONTEXT.md README.md README.zh.md` by hand when you want the feedback, and do not add it to a script or a workflow without the maintainer asking.

## 8. Working with the DeepSeek Harness runtime

This plugin only takes effect inside a running `dsh` process, because it is a Cordis bundle loaded from a profile. Some of the work therefore belongs to the user rather than to the agent.

### Restarting `dsh` and reloading the page

- **Never restart, kill or otherwise interrupt a running `dsh` service.** Do not use `pkill`, `kill` or a supervisor restart, and do not start a second `dsh` on a different port in order to "verify" a change.
- **Never trigger a browser reload yourself, and never report that a Client change is live before the user has reloaded.** Restarting the service and reloading the page each need the user's explicit confirmation every single time, not once per session.
- Which half needs what: a change under `src/client/` reaches the page only after a reload, while a change under `host.ts`, `src/*.ts` and `src/routes.ts` is Host side. Compare the build time of `index.js` against the process start time of the running `dsh` before claiming the Host already runs the new code, rather than assuming either way.
- When a change needs the service restarted, stop at the handoff. Finish the code, state plainly what changed and why a restart is required, then ask the user to restart and report back.
- Make the handoff precise. Give the exact command or action and the exact thing to look for, such as what the ball should do differently. A vague request to restart and check wastes the handoff.
- Treat the result the user reports as the verification. Do not re-derive it by restarting the service yourself.

### Asking for help when debugging

- **Proactively ask the user to run a step when they can do it better than you.** This is the expected move and not a last resort. The agent works through a limited shell, while the user has a real browser, a phone and the live session that produced the problem.
- Ask for a human hand when the step needs any of the following: reloading or observing `dsh`; how something renders at a specific window size or on a phone; credentials, a logged in account or network access you do not have; a reproduction of user visible state such as what the browser actually showed.
- Make the request cheap to answer. Ask for one action at a time, state it exactly, and state the expected result so that a mismatch is obvious.
- Ask early. Spending a long turn on a brittle workaround for something the user can do in seconds is the wrong trade, so ask when in doubt.

### What the agent must never do to a live room

- **Never send a danmaku to a room that is not the maintainer's own.** Reading a room is harmless and is how the plugin gets tested; writing to a stranger's chat is not. The maintainer's own room is the only target a send may ever reach, and the agent has to be told which room that is rather than guessing.
- **Prefer a test that carries the stored login.** A logged in request is the shape the plugin actually runs in and the one whose answers are worth trusting, so before probing an endpoint, check that the credential is available and use it. Reading a public endpoint anonymously still works and is sometimes the point, so this is a preference about which measurement is representative, not a prohibition: when a step is genuinely better anonymous, say why in the reply rather than dropping the credential quietly.
- **Never poll faster than 0.1 seconds.** The live endpoints already throttle a busy client, and a tighter probe measures rate limiting instead of the code.

## 9. Language: English unless i18n requires otherwise

English is the working language of this repository. Write in English by default, and treat any other language as the exception.

- **Applies to everything:** source comments, JSDoc, commit messages, documentation in `AGENTS.md`, `CONTEXT.md` and `README.md`, error and log messages.
- **The standing exception is i18n, and this package has two of them.** `src/client/copy.ts` holds the `zh` and `en` dictionaries that the overlay renders, and `locale/*.json` holds the plugin listing's title and description. Their content stays in the language its locale requires.
- **`CopyKey` is a compile-time contract.** Every key exists in both dictionaries with identical interpolation placeholders, so a new user facing string is added to both in the same change. Never widen the dictionary type or fall back to a literal in a component.
- **`locale/*.json` holds only `meta`.** Runtime strings must not move there: the locale service takes dictionaries by value and nothing in the client bundle reads a JSON file at runtime, so a string that lived only in JSON would render as a raw key.
- **`README.zh.md` is a full translation, not an exception to the rule.** It mirrors `README.md` and is updated together with it.
- **Third party text is never translated.** Upstream error strings, API field values and host diagnostics are preserved verbatim. A Bilibili room title is shown as the streamer wrote it.
- Identifiers, protocol tokens, package names, file names and proper nouns are not translated.
- **Do not annotate the exception.** When a string is intentionally non English, leave it and move on. No note, no comment, no translation in brackets, no explanation of why it is not English.

Existing non English text is not a defect to be fixed on sight, and it is not yours to translate. Leave it where it is unless the user asks for a cleanup pass. See the note at the top of this file.

## 10. `AGENTS.ignore.md`: record what was already settled

This repository may carry a second instruction file, `AGENTS.ignore.md`, whose job is to stop the same disagreement from happening twice. **Do not create it in advance and do not create it to be tidy.** It exists only when one of these has actually happened:

- the agent makes the same mistake in an area more than once, even after correcting it there;
- the technical direction the agent plans or starts to implement does not match what the user expects;
- some other edge case keeps recurring.

When one of those happens, create `AGENTS.ignore.md`, or append to it if it already exists, and record three things.

- **The wrong route or direction.** State what the agent did or intended to do, and why it was wrong. Write it as a route not to take again, precise enough that a future agent recognises the situation before walking into it.
- **The final decision reached with the user.** State what was settled, and say that it is settled. This is the part that carries authority, so write it as a rule and not as a discussion summary.
- **Upstream information, when there is any.** Record the dependency, library, runtime or protocol detail that explains the decision. This item is optional. If there is no upstream cause, leave it out rather than filling the space.

Style rules from sections 3, 7 and 9 apply to this file as well. It is instructions, not a journal, so keep it short, keep it current, and delete an entry once the situation it guards against can no longer occur.

Read `AGENTS.ignore.md` before changing an area it covers. When it and this file disagree about a settled decision, `AGENTS.ignore.md` wins, because it records the user's actual decision about that specific area.
