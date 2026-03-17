# General Coding

General best practices for all projects.

## Code Quality
- Write clear, self-documenting code. Names should reveal intent.
- Functions do one thing. If you need "and" to describe it, split it.
- Keep functions short (< 40 lines). Extract helpers when complexity grows.
- Avoid deep nesting (> 3 levels). Use early returns and guard clauses.
- DRY: extract repeated logic, but don't abstract prematurely — wait for the third occurrence.

## File Organization
- One concept per file. Group related files in directories.
- Keep imports organized: stdlib first, then third-party, then local.
- Co-locate tests with source code when the framework supports it.
- Configuration files at project root. Source code in `src/` or language-standard directories.

## Version Control
- Write atomic commits: one logical change per commit.
- Commit message format: imperative mood, < 72 chars ("Add user auth", not "Added user auth").
- Don't commit generated files (node_modules, dist, __pycache__), secrets, or large binaries.
- Use `.gitignore` appropriate for the language/framework.

## Error Handling
- Handle errors at the appropriate level — don't catch and ignore.
- Provide context in error messages: what failed and why.
- Use typed/specific errors over generic ones.
- Log errors with enough context to debug without reproducing.
- Fail fast: validate inputs at boundaries.

## Security
- Never hardcode secrets (API keys, passwords, tokens).
- Use environment variables or secret managers for credentials.
- Validate all user input. Sanitize before rendering.
- Use parameterized queries for databases — never string concatenation.
- Keep dependencies updated. Audit for known vulnerabilities.

## Performance
- Measure before optimizing. Profile to find real bottlenecks.
- Prefer algorithmic improvements over micro-optimizations.
- Use caching for expensive operations that are called frequently.
- Lazy load resources that aren't needed immediately.
- Batch operations (network, database) to reduce round trips.

## Documentation
- Document "why", not "what" — code shows what, comments explain why.
- Keep README up to date: setup, usage, architecture overview.
- Document public APIs with clear parameter descriptions and examples.
- Remove outdated comments — stale docs are worse than no docs.

## Testing
- Test behavior, not implementation details.
- Follow Arrange-Act-Assert pattern.
- Use descriptive test names that explain the scenario.
- Test edge cases: empty inputs, null, max values, concurrent access.
- Integration tests for critical paths. Unit tests for complex logic.
