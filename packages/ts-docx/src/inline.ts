import { TextRun } from "docx";
import type { Token } from "markdown-it";

interface InlineStyle {
  bold: boolean;
  italics: boolean;
  code: boolean;
}

const EMPTY_STYLE: InlineStyle = { bold: false, italics: false, code: false };

function textRun(text: string, style: InlineStyle): TextRun {
  return new TextRun({
    text,
    bold: style.bold,
    italics: style.italics,
    font: style.code ? "Courier New" : undefined,
  });
}

/** Inline markdown → DOCX runs. Links deliberately degrade to their visible label. */
export function inlineRuns(children: Token[] | null): TextRun[] {
  if (!children) return [];
  const out: TextRun[] = [];
  const style = { ...EMPTY_STYLE };
  for (const token of children) {
    if (token.type === "strong_open") style.bold = true;
    else if (token.type === "strong_close") style.bold = false;
    else if (token.type === "em_open") style.italics = true;
    else if (token.type === "em_close") style.italics = false;
    else if (token.type === "code_inline")
      out.push(textRun(token.content, { ...style, code: true }));
    else if (token.type === "softbreak") out.push(new TextRun({ break: 1 }));
    else if (token.type === "hardbreak") out.push(new TextRun({ break: 1 }));
    else if (token.type === "text" || token.type === "html_inline") {
      out.push(textRun(token.content, style));
    }
  }
  return out;
}
