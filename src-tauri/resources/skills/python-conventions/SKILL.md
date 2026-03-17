# Python Conventions

You are working in a Python project. Follow these conventions:

## Project Structure
- Use `src/` layout or flat layout depending on project convention.
- `__init__.py` in every package directory.
- `main.py` or `__main__.py` as entry point.
- `requirements.txt` or `pyproject.toml` for dependencies.
- Virtual environment: `venv/` or `.venv/` (never commit it).

## Naming (PEP 8)
- Functions and variables: `snake_case`.
- Classes: `PascalCase`.
- Constants: `UPPER_SNAKE_CASE`.
- Private: prefix with `_` (convention), `__` for name mangling.
- Module names: short, lowercase, no underscores if possible.

## Type Hints
- Use type hints on all function signatures: `def get_user(user_id: int) -> User:`.
- Use `from __future__ import annotations` for forward references.
- Use `Optional[T]` or `T | None` (Python 3.10+) for nullable types.
- Use `list[str]`, `dict[str, int]` (Python 3.9+) instead of `List`, `Dict`.
- Use `TypeVar`, `Generic`, `Protocol` for generic code.

## Error Handling
- Use specific exceptions: `ValueError`, `TypeError`, `KeyError`.
- Create custom exceptions inheriting from `Exception`.
- Use `try/except` with specific exception types, never bare `except:`.
- Use context managers (`with`) for resource management.

## Classes
- Use `@dataclass` for data-holding classes.
- Use `@property` for computed attributes.
- Prefer composition over inheritance.
- Use `__slots__` for performance-critical classes with many instances.
- Use `Protocol` for structural typing (duck typing with type safety).

## Functions
- Keep functions short (< 30 lines ideally).
- Use `*args` and `**kwargs` judiciously.
- Use keyword-only arguments after `*`: `def f(*, name: str)`.
- Return early for guard clauses.
- Use generators (`yield`) for lazy evaluation of sequences.

## Async
- Use `async/await` with `asyncio` for I/O-bound concurrency.
- Use `aiohttp` or `httpx` for async HTTP.
- Never mix sync and async I/O in the same call chain.
- Use `asyncio.gather()` for concurrent tasks.

## Testing
- Use `pytest` (not unittest) as test runner.
- Test files: `test_*.py` or `*_test.py`.
- Use fixtures (`@pytest.fixture`) for setup/teardown.
- Use `pytest.raises` for exception testing.
- Use `parametrize` for table-driven tests.

## Dependencies
- Use `pip install` with `requirements.txt` or `poetry` / `uv`.
- Pin versions in production: `requests==2.31.0`.
- Use virtual environments always.
- Run `pip freeze > requirements.txt` to lock versions.

## Code Style
- Follow PEP 8. Use `ruff` or `black` for formatting.
- Max line length: 88 (black) or 79 (PEP 8).
- Use f-strings for string formatting: `f"Hello {name}"`.
- Use list/dict/set comprehensions over `map`/`filter` when readable.
