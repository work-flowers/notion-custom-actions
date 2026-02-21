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
            const hasRowHeader = !!blockData?.has_row_header;
            const hasColumnHeader = !!blockData?.has_column_header;
            console.log(`[table] block.id=${block.id}, table_width=${blockData?.table_width}, has_row_header=${blockData?.has_row_header}, has_column_header=${blockData?.has_column_header}, rows=${dataRows.length}, colCount=${actualColCount}`);
            chunks.push({ type: 'table_rows', rows: dataRows, colCount: actualColCount, hasRowHeader, hasColumnHeader });
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

  // Merge consecutive table chunks into one markdown table block, then
  // render everything to final markdown.  Tables are rendered as a SINGLE
  // string with \n between rows so that the final \n\n join doesn't break
  // the table apart.
  //
  // Merging is aggressive: column counts do NOT need to match. Shorter
  // rows are padded with empty cells to match the widest table in the run.
  // Empty-string chunks (from empty Notion paragraphs) between table
  // chunks are skipped so they don't break the consecutive-table detection.
  function mergeAndRender(chunks: any[]): string[] {
    // Pre-filter: remove empty-string chunks that sit between two table
    // chunks, since Notion often inserts empty paragraphs between blocks.
    const filtered: any[] = [];
    for (let k = 0; k < chunks.length; k++) {
      const cur = chunks[k];
      const isEmptyString = typeof cur === 'string' && cur.trim() === '';
      if (isEmptyString) {
        // Look back and forward for adjacent table chunks
        const prev = filtered.length > 0 ? filtered[filtered.length - 1] : null;
        const next = k + 1 < chunks.length ? chunks[k + 1] : null;
        const prevIsTable = prev && typeof prev === 'object' && prev.type === 'table_rows';
        const nextIsTable = next && typeof next === 'object' && next.type === 'table_rows';
        if (prevIsTable && nextIsTable) {
          // Drop this empty chunk — it would break table merging
          continue;
        }
      }
      filtered.push(cur);
    }

    // Debug: log chunk types and colCounts so we can verify in Zapier test panel
    console.log('[mergeAndRender] chunks after filtering:', filtered.map((c, idx) => {
      if (c && typeof c === 'object' && c.type === 'table_rows') {
        return `[${idx}] table_rows (colCount=${c.colCount}, rows=${c.rows.length})`;
      }
      return `[${idx}] string: "${typeof c === 'string' ? c.substring(0, 40) : String(c)}"`;
    }));

    const output: string[] = [];
    let i = 0;

    while (i < filtered.length) {
      const chunk = filtered[i];

      if (chunk && typeof chunk === 'object' && chunk.type === 'table_rows') {
        // Collect ALL consecutive table chunks regardless of column count
        const tableGroup: Array<{ rows: string[][]; colCount: number; hasRowHeader: boolean; hasColumnHeader: boolean }> = [chunk];
        let j = i + 1;

        while (
          j < filtered.length &&
          filtered[j] &&
          typeof filtered[j] === 'object' &&
          filtered[j].type === 'table_rows'
        ) {
          tableGroup.push(filtered[j]);
          j++;
        }

        // Find the max column count across all merged tables
        const maxCols = Math.max(...tableGroup.map(t => t.colCount));

        // Flatten all rows, padding shorter ones with empty cells
        const mergedRows: string[][] = [];
        for (const t of tableGroup) {
          for (const row of t.rows) {
            if (row.length < maxCols) {
              mergedRows.push([...row, ...Array(maxCols - row.length).fill('')]);
            } else {
              mergedRows.push(row);
            }
          }
        }

        // The first chunk determines header flags for the merged table
        const hasRowHeader = tableGroup[0].hasRowHeader;
        const hasColumnHeader = tableGroup[0].hasColumnHeader;

        console.log(`[mergeAndRender] merged ${tableGroup.length} table chunk(s) → ${mergedRows.length} rows, maxCols=${maxCols}, hasRowHeader=${hasRowHeader}, hasColumnHeader=${hasColumnHeader}`);

        // If hasColumnHeader, wrap the first cell of each row in **bold**
        // (only if it isn't already bold-wrapped)
        if (hasColumnHeader) {
          for (const row of mergedRows) {
            if (row[0] && !row[0].startsWith('**')) {
              row[0] = `**${row[0]}**`;
            }
          }
        }

        // Build the entire table as a single string with \n between rows
        const tableLines: string[] = [];

        if (hasRowHeader) {
          // First row is the header row, followed by separator
          for (let rowIdx = 0; rowIdx < mergedRows.length; rowIdx++) {
            tableLines.push(`| ${mergedRows[rowIdx].join(' | ')} |`);
            if (rowIdx === 0) {
              tableLines.push(`| ${mergedRows[rowIdx].map(() => '---').join(' | ')} |`);
            }
          }
        } else {
          // No header row — insert a blank header + separator, then all rows as data
          tableLines.push(`| ${Array(maxCols).fill(' ').join(' | ')} |`);
          tableLines.push(`| ${Array(maxCols).fill('---').join(' | ')} |`);
          for (const row of mergedRows) {
            tableLines.push(`| ${row.join(' | ')} |`);
          }
        }

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