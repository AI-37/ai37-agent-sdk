import {
  BorderStyle,
  HeadingLevel,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ISectionOptions,
} from "docx";
import type { Token } from "markdown-it";
import { inlineRuns } from "./inline.js";

type Block = Paragraph | Table;
type Heading = (typeof HeadingLevel)[keyof typeof HeadingLevel];

interface BlockState {
  heading?: Heading;
  listStack: boolean[];
}

const HEADING_BY_TAG: Record<string, Heading> = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
};

function paragraphFromInline(token: Token, heading?: Heading): Paragraph {
  return new Paragraph({ children: inlineRuns(token.children), heading });
}

function listParagraph(
  token: Token,
  ordered: boolean,
  level: number,
): Paragraph {
  const list = ordered
    ? { numbering: { reference: "ai37-numbering", level } }
    : { bullet: { level } };
  return new Paragraph({ children: inlineRuns(token.children), ...list });
}

function tableAt(
  tokens: Token[],
  start: number,
): { block: Table; next: number } {
  const rows: TableRow[] = [];
  let cells: TableCell[] = [];
  let i = start + 1;
  while (i < tokens.length && tokens[i].type !== "table_close") {
    const token = tokens[i];
    if (token.type === "tr_open") cells = [];
    if (
      (token.type === "th_open" || token.type === "td_open") &&
      tokens[i + 1]?.type === "inline"
    ) {
      cells.push(
        new TableCell({ children: [paragraphFromInline(tokens[i + 1])] }),
      );
    }
    if (token.type === "tr_close") rows.push(new TableRow({ children: cells }));
    i += 1;
  }
  return {
    block: new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
    }),
    next: i + 1,
  };
}

function horizontalRule(): Paragraph {
  return new Paragraph({
    border: {
      bottom: { color: "808080", size: 4, style: BorderStyle.SINGLE, space: 6 },
    },
  });
}

function updateBlockState(token: Token, state: BlockState): boolean {
  if (token.type === "heading_open") state.heading = HEADING_BY_TAG[token.tag];
  else if (token.type === "heading_close") state.heading = undefined;
  else if (token.type === "bullet_list_open") state.listStack.push(false);
  else if (token.type === "ordered_list_open") state.listStack.push(true);
  else if (
    token.type === "bullet_list_close" ||
    token.type === "ordered_list_close"
  ) {
    state.listStack.pop();
  } else return false;
  return true;
}

function inlineParagraph(token: Token, state: BlockState): Paragraph {
  const ordered = state.listStack.at(-1);
  return ordered === undefined
    ? paragraphFromInline(token, state.heading)
    : listParagraph(token, ordered, Math.max(0, state.listStack.length - 1));
}

/** Block markdown tokens → DOCX section children. */
export function blockChildren(tokens: Token[]): ISectionOptions["children"] {
  const out: Block[] = [];
  const state: BlockState = { listStack: [] };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (updateBlockState(token, state)) {
      i += 1;
      continue;
    }
    if (token.type === "table_open") {
      const parsed = tableAt(tokens, i);
      out.push(parsed.block);
      i = parsed.next;
      continue;
    }
    if (token.type === "hr") out.push(horizontalRule());
    else if (token.type === "fence" || token.type === "code_block") {
      out.push(
        new Paragraph({
          children: [new TextRun({ text: token.content, font: "Courier New" })],
        }),
      );
    } else if (token.type === "inline") out.push(inlineParagraph(token, state));
    i += 1;
  }
  return out;
}
