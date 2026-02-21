export async function getNotionPageMarkdown({ pageId }: { pageId: string }): Promise<{ result: string }> {

  // Fetch all blocks with pagination
  async function fetchAllBlocks(blockId: string): Promise<any[]> {
    let allResults: any[] = [];
    let cursor: string | undefined = undefined;

    do {
      const url = cursor
        ? `https://api.notion.com/v1/blocks/${blockId}/children?start_cursor=${cursor}&page_size=100`
        : `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`;

      const response = await fetchWithZapier(url, {
        method: 'GET',
        headers: {
          'Notion-Version': '2025-09-03',
          'Content-Type': 'application/json',
        },
      });

      await response.throwErrorIfNotOk();
      const data = await response.json();
      allResults = allResults.concat(data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    return allResults;
  }

  // Convert rich_text array to markdown string
  function richTextToMarkdown(richTextArray: any[]): string {
    if (!richTextArray || richTextArray.length === 0) return '';
    return richTextArray.map((rt: any) => {
      let content = rt.plain_text;
      if (rt.annotations.bold) content = `**${content}**`;
      if (rt.annotations.italic) content = `*${content}*`;
      if (rt.annotations.strikethrough) content = `~~${content}~~`;
      if (rt.annotations.code) content = `\`${content}\``;
      if (rt.href) content = `[${content}](${rt.href})`;
      return content;
    }).join('');
  }

  // Recursively process blocks into chunks.
  // Each chunk is either a plain string or a structured table object
  // { type: 'table_rows', rows: string[][], colCount: number }
  async function processBlocks(blocks: any[], depth: number = 0): Promise<any[]> {
    const chunks: any[] = [];
    const indent = '  '.repeat(depth);

    for (const block of blocks) {
      const type = block.type;
      const blockData = block[type];

      switch (type) {
        case 'paragraph': {
          const text = richTextToMarkdown(blockData?.rich_text);
          chunks.push(`${indent}${text}`);
          break;
        }
        case 'heading_1': {
          const text = richTextToMarkdown(blockData?.rich_text);
          chunks.push(`# ${text}`);
          break;
        }
        case 'heading_2': {
          const text = richTextToMarkdown(blockData?.rich_text);
          chunks.push(`## ${text}`);
          break;
        }
        case 'heading_3': {
          const text = richTextToMarkdown(blockData?.rich_text);
          chunks.push(`### ${text}`);
          break;
        }
        case 'bulleted_list_item': {
          const text = richTextToMarkdown(blockData?.rich_text);
          chunks.push(`${indent}- ${text}`);
          break;
        }
        case 'numbered_list_item': {
          const text = richTextToMarkdown(blockData?.rich_text);
          chunks.push(`${indent}1. ${text}`);
          break;
        }
        case 'to_do': {
          const text = richTextToMarkdown(blockData?.rich_text);
          const checkbox = blockData?.checked ? '[x]' : '[ ]';
          chunks.push(`${indent}- ${checkbox} ${text}`);
          break;
        }
        case 'toggle': {
          const text = richTextToMarkdown(blockData?.rich_text);
          chunks.push(`${indent}${text}`);
          break;
        }
        case 'quote': {
          const text = richTextToMarkdown(blockData?.rich_text);
          chunks.push(`${indent}> ${text}`);
          break;
        }
        case 'callout': {
          const text = richTextToMarkdown(blockData?.rich_text);
          chunks.push(`${indent}> ${text}`);
          break;
        }
        case 'code': {
          const text = richTextToMarkdown(blockData?.rich_text);
          const lang = blockData?.language || '';
          chunks.push(`${indent}\`\`\`${lang}\n${indent}${text}\n${indent}\`\`\``);
          break;
        }
        case 'divider': {
          chunks.push('---');
          break;
        }
        case 'table': {
          const tableRows = await fetchAllBlocks(block.id);

          const dataRows: string[][] = [];
          for (const row of tableRows) {
            if (row.type !== 'table_row') continue;

            const cells = row.table_row.cells.map((cell: any[]) =>
              richTextToMarkdown(cell)
            );

            // Skip rows where all cells are empty
            if (cells.every((c: string) => c.trim() === '')) continue;

            dataRows.push(cells);
          }

          if (dataRows.length > 0) {
            const actualColCount = dataRows[0].length;
            chunks.push({ type: 'table_rows', rows: dataRows, colCount: actualColCount });
          }
          break;
        }
        case 'column_list':
        case 'column': {
          break;
        }
        case 'image': {
          const url = blockData?.file?.url || blockData?.external?.url || '';
          const caption = richTextToMarkdown(blockData?.caption);
          if (url) chunks.push(`![${caption}](${url})`);
          break;
        }
        default:
          break;
      }

      // Recurse into children (toggles, columns, synced blocks, etc.)
      if (block.has_children && type !== 'table') {
        const children = await fetchAllBlocks(block.id);
        const childChunks = await processBlocks(children, type === 'bulleted_list_item' || type === 'numbered_list_item' ? depth + 1 : depth);
        chunks.push(...childChunks);
      }
    }

    return chunks;
  }

  // Merge consecutive table chunks with the same column count into one
  // markdown table block, then render everything to final markdown.
  // Tables are rendered as a SINGLE string with \n between rows so that
  // the final \n\n join doesn't break the table apart.
  function mergeAndRender(chunks: any[]): string[] {
    const output: string[] = [];
    let i = 0;

    while (i < chunks.length) {
      const chunk = chunks[i];

      if (chunk && typeof chunk === 'object' && chunk.type === 'table_rows') {
        // Collect consecutive table chunks with the same column count
        const mergedRows: string[][] = [...chunk.rows];
        const colCount = chunk.colCount;
        let j = i + 1;

        while (
          j < chunks.length &&
          chunks[j] &&
          typeof chunks[j] === 'object' &&
          chunks[j].type === 'table_rows' &&
          chunks[j].colCount === colCount
        ) {
          mergedRows.push(...chunks[j].rows);
          j++;
        }

        // Build the entire table as a single string with \n between rows
        const tableLines: string[] = [];
        for (let rowIdx = 0; rowIdx < mergedRows.length; rowIdx++) {
          tableLines.push(`| ${mergedRows[rowIdx].join(' | ')} |`);
          // Always add separator after the first row
          if (rowIdx === 0) {
            tableLines.push(`| ${mergedRows[rowIdx].map(() => '---').join(' | ')} |`);
          }
        }
        // Join with single newline — this becomes one chunk in the output
        output.push(tableLines.join('\n'));

        i = j;
      } else {
        output.push(chunk);
        i++;
      }
    }

    return output;
  }

  // Main execution
  const blocks = await fetchAllBlocks(pageId);
  const chunks = await processBlocks(blocks);
  const outputChunks = mergeAndRender(chunks);
  const markdownResult = outputChunks.join('\n\n');

  return { result: markdownResult };
}