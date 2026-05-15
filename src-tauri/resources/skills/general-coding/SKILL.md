# General Coding

Universal rules across languages. The basics (clear names, small functions, no hardcoded secrets, parameterized queries, .gitignore generated files) are training-data canon — assumed. Below are the non-obvious rules where models routinely drift.

## Counter-prior rules

- **Wait for the third occurrence before extracting an abstraction.** Two similar pieces of code is coincidence; three is a pattern. Premature abstraction (after the first or second) couples unrelated callers and ossifies a shape that doesn't fit the third use case. Three lines duplicated > one wrong abstraction.
- **Trust framework guarantees and internal code; only validate at boundaries.** Adding `if (!user) throw` inside a function whose only caller already null-checks is dead code that obscures real intent. Validate user input, validate external API responses — leave internal contracts alone.
- **Don't add error handling for scenarios that can't happen.** Fallback for "what if React is undefined" is paranoia, not robustness. Reserve `try/catch` and null-checks for paths where the failure is real and recoverable.
- **Don't add backwards-compatibility shims when you can change the code.** Renaming `getUser` to `fetchUser`? Update the callers. Don't keep a `getUser = fetchUser` alias forever — that doubles the API surface and forces every reader to understand both names.
- **Don't write multi-paragraph docstrings or comment blocks.** One short line max. If the code needs a paragraph to explain WHY, the WHY is the comment — not how it works (the code shows that).
- **Don't reference the current task in comments.** "// Used by /signup flow" or "// added for issue #123" rots as the codebase evolves. The PR description has that context; the comment in code shouldn't.

## Error messages — context is the value

A good error message names: (1) what was being attempted, (2) what input/state was involved, (3) what the system observed. `"Failed to parse JSON at position 47"` is debuggable. `"Invalid input"` is not. The cost is one `fmt.Errorf` / `f"..."` call; the value is hours of debugging not done.

## Commit hygiene

- One logical change per commit. If you need `and` in the message, split.
- Imperative mood, < 72 chars: `"Add user auth"`, NOT `"Added user auth"` or `"This commit adds user auth"`.
- Don't commit generated files, secrets, or large binaries — `.gitignore` aggressively.

## Testing — what's worth testing

- **Test behavior, not implementation.** A test that asserts `service.userRepo.findById was called with 5` breaks every time the implementation refactors. A test that asserts `getUser(5)` returns the right user shape survives refactors.
- **Test edge cases the model would skip**: empty inputs, null, max values, very long strings, unicode, concurrent access, off-by-one boundaries.
- **Skip tests for trivial code.** A getter that returns `this.x` doesn't need a unit test. The test maintenance cost exceeds the bug-finding value.
