import {
  formatFinalTypecheckReminder,
  hasTypeErrors,
} from "../finalTypecheckGate";
import type { EditDiagnostic } from "../editDiagnostics";

/** Helper: constrói um diagnóstico com defaults sensatos. */
function diag(
  file: string,
  line: number,
  code: number,
  severity: "error" | "warning" = "error",
  message = `'${file}' is not defined`,
): EditDiagnostic {
  return { file, line, column: 3, message, severity, code };
}

describe("finalTypecheckGate — formatFinalTypecheckReminder", () => {
  it("returns empty string when there are no errors (warnings do not trigger)", () => {
    expect(formatFinalTypecheckReminder([diag("a.ts", 10, 6133, "warning")])).toBe("");
  });

  it("emits a DIRECT user message, NOT a <system-reminder>", () => {
    const text = formatFinalTypecheckReminder([diag("src/x.ts", 12, 2304)]);
    // O ponto crítico do gate: o inter-turno vai dentro de
    // <system-reminder>, que o modelo pode ignorar. O gate final vai como
    // user message direta — não pode ter a marca.
    expect(text.startsWith("<system-reminder>")).toBe(false);
    expect(text).not.toContain("</system-reminder>");
    expect(text).not.toContain("<system-reminder>");
  });

  it("lists file:line:column and the TS code for each error", () => {
    const text = formatFinalTypecheckReminder([
      diag("src/App.tsx", 45, 2304),
      diag("src/lib.ts", 2, 2552),
    ]);
    expect(text).toContain("src/App.tsx:45:3");
    expect(text).toContain("TS2304");
    expect(text).toContain("src/lib.ts:2:3");
    expect(text).toContain("TS2552");
    expect(text).toContain("2 errors");
  });

  it("singularizes '1 error' vs 'N errors'", () => {
    expect(formatFinalTypecheckReminder([diag("a.ts", 1, 2304)])).toContain("1 error");
    expect(
      formatFinalTypecheckReminder([diag("a.ts", 1, 2304), diag("b.ts", 2, 2304)]),
    ).toContain("2 errors");
  });

  it("strips the project root prefix from file paths", () => {
    const text = formatFinalTypecheckReminder(
      [diag("/home/dev/proj/src/x.ts", 10, 2304, "error", "Cannot find name 'VStack'")],
      "/home/dev/proj",
    );
    expect(text).toContain("src/x.ts:10:3");
    // O caminho absoluto não deve aparecer no PATH do ficheiro — ia custar
    // tokens e ler mal. (A mensagem de erro pode conter o caminho se o modelo
    // o tiver escrito lá, mas o path do ficheiro listado é relativo.)
    expect(text).not.toMatch(/✗\s+\/home\/dev\/proj\/src\/x\.ts/);
  });

  it("truncates at MAX_SHOWN with a '+N more' line", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      diag(`f${i}.ts`, i + 1, 2304),
    );
    const text = formatFinalTypecheckReminder(many);
    // Conta TODOS no cabeçalho, mas só lista os primeiros MAX_SHOWN.
    expect(text).toContain("15 errors");
    expect(text).toMatch(/\+\d+ more/);
    // Os últimos ficheiros não aparecem listados individualmente.
    expect(text).not.toContain("f14.ts");
  });

  it("is imperative: instructs the model to fix and not end the run", () => {
    const text = formatFinalTypecheckReminder([diag("a.ts", 1, 2304)]);
    expect(text).toMatch(/Fix/i);
    expect(text).toMatch(/not done|do not end/i);
    // Confirma que referencia o type checker do projeto (credibilidade).
    expect(text).toContain("tsc");
  });

  it("ignores warnings when counting the error total", () => {
    const text = formatFinalTypecheckReminder([
      diag("a.ts", 1, 2304, "error"),
      diag("b.ts", 2, 6133, "warning"),
    ]);
    // O warning não entra na contagem nem na lista — só 1 erro.
    expect(text).toContain("1 error");
    expect(text).toContain("a.ts");
    expect(text).not.toContain("b.ts");
  });
});

describe("finalTypecheckGate — hasTypeErrors", () => {
  it("is true when at least one error-severity diagnostic", () => {
    expect(hasTypeErrors([diag("a.ts", 1, 2304, "error")])).toBe(true);
  });

  it("is true when errors and warnings mix", () => {
    expect(
      hasTypeErrors([
        diag("a.ts", 1, 6133, "warning"),
        diag("b.ts", 2, 2304, "error"),
      ]),
    ).toBe(true);
  });

  it("is false when only warnings", () => {
    expect(hasTypeErrors([diag("a.ts", 1, 6133, "warning")])).toBe(false);
  });

  it("is false on an empty list", () => {
    expect(hasTypeErrors([])).toBe(false);
  });
});
