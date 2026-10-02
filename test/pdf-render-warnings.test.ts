import { describe, expect, it } from "vitest";
import { isRecoverableFontHintWarning } from "../lib/pdf-render-warnings.mjs";

const warning = "Warning: TT: undefined function: 21";

describe("isRecoverableFontHintWarning", () => {
  it.each([0, 1, 21, 255, 256, 65_534, 65_535])(
    "accepts the exact PDF.js hint warning for uint16 index %i",
    (index) => {
      expect(
        isRecoverableFontHintWarning([
          `Warning: TT: undefined function: ${index}`,
        ])
      ).toBe(true);
    }
  );

  it.each([
    "-1",
    "+1",
    "65536",
    "99999",
    "100000",
    "1.0",
    "1e1",
    "0x15",
    "NaN",
    "Infinity",
    "01",
    "00000",
    "２１",
    "٢١",
    "",
    " 21",
    "21 ",
    "21\n",
    "21\r",
    "21\r\n",
    "21\t",
    "21\u2028",
    "21\u2029",
    "21\0",
    "21. Image missing.",
  ])("rejects an out-of-range or noncanonical function index %j", (index) => {
    expect(
      isRecoverableFontHintWarning([
        `Warning: TT: undefined function: ${index}`,
      ])
    ).toBe(false);
  });

  it.each([
    "TT: undefined function: 21",
    "Error: TT: undefined function: 21",
    "warning: TT: undefined function: 21",
    "Warning: TT: undefined function:21",
    "Warning: TT: undefined functions: 21",
    "Warning: TT: Undefined function: 21",
    ` ${warning}`,
    `${warning}\nWarning: No cmap table available.`,
    `Warning: No cmap table available.\n${warning}`,
    `${warning}${" ".repeat(10_000)}`,
  ])("rejects a near-match warning %j", (message) => {
    expect(isRecoverableFontHintWarning([message])).toBe(false);
  });

  it.each([
    "Warning: TT: invalid function id: 21",
    "Warning: TT: more functions defined than expected",
    "Warning: TT: complementing a missing function tail",
    "Warning: Glyph index is not in fd select.",
    "Warning: Invalid fd index for glyph index.",
    "Warning: compileGlyf: skipping recursive composite glyph reference.",
    "Warning: No cmap table available.",
    "Warning: Could not find a preferred cmap table.",
    "Warning: cmap table has unsupported format: 99",
    "Warning: BMP image decoding failed: invalid header",
    "Warning: JpegImage.parse - reached the end of the image data without finding an EOI marker (0xFFD9).",
    "Warning: Image exceeded maximum allowed size and was removed.",
    "Warning: Failed to parse font g_d0_f1",
    'Warning: Font file is empty in "Example" (g_d0_f1)',
  ])("keeps other actual font/image warning classes fatal: %s", (message) => {
    expect(isRecoverableFontHintWarning([message])).toBe(false);
  });

  it.each([
    undefined,
    null,
    warning,
    21,
    {},
    { 0: warning, length: 1 },
    [],
    [undefined],
    [null],
    [21],
    [[warning]],
    [new Error(warning)],
    [new String(warning)],
    [warning, undefined],
    [warning, ""],
    [warning, "Warning: Image exceeded maximum allowed size and was removed."],
    ["Warning: TT: undefined function: ", 21],
  ])("rejects non-string values and extra console arguments %#", (args) => {
    expect(isRecoverableFontHintWarning(args)).toBe(false);
  });

  it("never coerces a console argument into an acceptable message", () => {
    let coerced = false;
    const item = {
      toString() {
        coerced = true;
        return warning;
      },
    };
    expect(isRecoverableFontHintWarning([item])).toBe(false);
    expect(coerced).toBe(false);
  });

  it("does not change the original console arguments", () => {
    const args = Object.freeze([warning]);
    expect(isRecoverableFontHintWarning(args)).toBe(true);
    expect(args).toEqual([warning]);
  });
});
