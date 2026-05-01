import { Document, Packer, Paragraph, TextRun, HeadingLevel, ShadingType, Table, TableRow, TableCell, WidthType, BorderStyle } from 'docx';
import { marked } from 'marked';

// ── Docx style constants (sizes in half-points: 20 = 10pt, 24 = 12pt, etc.) ────

const FONT_BODY = 'Calibri';
const FONT_CODE = 'Courier New';
const SIZE_BODY = 32;       // 12pt
const SIZE_CODE = 26;       // 10pt
const SIZE_TABLE_HEADER = 32; // 10pt
const CODE_BG = 'F4F4F4';
const TABLE_HEADER_BG = 'E8EDF4';
const BORDER_COLOR = 'C4D0DE';
const BLOCKQUOTE_ACCENT = '122D4D';
const BLOCKQUOTE_TEXT = '3D5A7A';

type Token = {
  type: string;
  text?: string;
  depth?: number;
  items?: Token[];
  ordered?: boolean;
  lang?: string;
  header?: any[];
  rows?: any[];
  tokens?: Token[];
};

// ── Inline tokens → TextRun[] (bold, italic, code, links, etc.) ──────────

const inlineTokens = (tokens?: Token[], inheritedBold = false, inheritedItalic = false): TextRun[] => {
  if (!tokens || tokens.length === 0) return [];
  const runs: TextRun[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'text': {
        if (t.tokens && t.tokens.length > 0) {
          runs.push(...inlineTokens(t.tokens, inheritedBold, inheritedItalic));
        } else {
          runs.push(new TextRun({ text: t.text || '', bold: inheritedBold, italics: inheritedItalic }));
        }
        break;
      }
      case 'strong':
        runs.push(...inlineTokens(t.tokens, true, inheritedItalic));
        break;
      case 'em':
        runs.push(...inlineTokens(t.tokens, inheritedBold, true));
        break;
      case 'codespan':
        runs.push(
          new TextRun({ text: t.text || '', font: FONT_CODE, size: SIZE_CODE, bold: inheritedBold, shading: { type: ShadingType.CLEAR, fill: CODE_BG } }),
        );
        break;
      case 'link': {
        const text = extractText(t.tokens) || t.text || '';
        runs.push(new TextRun({ text, bold: inheritedBold, italics: inheritedItalic, style: 'Hyperlink' }));
        break;
      }
      case 'escape':
        runs.push(new TextRun({ text: t.text || '', bold: inheritedBold, italics: inheritedItalic }));
        break;
      default: {
        const text = extractText(t.tokens) || t.text || '';
        if (text) runs.push(new TextRun({ text, bold: inheritedBold, italics: inheritedItalic }));
      }
    }
  }
  return runs;
};

/** Extract plain text from nested tokens recursively */
const extractText = (tokens?: Token[]): string => {
  if (!tokens || tokens.length === 0) return '';
  return tokens.map((t) => {
    if (t.tokens && t.tokens.length > 0) return extractText(t.tokens);
    return t.text || '';
  }).join('');
};

// ── Block-level token → docx elements ─────────────────────────────────────

const headingLevel = (depth: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] => {
  switch (depth) {
    case 1: return HeadingLevel.HEADING_1;
    case 2: return HeadingLevel.HEADING_2;
    case 3: return HeadingLevel.HEADING_3;
    default: return HeadingLevel.HEADING_4;
  }
};

const tableBorders = {
  top: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
  left: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
  right: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
};

const cellText = (cell: any): string => {
  if (typeof cell === 'string') return cell;
  if (cell?.text) return cell.text;
  if (Array.isArray(cell?.tokens)) return extractText(cell.tokens);
  return '';
};

const createElements = (tokens: Token[]): (Paragraph | Table)[] => {
  const elements: (Paragraph | Table)[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        elements.push(
          new Paragraph({
            children: inlineTokens(token.tokens),
            heading: headingLevel(token.depth || 1),
            spacing: { before: 240, after: 120 },
          }),
        );
        break;

      case 'paragraph':
        elements.push(
          new Paragraph({
            children: inlineTokens(token.tokens),
            spacing: { after: 120 },
          }),
        );
        break;

      case 'code': {
        const lines = (token.text || '').split('\n');
        for (const line of lines) {
          elements.push(
            new Paragraph({
              spacing: { after: 0, line: 260 },
              children: [new TextRun({ text: line || ' ', font: FONT_CODE, size: SIZE_CODE })],
              shading: { type: ShadingType.CLEAR, fill: CODE_BG },
            }),
          );
        }
        break;
      }

      case 'blockquote': {
        // blockquote contains nested block tokens (paragraphs, etc.)
        if (token.tokens && token.tokens.length > 0) {
          const bqBlocks = createElements(token.tokens);
          for (const block of bqBlocks) {
            if (block instanceof Paragraph) {
              // Re-wrap with blockquote styling
              const existingRuns = (block as any).root?.[0]?.root?.children || [];
              elements.push(
                new Paragraph({
                  children: existingRuns.length > 0 ? existingRuns : [new TextRun({ text: ' ', color: BLOCKQUOTE_TEXT })],
                  spacing: { after: 40 },
                  indent: { left: 720 },
                  border: { left: { style: BorderStyle.SINGLE, size: 6, color: BLOCKQUOTE_ACCENT, space: 10 } },
                }),
              );
            } else {
              elements.push(block);
            }
          }
        } else {
          // Fallback: raw text
          const bqText = token.text || '';
          bqText.split('\n').forEach((line) => {
            elements.push(
              new Paragraph({
                children: [new TextRun({ text: line || ' ', color: BLOCKQUOTE_TEXT })],
                spacing: { after: 40 },
                indent: { left: 720 },
                border: { left: { style: BorderStyle.SINGLE, size: 6, color: BLOCKQUOTE_ACCENT, space: 10 } },
              }),
            );
          });
        }
        break;
      }

      case 'list': {
        const listItems = token.items || [];
        listItems.forEach((item, i) => {
          const prefix = token.ordered ? `${i + 1}. ` : '\u2022 ';
          const runs: TextRun[] = [new TextRun({ text: prefix })];
          // Each list item has tokens — may contain paragraphs with inline formatting
          if (item.tokens && item.tokens.length > 0) {
            // The first token is usually a "text" or "paragraph" with the content
            for (const sub of item.tokens) {
              if (sub.type === 'text' || sub.type === 'paragraph') {
                runs.push(...inlineTokens(sub.tokens || [{ type: 'text', text: sub.text || '' }]));
              } else if (sub.type === 'list') {
                // Nested list — add to elements as separate paragraphs after the current one
                // Will be handled below
              } else {
                runs.push(...inlineTokens(sub.tokens || [{ type: 'text', text: sub.text || '' }]));
              }
            }
          } else {
            runs.push(new TextRun({ text: item.text || '' }));
          }
          elements.push(
            new Paragraph({
              children: runs,
              spacing: { after: 40 },
              indent: { left: 360 },
            }),
          );
          // Handle nested lists
          if (item.tokens) {
            for (const sub of item.tokens) {
              if (sub.type === 'list') {
                elements.push(...createElements([sub]));
              }
            }
          }
        });
        break;
      }

      case 'table': {
        const headerCells = (token.header || []).map(
          (cell: any) =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: cellText(cell), bold: true, size: SIZE_TABLE_HEADER })] })],
              borders: tableBorders,
              shading: { type: ShadingType.CLEAR, fill: TABLE_HEADER_BG },
              width: { size: Math.floor(9000 / Math.max((token.header || []).length, 1)), type: WidthType.DXA },
            }),
        );
        const dataRows = (token.rows || []).map(
          (row: any) =>
            new TableRow({
              children: (Array.isArray(row) ? row : []).map(
                (cell: any) =>
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun({ text: cellText(cell) })] })],
                    borders: tableBorders,
                    width: { size: Math.floor(9000 / Math.max((token.header || []).length, 1)), type: WidthType.DXA },
                  }),
              ),
            }),
        );
        elements.push(
          new Table({
            rows: [new TableRow({ children: headerCells }), ...dataRows],
            width: { size: 9000, type: WidthType.DXA },
          }),
        );
        break;
      }

      case 'hr':
        elements.push(
          new Paragraph({
            children: [],
            spacing: { before: 200, after: 200 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR, space: 1 } },
          }),
        );
        break;

      case 'space':
        break;

      default:
        if (token.tokens && token.tokens.length > 0) {
          elements.push(new Paragraph({ children: inlineTokens(token.tokens), spacing: { after: 120 } }));
        } else if (token.text) {
          elements.push(new Paragraph({ children: inlineTokens([{ type: 'text', text: token.text }]), spacing: { after: 120 } }));
        }
    }
  }

  return elements;
};

export const generateDocxBlob = async (content: string, title?: string): Promise<Blob> => {
  const tokens = marked.lexer(content) as Token[];
  const children = createElements(tokens);

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT_BODY, size: SIZE_BODY },
        },
      },
    },
    sections: [
      {
        properties: {},
        children: title
          ? [new Paragraph({ children: [new TextRun({ text: title })], heading: HeadingLevel.TITLE, spacing: { after: 300 } }), ...children]
          : children,
      },
    ],
  });

  return Packer.toBlob(doc);
};
