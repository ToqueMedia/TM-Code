# Python Conventions

You are working in a Python project. PEP 8 naming, type hints (`def f(x: int) -> str`), `pytest` for tests, virtual environments, f-strings, dataclasses — these are assumed knowledge. The rules below cover footguns and decisions where models drift from idiomatic Python.

## CRITICAL — Modern Python (3.10+) has different idioms; the model has a strong pre-3.9 prior

Pre-3.9 Python ruled training data for ~15 years. PEP 585 (built-in generics) and PEP 604 (union syntax) landed in 3.9/3.10 and made `Dict[str, int]` → `dict[str, int]` and `Optional[X]` → `X | None` the canonical forms. The training corpus has thousands of `from typing import Dict, List, Optional` imports — the model writes those by default. The same prior drives `os.path.join` over `pathlib`, `setup.py` over `pyproject.toml`, `unittest` over `pytest`, and `requirements.txt` over `pyproject` dependencies.

**Defense — five checks before writing any Python code**:

1. **Type hints use built-ins, NOT `typing` aliases** (Python 3.9+):
   ```python
   # ✅ modern
   def f(items: list[str], counts: dict[str, int]) -> str | None: ...

   # ❌ deprecated since 3.9 — don't write this for new code
   from typing import Dict, List, Optional
   def f(items: List[str], counts: Dict[str, int]) -> Optional[str]: ...
   ```
   Only import from `typing` when you genuinely need a non-built-in: `Callable`, `Protocol`, `TypedDict`, `Any`, `Literal`, `cast`, `TYPE_CHECKING`.

2. **`pathlib.Path` over `os.path`** for all path manipulation:
   ```python
   # ✅ modern
   from pathlib import Path
   config = Path(__file__).parent / 'config' / 'app.yaml'
   if config.exists(): text = config.read_text()

   # ❌ pre-3.9 idiom
   import os
   config = os.path.join(os.path.dirname(__file__), 'config', 'app.yaml')
   if os.path.exists(config):
       with open(config) as f: text = f.read()
   ```

3. **`pyproject.toml` for project config, NEVER `setup.py` + `requirements.txt`** for new projects:
   ```toml
   [project]
   name = "myapp"
   dependencies = ["httpx>=0.27", "pydantic>=2"]
   [project.optional-dependencies]
   dev = ["pytest>=8", "ruff>=0.5"]
   ```
   `setup.py` / `setup.cfg` are legacy. `requirements.txt` is fine for pinning a deployment but should NOT be the source of truth for dependencies.

4. **`pytest` for tests, NOT `unittest`**:
   ```python
   # ✅ pytest
   def test_adds():
       assert add(1, 2) == 3

   # ❌ unittest (still works, but rare in modern Python)
   import unittest
   class TestAdd(unittest.TestCase):
       def test_adds(self):
           self.assertEqual(add(1, 2), 3)
   ```
   pytest fixtures over `setUp`/`tearDown`, `pytest.raises` over `assertRaises`, plain `assert` over `assertEqual`.

5. **Async ecosystem**: `httpx` over `requests` in async code (and increasingly in sync too), `asyncio.gather()` not `asyncio.wait()` for fan-out, `async def` not `@asyncio.coroutine`.

**Anti-pattern symptoms — these mean you defaulted to pre-3.9 idioms**:
- `from typing import Dict, List, Optional` at top of file → swap to built-ins.
- `os.path.join(...)` → use `Path(...) / ...`.
- `setup.py` written for a new project → use `pyproject.toml`.
- `class TestX(unittest.TestCase)` for new tests → use plain functions + `assert`.
- `requests.get(url)` in async code → use `httpx.AsyncClient`.

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
