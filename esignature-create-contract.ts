// ============================================================
// eSignatures.com — "Send Contract" Action (Zapier Platform UI)
// ============================================================
// Paste this into Code Mode for the action's API Configuration.
//
// HOW IT WORKS:
// The template on eSignatures.com should contain a placeholder
// field like {{contract_body}}. This action converts markdown
// into document_elements and injects them into that placeholder.
//
// INPUT FIELDS (configure in Input Designer):
// ─────────────────────────────────────────────
// template_id              (string, required)  — dynamic dropdown
// title                    (string, required)  — contract title
// placeholder_field_name   (string, required)  — the placeholder key in your
//                                                template, e.g. "contract_body"
// markdown                 (text, required)    — full contract body as markdown
// signers (line items):
//   signers__name           (string, required)
//   signers__email          (string, required)
//   signers__signing_order  (integer, required)
// save_as_draft            (boolean, optional) — defaults to "no"
// test                     (boolean, optional) — send as demo contract
//
// SIGNER FIELD MARKER SYNTAX (in markdown):
// [SIGNER_FIELD type="signature" label="Client Signature"
//   assigned_to="first_signer" id="client_sig"]
//
// Supported types map to eSignatures document_element types:
//   signature       → signer_field_text (labelled as signature)
//   text            → signer_field_text
//   text_area       → signer_field_text_area
//   date            → signer_field_date
//   dropdown        → signer_field_dropdown (use options="A\nB\nC")
//   checkbox        → signer_field_checkbox
//   radiobutton     → signer_field_radiobutton
//   file_upload     → signer_field_file_upload
// ============================================================

// ── Markdown → document_elements parser ──────────────────────

function parseMarkdown(md) {
  const elements = [];

  // Normalise escaped quotes from Notion (" → ")
  const cleaned = md.replace(/\\"/g, '"');

  const lines = cleaned.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // ── Skip horizontal rules (---) ──
    if (line.trim().match(/^-{3,}$/) || line.trim().match(/^\*{3,}$/) || line.trim().match(/^_{3,}$/)) {
      i++;
      continue;
    }

    // ── Custom signer field marker ──
    const signerFieldMatch = line.trim().match(
      /^\[SIGNER_FIELD\s+(.*)\]$/
    );
    if (signerFieldMatch) {
      const attrs = {};
      const attrRegex = /(\w+)="([^"]*)"/g;
      let m;
      while ((m = attrRegex.exec(signerFieldMatch[1])) !== null) {
        attrs[m[1]] = m[2];
      }

      const typeMap = {
        signature: 'signer_field_text',
        text: 'signer_field_text',
        text_area: 'signer_field_text_area',
        date: 'signer_field_date',
        dropdown: 'signer_field_dropdown',
        checkbox: 'signer_field_checkbox',
        radiobutton: 'signer_field_radiobutton',
        file_upload: 'signer_field_file_upload',
      };

      const element = {
        type: typeMap[attrs.type] || 'signer_field_text',
        text: attrs.label || '',
        signer_field_assigned_to: attrs.assigned_to || 'first_signer',
      };

      if (attrs.id) element.signer_field_id = attrs.id;
      if (attrs.required) element.signer_field_required = attrs.required;
      if (attrs.options) element.signer_field_dropdown_options = attrs.options;
      if (attrs.default) element.signer_field_default_value = attrs.default;
      if (attrs.placeholder) element.signer_field_placeholder_text = attrs.placeholder;

      elements.push(element);
      i++;
      continue;
    }

    // ── Markdown table ──
    // Detect table: current line has pipes, next line is a separator row
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableRows = [];
      let isHeaderRow = true;
      let j = i;

      while (j < lines.length && lines[j].trim().startsWith('|') && lines[j].trim().endsWith('|')) {
        const rowText = lines[j].trim();

        // Check if this is a separator row (|---|---|)
        if (rowText.match(/^\|[\s\-:|]+\|$/)) {
          j++;
          continue;
        }

        // Parse cells: split on |, trim, remove first/last empty entries
        const cells = rowText
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim());

        const rowCells = cells.map((cellText) => {
          // Detect per-cell bold wrapping (from Notion column headers)
          const isBold = /^\*\*.*\*\*$/.test(cellText.trim());
          const cell = { text: stripInline(cellText) };
          if (isBold) {
            cell.styles = ['bold'];
          }
          return cell;
        });

        tableRows.push(rowCells);
        isHeaderRow = false;
        j++;
      }

      if (tableRows.length > 0) {
        elements.push({
          type: 'table',
          table_cells: tableRows,
        });
      }

      i = j;
      continue;
    }

    // ── Headings (check ### before ## before #) ──
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      elements.push({
        type: 'text_header_three',
        text: stripInline(h3Match[1]),
      });
      i++;
      continue;
    }

    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      elements.push({
        type: 'text_header_two',
        text: stripInline(h2Match[1]),
      });
      i++;
      continue;
    }

    const h1Match = line.match(/^#\s+(.+)/);
    if (h1Match) {
      elements.push({
        type: 'text_header_one',
        text: stripInline(h1Match[1]),
      });
      i++;
      continue;
    }

    // ── Unordered list items (- or *) ──
    const ulMatch = line.match(/^[\s]*[-*]\s+(.+)/);
    if (ulMatch) {
      elements.push({
        type: 'unordered_list_item',
        text: stripInline(ulMatch[1]),
      });
      i++;
      continue;
    }

    // ── Ordered list items (1. 2. etc.) ──
    const olMatch = line.match(/^[\s]*\d+\.\s+(.+)/);
    if (olMatch) {
      elements.push({
        type: 'ordered_list_item',
        text: stripInline(olMatch[1]),
      });
      i++;
      continue;
    }

    // ── Regular paragraph ──
    elements.push({
      type: 'text_normal',
      text: stripInline(line.trim()),
    });
    i++;
  }

  return elements;
}

// Strip inline markdown formatting: bold, italic, code, strikethrough
function stripInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/__(.+?)__/g, '$1')         // __bold__
    .replace(/\*(.+?)\*/g, '$1')         // *italic*
    .replace(/_(.+?)_/g, '$1')           // _italic_
    .replace(/`(.+?)`/g, '$1')           // `code`
    .replace(/~~(.+?)~~/g, '$1')         // ~~strikethrough~~
    .trim();
}

// ── Build signers array from line items ──────────────────────

function buildSigners(inputData) {
  const names = inputData.signers__name || [];
  const emails = inputData.signers__email || [];
  const orders = inputData.signers__signing_order || [];

  const nameArr = Array.isArray(names) ? names : [names];
  const emailArr = Array.isArray(emails) ? emails : [emails];
  const orderArr = Array.isArray(orders) ? orders : [orders];

  const signers = [];
  for (let i = 0; i < nameArr.length; i++) {
    if (!nameArr[i] || !emailArr[i]) continue;
    signers.push({
      name: nameArr[i],
      email: emailArr[i],
      signing_order: String(parseInt(orderArr[i], 10) || (i + 1)),
    });
  }

  return signers;
}

// ── Main action ──────────────────────────────────────────────

// Handle markdown as array (Zapier comma-splitting) or string
const rawMarkdown = bundle.inputData.markdown || '';
let md;
if (Array.isArray(rawMarkdown)) {
  md = rawMarkdown.join(', ')
    .replace(/,?\s*(#{1,3}\s)/g, '\n\n$1')        // headings
    .replace(/,?\s*(---)/g, '\n\n$1')              // horizontal rules
    .replace(/,?\s*(- \()/g, '\n$1')               // list items like - (a)
    .replace(/,?\s*(\d+\.\s)/g, '\n$1');           // numbered lists
} else {
  md = rawMarkdown;
}

const documentElements = parseMarkdown(md);
const signers = buildSigners(bundle.inputData);

const requestBody = {
  template_id: bundle.inputData.template_id,
  signers: signers,
  placeholder_fields: [
    {
      api_key: bundle.inputData.placeholder_field_name,
      document_elements: documentElements,
    },
  ],
};

// Optional title
if (bundle.inputData.title) {
  requestBody.title = bundle.inputData.title;
}

// Draft flag
if (
  bundle.inputData.save_as_draft === 'yes' ||
  bundle.inputData.save_as_draft === true ||
  bundle.inputData.save_as_draft === 'true'
) {
  requestBody.save_as_draft = 'yes';
}

// Test flag
if (
  bundle.inputData.test === 'yes' ||
  bundle.inputData.test === true ||
  bundle.inputData.test === 'true'
) {
  requestBody.test = 'yes';
}

const options = {
  url: 'https://esignatures.com/api/contracts',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
  params: {
    token: bundle.authData.api_key, // adjust if your auth field key differs
  },
  body: requestBody,
};

return z.request(options).then((response) => {
  if (response.status >= 400) {
    throw new z.errors.Error(
      `eSignatures API error (${response.status}): ${JSON.stringify(response.json)}`,
      'ApiError',
      response.status
    );
  }
  return response.json;
});