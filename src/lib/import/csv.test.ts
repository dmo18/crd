import { describe, expect, it } from "vitest";
import { guardFormula, quoteField } from "@/lib/export/csv";
import { CSV_MESSAGES, MAX_CSV_BYTES, MAX_CSV_COLUMNS, MAX_CSV_ROWS, parseCsv, unguardCell, utf8Bytes } from "./csv";

const ok = (text: string) => {
  const r = parseCsv(text);
  if (!r.ok) throw new Error(`unexpected error: ${r.error}`);
  return r;
};

describe("parseCsv", () => {
  it("reads a plain file", () => {
    expect(ok("Player,Year\nKen Griffey Jr.,1989\nFrank Thomas,1990\n")).toEqual({
      ok: true, header: ["Player", "Year"], rows: [["Ken Griffey Jr.", "1989"], ["Frank Thomas", "1990"]],
    });
  });

  it("reads quoted cells with commas, doubled quotes and line breaks inside", () => {
    const r = ok('Player,Notes\r\n"Griffey, Ken","He said ""wow""\r\nsecond line"\r\n"",x\r\n');
    expect(r.rows).toEqual([["Griffey, Ken", 'He said "wow"\r\nsecond line'], ["", "x"]]);
  });

  it("reads CRLF, LF and lone CR line ends the same", () => {
    const want = [["a", "b"], ["c", "d"]];
    expect(ok("H1,H2\r\na,b\r\nc,d").rows).toEqual(want);
    expect(ok("H1,H2\na,b\nc,d").rows).toEqual(want);
    expect(ok("H1,H2\ra,b\rc,d").rows).toEqual(want);
    expect(ok("H1,H2\r\na,b\nc,d\r").rows).toEqual(want);
  });

  it("drops a byte order mark, empty lines and empty trailing lines", () => {
    const r = ok("﻿Player,Year\r\n\r\nA,1\r\n,\r\n\r\n\r\n");
    expect(r.header).toEqual(["Player", "Year"]);
    expect(r.rows).toEqual([["A", "1"]]);
  });

  it("pads short rows and cuts long rows to the header's width", () => {
    expect(ok("a,b,c\n1\n1,2,3,4").rows).toEqual([["1", "", ""], ["1", "2", "3"]]);
    expect(ok("a,b\n1,").rows).toEqual([["1", ""]]);
  });

  it("keeps a quote in the middle of a cell as plain text", () => {
    expect(ok('Item,Size\nBinder,5" tall\n').rows).toEqual([["Binder", '5" tall']]);
  });

  it("never runs anything: formula text is kept as text", () => {
    const r = ok('Player,Notes\n=SUM(A1:A9),+1\n@cmd,-2\n"=HYPERLINK(""http://x"",""y"")",ok\n');
    expect(r.rows).toEqual([["=SUM(A1:A9)", "+1"], ["@cmd", "-2"], ['=HYPERLINK("http://x","y")', "ok"]]);
  });

  it("refuses an unclosed quote, empty text and a header with no rows", () => {
    expect(parseCsv('a,b\n"open,1\n')).toEqual({ ok: false, error: CSV_MESSAGES.openQuote });
    expect(parseCsv("")).toEqual({ ok: false, error: CSV_MESSAGES.empty });
    expect(parseCsv("﻿ \r\n\r\n")).toEqual({ ok: false, error: CSV_MESSAGES.empty });
    expect(parseCsv("Player,Year\r\n\r\n")).toEqual({ ok: false, error: CSV_MESSAGES.noRows });
    expect(parseCsv("a,b\n\u0000\u0001")).toEqual({ ok: false, error: CSV_MESSAGES.notCsv });
  });

  it("refuses files over 5 MB, counting UTF-8 bytes", () => {
    expect(MAX_CSV_BYTES).toBe(5 * 1024 * 1024);
    const filler = "x".repeat(MAX_CSV_BYTES - 10);
    expect(parseCsv(`a\n${filler}`).ok).toBe(true);
    expect(parseCsv(`a\n${filler}${"é".repeat(10)}`)).toEqual({ ok: false, error: CSV_MESSAGES.tooBig });
    expect(utf8Bytes("aé€😀")).toBe(1 + 2 + 3 + 4);
  });

  it("allows 20,000 rows and refuses 20,001, empty lines not counted", () => {
    expect(MAX_CSV_ROWS).toBe(20_000);
    const rows = (n: number) => `Player\n${Array.from({ length: n }, (_, i) => `P${i}`).join("\n")}\n\n\n`;
    expect(ok(rows(MAX_CSV_ROWS)).rows).toHaveLength(MAX_CSV_ROWS);
    expect(parseCsv(rows(MAX_CSV_ROWS + 1))).toEqual({ ok: false, error: CSV_MESSAGES.tooManyRows });
    // A file of nothing but empty lines is just empty, however long.
    expect(parseCsv(`Player\nA${"\n".repeat(100_000)}`).ok).toBe(true);
  });

  it("refuses too many columns", () => {
    expect(parseCsv(`${Array(MAX_CSV_COLUMNS + 1).fill("h").join(",")}\n1`)).toEqual({ ok: false, error: CSV_MESSAGES.tooManyColumns });
  });
});

describe("the export's formula guard and the import", () => {
  it("unguards exactly what the export guarded, so a round trip gives the same text", () => {
    for (const s of ["=1+1", "+44 123", "-5", "@SUM(A1)", " =X", "\n=1", "\t", "Ken Griffey Jr.", "'quoted'", "'=already"]) {
      expect(unguardCell(guardFormula(s))).toBe(s);
    }
    // An apostrophe before ordinary text is the owner's own and is kept.
    expect(unguardCell("'89 Topps")).toBe("'89 Topps");
  });

  it("an imported formula cell exported again is made safe", () => {
    const back = ok(`Notes\n${quoteField(guardFormula("=HYPERLINK(\"http://x\")"))}\n`).rows[0][0];
    expect(back).toBe("'=HYPERLINK(\"http://x\")");
    expect(guardFormula(unguardCell(back))).toBe(back);
  });
});
