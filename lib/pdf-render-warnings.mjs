const FONT_HINT_PREFIX = "Warning: TT: undefined function: ";
const FONT_HINT_WARNING =
  /^Warning: TT: undefined function: (0|[1-9][0-9]{0,4})$/;

/**
 * PDF.js 6.3.289 drops invalid TrueType hint bytecode while preserving glyph
 * outlines for this exact warning. Use this exception only with the renderer's
 * fixed disableFontFace: true setting. Other font/image/parser warnings remain
 * fatal; accepting this message does not authorize ignoring adjacent arguments.
 *
 * @param {unknown} args Console arguments, without coercion or concatenation.
 * @returns {boolean}
 */
export function isRecoverableFontHintWarning(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string")
    return false;
  const message = args[0];
  if (
    message.length < FONT_HINT_PREFIX.length + 1 ||
    message.length > FONT_HINT_PREFIX.length + 5
  )
    return false;
  const match = FONT_HINT_WARNING.exec(message);
  // JavaScript's $ can match before a final newline: require the entire string.
  return match !== null && match[0] === message && Number(match[1]) <= 65_535;
}
