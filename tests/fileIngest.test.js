// Pure unit tests for FILE ingest (§1.2).
//
// These extractors read untrusted customer-supplied bytes, which is why they
// are hand-written rather than dependency-backed — and why they need tests that
// feed them malformed input rather than only well-formed input.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const fileFunctions = require("../functions/knowledge/fileFunctions");

const b64 = (value) => Buffer.from(value).toString("base64");

// A minimal but real DOCX: a zip holding word/document.xml, stored uncompressed.
function makeDocx(documentXml) {
    const name = Buffer.from("word/document.xml");
    const content = Buffer.from(documentXml);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // method 0 = stored
    header.writeUInt32LE(0, 14); // crc, unchecked by the reader
    header.writeUInt32LE(content.length, 18); // compressed size
    header.writeUInt32LE(content.length, 22); // uncompressed size
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // extra length

    return Buffer.concat([header, name, content]);
}

// A minimal PDF with one Flate-compressed content stream.
function makePdf(operators) {
    const compressed = zlib.deflateSync(Buffer.from(operators, "latin1"));
    return Buffer.concat([
        Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 0 >>\nstream\n", "latin1"),
        compressed,
        Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
    ]);
}

describe("file validation", () => {
    test("rejects an unsupported extension", () => {
        const result = fileFunctions.validate({ filename: "payload.exe", base64: b64("MZ") });
        assert.equal(result.success, false);
        assert.match(result.error, /Unsupported extension/);
    });

    test("rejects a file whose bytes do not match its extension", () => {
        // The failure this catches: an executable renamed to .pdf. Checking the
        // declared type alone would accept it.
        const result = fileFunctions.validate({ filename: "invoice.pdf", base64: b64("this is just text") });
        assert.equal(result.success, false);
        assert.match(result.error, /does not look like a PDF/);
    });

    test("rejects a mime type that contradicts the extension", () => {
        const result = fileFunctions.validate({ filename: "notes.md", mimeType: "application/pdf", base64: b64("# hi") });
        assert.equal(result.success, false);
        assert.match(result.error, /does not match/);
    });

    test("accepts text formats without a signature check", () => {
        // .md and .txt have no magic bytes, so there is nothing to compare.
        assert.equal(fileFunctions.validate({ filename: "faq.md", base64: b64("# FAQ") }).success, true);
        assert.equal(fileFunctions.validate({ filename: "notes.txt", base64: b64("plain") }).success, true);
    });

    test("requires a filename and contents", () => {
        assert.equal(fileFunctions.validate({ filename: "", base64: b64("x") }).success, false);
        assert.equal(fileFunctions.validate({ filename: "a.txt", base64: "" }).success, false);
    });
});

describe("markdown and text extraction", () => {
    test("returns the text verbatim and marks quality full", () => {
        const result = fileFunctions.extract({ filename: "handbook.md", base64: b64("# Refunds\n\nWithin 30 days.") });
        assert.equal(result.success, true);
        assert.equal(result.text, "# Refunds\n\nWithin 30 days.");
        assert.equal(result.extractionQuality, "full");
    });

    test("derives a readable title from the filename", () => {
        const result = fileFunctions.extract({ filename: "support-hours_2026.txt", base64: b64("9 to 5") });
        assert.equal(result.title, "support hours 2026");
    });

    test("rejects an empty file rather than creating an empty source", () => {
        const result = fileFunctions.extract({ filename: "empty.txt", base64: "" });
        assert.equal(result.success, false);
    });
});

describe("CSV extraction", () => {
    test("turns each row into its own headed section", () => {
        // A CSV pasted in as a flat blob chunks into meaningless fragments;
        // per-row sections mean each row is retrievable on its own terms.
        const csv = "Plan,Price,Seats\nStarter,49,3\nGrowth,149,10";
        const result = fileFunctions.extract({ filename: "plans.csv", base64: b64(csv) });

        assert.equal(result.success, true);
        assert.match(result.text, /## Starter/);
        assert.match(result.text, /## Growth/);
        assert.match(result.text, /\*\*Price\*\*: 49/);
        assert.match(result.text, /\*\*Seats\*\*: 10/);
    });

    test("handles quoted fields containing commas and newlines", () => {
        const csv = 'Name,Notes\n"Acme, Inc.","Line one\nLine two"\n';
        const result = fileFunctions.extract({ filename: "customers.csv", base64: b64(csv) });

        assert.equal(result.success, true);
        assert.match(result.text, /## Acme, Inc\./);
        assert.match(result.text, /Line one\nLine two/);
    });

    test("handles escaped double quotes", () => {
        const csv = 'Name,Quote\nMaya,"She said ""hello"" twice"\n';
        const result = fileFunctions.extract({ filename: "quotes.csv", base64: b64(csv) });
        assert.match(result.text, /She said "hello" twice/);
    });

    test("rejects a CSV with headers but no rows", () => {
        const result = fileFunctions.extract({ filename: "empty.csv", base64: b64("Plan,Price\n") });
        assert.equal(result.success, false);
        assert.match(result.error, /no rows/);
    });
});

describe("DOCX extraction", () => {
    test("extracts paragraph text", () => {
        const xml = `<w:document><w:body><w:p><w:r><w:t>Refunds are processed within 5 days.</w:t></w:r></w:p></w:body></w:document>`;
        const result = fileFunctions.extract({ filename: "policy.docx", base64: makeDocx(xml).toString("base64") });

        assert.equal(result.success, true);
        assert.match(result.text, /Refunds are processed within 5 days\./);
        assert.equal(result.extractionQuality, "full");
    });

    test("preserves headings as markdown so headingPath survives chunking", () => {
        // This is the whole reason DOCX extraction reads pStyle: without it a
        // citation reads as a chunk id rather than "Billing › Refunds".
        const xml = `<w:document><w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Billing</w:t></w:r></w:p>
            <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Refunds</w:t></w:r></w:p>
            <w:p><w:r><w:t>Within 30 days.</w:t></w:r></w:p>
        </w:body></w:document>`;
        const result = fileFunctions.extract({ filename: "handbook.docx", base64: makeDocx(xml).toString("base64") });

        assert.match(result.text, /^# Billing$/m);
        assert.match(result.text, /^## Refunds$/m);
        assert.match(result.text, /Within 30 days\./);
    });

    test("joins runs split mid-sentence by Word", () => {
        // Word splits a paragraph into runs at every formatting change, so a
        // naive per-run extraction produces fragments.
        const xml = `<w:document><w:body><w:p>
            <w:r><w:t>Contact </w:t></w:r><w:r><w:t>support</w:t></w:r><w:r><w:t> for help.</w:t></w:r>
        </w:p></w:body></w:document>`;
        const result = fileFunctions.extract({ filename: "a.docx", base64: makeDocx(xml).toString("base64") });
        assert.match(result.text, /Contact support for help\./);
    });

    test("decodes XML entities without double-decoding", () => {
        const xml = `<w:document><w:body><w:p><w:r><w:t>Tom &amp;amp; Jerry &lt;3</w:t></w:r></w:p></w:body></w:document>`;
        const result = fileFunctions.extract({ filename: "a.docx", base64: makeDocx(xml).toString("base64") });
        // &amp;amp; must become &amp; — not &.
        assert.match(result.text, /Tom &amp; Jerry <3/);
    });

    test("rejects a zip that is not a Word document", () => {
        const notWord = makeDocx("<x/>");
        // Rename the entry so word/document.xml is absent.
        const broken = Buffer.from(notWord).toString("base64").replace(/./, "P");
        const result = fileFunctions.extract({ filename: "sheet.docx", base64: broken });
        assert.equal(result.success, false);
    });
});

describe("PDF extraction", () => {
    test("extracts text from a Flate-compressed content stream", () => {
        const pdf = makePdf("BT /F1 12 Tf (Refund policy: 30 days.) Tj ET");
        const result = fileFunctions.extract({ filename: "policy.pdf", base64: pdf.toString("base64") });

        assert.equal(result.success, true);
        assert.match(result.text, /Refund policy: 30 days\./);
    });

    test("extracts from a TJ array, joining the kerned pieces", () => {
        const pdf = makePdf("BT [(Re)-20(fund)-15( policy)] TJ ET");
        const result = fileFunctions.extract({ filename: "a.pdf", base64: pdf.toString("base64") });
        assert.match(result.text, /Refund policy/);
    });

    test("decodes escaped parentheses and octal escapes", () => {
        const pdf = makePdf("BT (Cost \\(USD\\) is \\251 2026) Tj ET");
        const result = fileFunctions.extract({ filename: "a.pdf", base64: pdf.toString("base64") });
        assert.match(result.text, /Cost \(USD\) is/);
    });

    test("reports quality as partial, not full", () => {
        // Said out loud rather than discovered: a scanned or multi-column PDF
        // genuinely will not extract well here.
        const pdf = makePdf("BT (Some text) Tj ET");
        const result = fileFunctions.extract({ filename: "a.pdf", base64: pdf.toString("base64") });
        assert.equal(result.extractionQuality, "partial");
        assert.ok(result.note);
    });

    test("a scanned PDF fails with an actionable message rather than an empty source", () => {
        // No text operators at all — an image-only PDF.
        const pdf = makePdf("q 612 0 0 792 0 0 cm /Im1 Do Q");
        const result = fileFunctions.extract({ filename: "scan.pdf", base64: pdf.toString("base64") });

        assert.equal(result.success, false);
        assert.match(result.error, /scanned/i);
        // The message has to say what to do instead, or the customer just sees
        // a failure with no next step.
        assert.match(result.error, /snippet/i);
    });
});

describe("size limits", () => {
    test("refuses a file over the configured limit", () => {
        const config = require("../config/config");
        const oversized = Buffer.alloc(config.MAX_UPLOAD_BYTES + 1024, 0x41).toString("base64");
        const result = fileFunctions.extract({ filename: "big.txt", base64: oversized });

        assert.equal(result.success, false);
        assert.match(result.error, /limit is/);
    });
});
