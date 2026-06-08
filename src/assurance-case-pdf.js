// R-6 - Assurance case PDF renderer.
//
// Separate module from src/assurance-case.js so the JSON path never has to
// import pdfkit (pdfkit is heavy + ships native fonts; pulling it into every
// callsite would slow CLI startup and break air-gapped installs).
//
// Layout:
//
//   Cover page
//     - title:        "Trust Packet"
//     - artifact_id / workspace_id
//     - signed_by     (or "unsigned")
//     - generated_at
//     - spec version
//
//   Claims section (one block per claim)
//     - claim text   (bold)
//     - status pill  (text colour by status)
//     - evidence_ids (monospace list)
//     - limitations  (italic)
//
//   Controls section (table)
//     - framework | control_id | label | status | evidence_id
//
// Colour palette (constrained - NO browns / beiges / oranges per spec):
//   ink:        #111111
//   muted:      #555555
//   rule:       #cccccc
//   ok green:   #166534
//   warn cyan:  #0e7490
//   bad red:    #991b1b
//   info blue:  #1d4ed8
//
// All numeric colour spec lives in COLOR below so a future tweak touches one
// place. Any change must keep the constraint set.

export const COLOR = Object.freeze({
  ink:    '#111111',
  muted:  '#555555',
  rule:   '#cccccc',
  ok:     '#166534', // green - implemented
  warn:   '#0e7490', // cyan - package-gated
  bad:    '#991b1b', // red - external-proof-needed
  info:   '#1d4ed8', // blue - certification-gated
});

function _statusColour(status) {
  if (status === 'implemented') return COLOR.ok;
  if (status === 'package-gated') return COLOR.warn;
  if (status === 'certification-gated') return COLOR.info;
  return COLOR.bad;
}

// renderAssuranceCasePdf(envelope, outputStream) -> Promise<void>
//
// Writes the trust packet PDF to `outputStream` (any writable stream;
// callers pass fs.createWriteStream(path) for the CLI, res for the router).
// Returns a Promise that resolves on stream finish.
//
// pdfkit is imported lazily so an environment without pdfkit can still load
// this module (the JSON path will work, only the PDF path will throw with a
// clear install hint).
export async function renderAssuranceCasePdf(envelope, outputStream) {
  let PDFDocumentCtor;
  try {
    const mod = await import('pdfkit');
    PDFDocumentCtor = mod.default || mod;
  } catch (e) {
    const err = new Error(`pdfkit not installed - install via 'npm install pdfkit'. underlying: ${e.message}`);
    err.code = 'PDFKIT_UNAVAILABLE';
    throw err;
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocumentCtor({ size: 'LETTER', margin: 54, info: {
      Title: 'Trust Packet',
      Author: 'kolm.ai',
      Subject: envelope && envelope.artifact_id ? `Trust Packet for ${envelope.artifact_id}` : 'Trust Packet',
      Producer: 'kolm assurance-case-pdf',
    }});
    doc.pipe(outputStream);
    outputStream.on('finish', resolve);
    outputStream.on('error', reject);
    doc.on('error', reject);

    _renderCover(doc, envelope);
    _renderClaims(doc, envelope);
    _renderControls(doc, envelope);
    _renderFooter(doc, envelope);
    doc.end();
  });
}

function _renderCover(doc, envelope) {
  doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(28).text('Trust Packet', { align: 'left' });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor(COLOR.muted)
    .text(`spec: ${envelope.spec || 'unknown'}`)
    .text(`generated: ${envelope.generated_at || 'unknown'}`);
  doc.moveDown(1.2);

  doc.font('Helvetica-Bold').fontSize(12).fillColor(COLOR.ink).text('Subject');
  doc.font('Helvetica').fontSize(11).fillColor(COLOR.ink);
  if (envelope.artifact_id) doc.text(`artifact_id: ${envelope.artifact_id}`);
  if (envelope.workspace_id) doc.text(`workspace_id: ${envelope.workspace_id}`);
  if (!envelope.artifact_id && !envelope.workspace_id) doc.text('(workspace-level export, no specific artifact)');
  doc.moveDown(0.8);

  doc.font('Helvetica-Bold').fontSize(12).text('Signature');
  doc.font('Helvetica').fontSize(11);
  doc.text(envelope.signed_by ? envelope.signed_by : 'unsigned (no Ed25519 receipt on source artifact)');
  doc.moveDown(0.8);

  if (envelope.meta) {
    doc.font('Helvetica-Bold').fontSize(12).text('Summary');
    doc.font('Helvetica').fontSize(11);
    doc.text(`claims: ${envelope.meta.n_claims}`);
    doc.text(`controls: ${envelope.meta.n_controls}`);
    if (Array.isArray(envelope.meta.frameworks_covered)) {
      doc.text(`frameworks: ${envelope.meta.frameworks_covered.join(', ')}`);
    }
    if (typeof envelope.meta.vault_rows_indexed === 'number') {
      doc.text(`procurement vault rows indexed: ${envelope.meta.vault_rows_indexed}`);
    }
  }
}

function _renderClaims(doc, envelope) {
  doc.addPage();
  doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(18).text('Claims');
  doc.moveDown(0.5);

  const claims = Array.isArray(envelope.claims) ? envelope.claims : [];
  if (claims.length === 0) {
    doc.font('Helvetica').fontSize(11).fillColor(COLOR.muted).text('(no claims)');
    return;
  }

  for (const c of claims) {
    if (doc.y > 700) doc.addPage();

    doc.font('Helvetica-Bold').fontSize(12).fillColor(COLOR.ink).text(c.claim || '(no claim text)');
    doc.font('Helvetica').fontSize(10).fillColor(_statusColour(c.status)).text(`status: ${c.status || 'unknown'}`);
    doc.fillColor(COLOR.ink);

    if (Array.isArray(c.evidence_ids) && c.evidence_ids.length) {
      doc.font('Helvetica').fontSize(10).fillColor(COLOR.muted).text('evidence:');
      doc.font('Courier').fontSize(9).fillColor(COLOR.ink);
      for (const e of c.evidence_ids) doc.text('  ' + e);
    } else {
      doc.font('Helvetica').fontSize(10).fillColor(COLOR.muted).text('evidence: (none attached)');
    }

    if (c.limitations) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLOR.muted)
        .text('limitations: ' + c.limitations, { align: 'left' });
    }
    doc.moveDown(0.6);

    // horizontal rule
    const y = doc.y;
    doc.strokeColor(COLOR.rule).lineWidth(0.5).moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).stroke();
    doc.moveDown(0.6);
  }
}

function _renderControls(doc, envelope) {
  doc.addPage();
  doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(18).text('Controls');
  doc.moveDown(0.5);

  const controls = Array.isArray(envelope.controls) ? envelope.controls : [];
  if (controls.length === 0) {
    doc.font('Helvetica').fontSize(11).fillColor(COLOR.muted).text('(no controls)');
    return;
  }

  // Group by framework for readability.
  const grouped = {};
  for (const ctrl of controls) {
    const key = ctrl.framework_label || ctrl.framework || '(no framework)';
    (grouped[key] = grouped[key] || []).push(ctrl);
  }

  for (const fwLabel of Object.keys(grouped)) {
    if (doc.y > 680) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(COLOR.ink).text(fwLabel);
    doc.moveDown(0.3);

    for (const c of grouped[fwLabel]) {
      if (doc.y > 720) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.ink).text(`${c.control_id} - ${c.label || ''}`);
      doc.font('Helvetica').fontSize(9).fillColor(_statusColour(c.implementation_status))
        .text(`status: ${c.implementation_status || 'unknown'}`);
      doc.fillColor(COLOR.ink);
      doc.font('Courier').fontSize(9).text('evidence: ' + (c.evidence_id || '(none - request from vendor)'));
      doc.moveDown(0.4);
    }
    doc.moveDown(0.4);
  }
}

function _renderFooter(doc, envelope) {
  doc.font('Helvetica').fontSize(8).fillColor(COLOR.muted);
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.height - 36;
    doc.text(
      `kolm.ai trust packet - ${envelope.spec || ''} - page ${i + 1 - range.start} of ${range.count}`,
      doc.page.margins.left,
      bottom,
      { align: 'center', width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
  }
}
