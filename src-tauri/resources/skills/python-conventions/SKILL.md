# Python Conventions

You are working in a Python project. PEP 8 naming, type hints (`def f(x: int) -> str`), `pytest` for tests, virtual environments, f-strings, dataclasses — these are assumed knowledge. The rules below cover footguns and decisions where models drift from idiomatic Python.

## Patterns to Avoid

- **Don't use mutable defaults in function signatures.** `def f(items=[])` shares the SAME list across calls. Use `def f(items: list | None = None)` and `if items is None: items = []`.
- **Don't catch bare `except:`** — swallows `KeyboardInterrupt` and `SystemExit`. Use `except Exception:` for broad catches, or specific types (`except ValueError`).
- **Don't compare with `==` to `None`, `True`, `False`.** Use `is None`, `is True`, `is False` — `==` invokes `__eq__` which can be overridden weirdly.
- **Don't use `type(x) == X`.** Use `isinstance(x, X)` — handles inheritance correctly.
- **Don't import inside functions to "speed up startup" unless you've measured.** Imports cost is paid once (cached in `sys.modules`); imports inside functions add per-call overhead and hide dependencies from static analysis.
- **Don't return `None` to signal failure.** Raise an exception or return a typed `Result`/`Either`. `None` returns force callers to check explicitly and forget to.
- **Don't use `Dict`, `List`, `Optional` from `typing` in new code (Python 3.9+).** Use built-ins: `dict[str, int]`, `list[str]`, `T | None`. The `typing` aliases are deprecated in stubs.
- **Don't use `os.path` for path manipulation in new code.** Use `pathlib.Path` — `Path('a') / 'b' / 'c.txt'` over `os.path.join`. Cleaner, type-safe, OS-agnostic.
- **Don't iterate while mutating.** `for x in lst: lst.remove(x)` skips elements. Iterate over a copy (`lst[:]` or `list(lst)`) or build a new list.
- **Don't use `eval()` / `exec()` on untrusted input.** Code injection. Use `ast.literal_eval` for safe literal parsing.
- **Don't conflate `Optional[T]` with "nullable parameter".** `Optional[T]` is `T | None` — must accept `None`. If a parameter is required but defaults can vary, use a sentinel (`_MISSING = object()`) instead.
- **Don't mix sync and async I/O in the same call chain.** Async event loop blocks on sync I/O — defeats the point. Use `aiohttp`/`httpx` async clients in async code.
- **Don't use `print` for logs in production code.** Use the `logging` module — gives you levels, handlers, formatters, and the ability to silence/redirect downstream.

## Convention reminders (often missed)

- **`__init__.py` is needed in every package** for explicit packages (PEP 420 namespace packages exist but are rare). Missing it breaks `from x import y` even with `sys.path` set.
- **`pyproject.toml` is the modern config** — `requirements.txt` is legacy. New projects use `[project]` tables, `uv` or `poetry` for dependencies.
- **`@dataclass(slots=True, frozen=True)`** for value objects — gets you `__init__`, `__eq__`, `__hash__`, immutability, and slots-based memory savings in one decorator.
- **`Protocol` for structural typing** when you want duck typing with type safety — beats `ABC` for "anything with `.read()`" interfaces.
