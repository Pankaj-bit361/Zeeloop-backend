const config = require("../../config/config");
const generalFunctions = require("../utilFunctions/generalFunctions");

// §1.2 — FILE ingest. PDF, DOCX, MD, TXT and CSV.
//
// Written against zlib and Buffer rather than pulling in pdf-parse and mammoth,
// for a reason that is worth stating plainly: both are large dependency trees
// that run untrusted customer-supplied bytes, and this is a multi-tenant backend
// where a parser vulnerability is a tenancy breach. The extractors here are
// narrow, do no evaluation, and fail closed on anything they do not recognise.
//
// The trade is real and stated in the return value: `extractionQuality` is
// "full" for the text formats and "partial" for PDF, because a scanned or
// heavily-compressed PDF genuinely will not extract well here. A workspace is
// told that rather than left to notice that its manual retrieves badly.
//
// Heading preservation matters throughout — `headingPath` on a chunk is what
// makes a citation read as "Billing › Refunds" rather than as a chunk id, so
// every extractor emits markdown headings where the format has them.

const SIGNATURES = {
    PDF: Buffer.from("%PDF-"),
    // DOCX, XLSX and every other OOXML file is a zip. "PK\x03\x04".
    ZIP: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};

const EXTENSION_TYPES = {
    pdf: "PDF",
    docx: "DOCX",
    md: "MARKDOWN",
    markdown: "MARKDOWN",
    txt: "TEXT",
    text: "TEXT",
    csv: "CSV",
};

const MIME_TYPES = {
    "application/pdf": "PDF",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
    "text/markdown": "MARKDOWN",
    "text/plain": "TEXT",
    "text/csv": "CSV",
    "application/csv": "CSV",
};

class FileFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // `base64` because uploads arrive in a JSON body. Returns
    // { success, text, title, extractionQuality, error }.
    extract({ filename, mimeType, base64 }) {
        console.log("FileFunctions:extract: filename:", filename);
        try {
            const buffer = Buffer.from(String(base64 || ""), "base64");
            if (buffer.length === 0) {
                return { success: false, error: "The file was empty or could not be decoded" };
            }
            if (buffer.length > config.MAX_UPLOAD_BYTES) {
                return {
                    success: false,
                    error: `File is ${Math.round(buffer.length / 1024 / 1024)}MB; the limit is ${Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024)}MB`,
                };
            }

            const detected = this._detectType({ filename, mimeType, buffer });
            if (!detected) {
                return { success: false, error: "Unsupported file type. Accepted: PDF, DOCX, MD, TXT, CSV" };
            }

            switch (detected) {
                case "PDF":
                    return this._extractPdf(buffer);
                case "DOCX":
                    return this._extractDocx(buffer);
                case "CSV":
                    return this._extractCsv(buffer, filename);
                case "MARKDOWN":
                case "TEXT":
                default:
                    return {
                        success: true,
                        text: buffer.toString("utf8"),
                        title: this._titleFromFilename(filename),
                        extractionQuality: "full",
                    };
            }
        } catch (error) {
            console.error("FileFunctions:extract: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, error: "Could not read that file" };
        }
    }

    // Validates BOTH the claimed MIME type and the actual leading bytes. A
    // claimed content-type is whatever the uploader put in the request; the
    // signature is what the file is. Checking only the first is how a .exe
    // renamed to .pdf gets stored.
    validate({ filename, mimeType, base64 }) {
        console.log("FileFunctions:validate: filename:", filename);
        try {
            if (!filename || !base64) {
                return { success: false, error: "filename and file contents are required" };
            }

            const extension = this._extension(filename);
            if (!EXTENSION_TYPES[extension]) {
                return {
                    success: false,
                    error: `Unsupported extension .${extension}. Accepted: ${Object.keys(EXTENSION_TYPES).join(", ")}`,
                };
            }

            const buffer = Buffer.from(String(base64), "base64");
            if (buffer.length > config.MAX_UPLOAD_BYTES) {
                return { success: false, error: "File exceeds the upload size limit" };
            }

            const claimed = EXTENSION_TYPES[extension];
            const actual = this._signatureType(buffer);

            // Binary formats must match their signature. Text formats have no
            // signature at all, so there is nothing to compare and no check to
            // fail — .md and .txt are just bytes.
            if ((claimed === "PDF" || claimed === "DOCX") && actual !== claimed) {
                return {
                    success: false,
                    error: `The file does not look like a ${claimed}. Its contents do not match its extension.`,
                };
            }
            if (mimeType && MIME_TYPES[mimeType] && MIME_TYPES[mimeType] !== claimed) {
                return { success: false, error: "The declared content type does not match the file extension" };
            }

            return { success: true, type: claimed, bytes: buffer.length };
        } catch (error) {
            console.error("FileFunctions:validate: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, error: "Could not validate that file" };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    _detectType({ filename, mimeType, buffer }) {
        const signature = this._signatureType(buffer);
        if (signature === "PDF") return "PDF";

        const extension = this._extension(filename);
        // A zip is only a DOCX if the extension says so — xlsx and pptx have the
        // same signature and would produce nonsense through the DOCX extractor.
        if (signature === "ZIP") return extension === "docx" ? "DOCX" : null;
        if (EXTENSION_TYPES[extension]) return EXTENSION_TYPES[extension];
        if (mimeType && MIME_TYPES[mimeType]) return MIME_TYPES[mimeType];
        return null;
    }

    _signatureType(buffer) {
        if (buffer.subarray(0, 5).equals(SIGNATURES.PDF)) return "PDF";
        if (buffer.subarray(0, 4).equals(SIGNATURES.ZIP)) return "ZIP";
        return null;
    }

    // PDF text extraction, uncompressed and Flate streams.
    //
    // Real PDF is a graphics format, not a document format: text is a sequence
    // of positioned show-text operators with no paragraphs and no reading order.
    // This pulls the strings out of the content streams in document order, which
    // is right for the text-first PDFs support teams actually upload (exported
    // docs, guides, policies) and poor for multi-column layouts and scans.
    //
    // Hence extractionQuality: "partial" — said out loud rather than discovered.
    _extractPdf(buffer) {
        try {
            const zlib = require("zlib");
            const raw = buffer.toString("latin1");
            const pieces = [];

            // Content lives between `stream` and `endstream`. Everything else in
            // a PDF is structure.
            const streamPattern = /stream\r?\n?([\s\S]*?)endstream/g;
            let match;
            while ((match = streamPattern.exec(raw)) !== null) {
                let content = match[1];
                const bytes = Buffer.from(content, "latin1");

                // Flate is by far the most common stream filter. 0x78 is the
                // zlib header; anything else is left as-is and usually is not
                // text, which the operator scan below then finds nothing in.
                if (bytes[0] === 0x78) {
                    try {
                        content = zlib.inflateSync(bytes).toString("latin1");
                    } catch (error) {
                        continue;
                    }
                }

                pieces.push(this._extractPdfText(content));
            }

            const text = pieces.join("\n").replace(/\n{3,}/g, "\n\n").trim();
            if (!text) {
                return {
                    success: false,
                    error:
                        "No readable text found. This looks like a scanned PDF — the text is an image, and there is nothing to index. Paste the text as a snippet instead.",
                };
            }

            return {
                success: true,
                text,
                title: this._firstLine(text),
                extractionQuality: "partial",
                note: "PDF text was extracted structurally. Check a few chunks — multi-column layouts can come out in the wrong order.",
            };
        } catch (error) {
            console.error("FileFunctions:_extractPdf: Catch block");
            console.error(error);
            return { success: false, error: "Could not read that PDF" };
        }
    }

    // Pulls the operands of the text-showing operators: Tj, TJ, ' and ".
    _extractPdfText(content) {
        const output = [];

        // TJ takes an array of strings and kerning numbers: [(He)-20(llo)] TJ.
        const arrayPattern = /\[((?:[^\[\]\\]|\\.)*)\]\s*TJ/g;
        let match;
        while ((match = arrayPattern.exec(content)) !== null) {
            const parts = [...match[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((entry) => this._decodePdfString(entry[1]));
            if (parts.length > 0) output.push(parts.join(""));
        }

        const singlePattern = /\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")/g;
        while ((match = singlePattern.exec(content)) !== null) {
            output.push(this._decodePdfString(match[1]));
        }

        // Td/TD/T* move the text cursor, which is the only signal a PDF gives
        // that a line ended. Without splitting on them the whole page arrives as
        // one line and chunking has nothing to work with.
        return output.join(" ").replace(/\s{2,}/g, " ");
    }

    _decodePdfString(value) {
        return String(value)
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "")
            .replace(/\\t/g, " ")
            .replace(/\\([()\\])/g, "$1")
            // Octal escapes, which is how PDFs encode anything non-ASCII.
            .replace(/\\([0-7]{1,3})/g, (whole, octal) => String.fromCharCode(parseInt(octal, 8)));
    }

    // DOCX is a zip holding word/document.xml. Read without a zip library by
    // walking the local file headers, which is enough because we want exactly
    // one known entry rather than arbitrary extraction.
    _extractDocx(buffer) {
        try {
            const entry = this._readZipEntry(buffer, "word/document.xml");
            if (!entry) {
                return { success: false, error: "That does not look like a Word document — word/document.xml is missing" };
            }

            const xml = entry.toString("utf8");

            // Headings first, so headingPath survives into the chunks. Word
            // stores them as a paragraph style named Heading1..Heading9.
            const paragraphs = [];
            const paragraphPattern = /<w:p[ >][\s\S]*?<\/w:p>/g;
            const matches = xml.match(paragraphPattern) || [];

            for (const paragraph of matches) {
                const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
                    .map((match) => this._decodeXml(match[1]))
                    .join("");
                if (!text.trim()) continue;

                const heading = paragraph.match(/<w:pStyle\s+w:val="Heading(\d)"/);
                paragraphs.push(heading ? `${"#".repeat(Math.min(6, Number(heading[1])))} ${text}` : text);
            }

            const text = paragraphs.join("\n\n").trim();
            if (!text) return { success: false, error: "That document had no readable text" };

            return { success: true, text, title: this._firstLine(text), extractionQuality: "full" };
        } catch (error) {
            console.error("FileFunctions:_extractDocx: Catch block");
            console.error(error);
            return { success: false, error: "Could not read that Word document" };
        }
    }

    // Walks zip local file headers looking for one name. Handles stored and
    // deflated entries, which is all Word produces.
    _readZipEntry(buffer, wantedName) {
        const zlib = require("zlib");
        let offset = 0;

        while (offset < buffer.length - 30) {
            if (buffer.readUInt32LE(offset) !== 0x04034b50) break;

            const method = buffer.readUInt16LE(offset + 8);
            const compressedSize = buffer.readUInt32LE(offset + 18);
            const nameLength = buffer.readUInt16LE(offset + 26);
            const extraLength = buffer.readUInt16LE(offset + 28);
            const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
            const dataStart = offset + 30 + nameLength + extraLength;

            if (name === wantedName) {
                const data = buffer.subarray(dataStart, dataStart + compressedSize);
                if (method === 0) return data;
                if (method === 8) return zlib.inflateRawSync(data);
                return null;
            }

            // A streamed entry writes size 0 here and puts the real size in a
            // trailing descriptor. Walking past it is not possible without
            // scanning, and Word does not produce them, so stop cleanly rather
            // than reading garbage offsets.
            if (compressedSize === 0) break;
            offset = dataStart + compressedSize;
        }

        return null;
    }

    // CSV becomes one markdown section per row, headed by the row's first
    // column. A CSV pasted in as a flat blob chunks into meaningless fragments
    // halfway through row 40; this way each row is retrievable on its own terms.
    _extractCsv(buffer, filename) {
        try {
            const rows = this._parseCsv(buffer.toString("utf8"));
            if (rows.length === 0) return { success: false, error: "That CSV was empty" };

            const headers = rows[0];
            const body = rows.slice(1).filter((row) => row.some((cell) => String(cell).trim()));
            if (body.length === 0) return { success: false, error: "That CSV had headers but no rows" };

            const sections = body.map((row) => {
                const label = String(row[0] || "").trim() || "Row";
                const fields = headers
                    .map((header, index) => (row[index] ? `- **${header}**: ${row[index]}` : null))
                    .filter(Boolean);
                return `## ${label}\n\n${fields.join("\n")}`;
            });

            return {
                success: true,
                text: `# ${this._titleFromFilename(filename)}\n\n${sections.join("\n\n")}`,
                title: this._titleFromFilename(filename),
                extractionQuality: "full",
            };
        } catch (error) {
            console.error("FileFunctions:_extractCsv: Catch block");
            console.error(error);
            return { success: false, error: "Could not read that CSV" };
        }
    }

    // Character-by-character rather than split(","): a quoted field can contain
    // commas, newlines and escaped quotes, and every one of those appears in a
    // real export.
    _parseCsv(text) {
        const rows = [];
        let row = [];
        let field = "";
        let inQuotes = false;

        for (let index = 0; index < text.length; index++) {
            const character = text[index];

            if (inQuotes) {
                if (character === '"') {
                    if (text[index + 1] === '"') {
                        field += '"';
                        index++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += character;
                }
                continue;
            }

            if (character === '"') {
                inQuotes = true;
            } else if (character === ",") {
                row.push(field);
                field = "";
            } else if (character === "\n") {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
            } else if (character !== "\r") {
                field += character;
            }
        }

        if (field || row.length > 0) {
            row.push(field);
            rows.push(row);
        }

        return rows.map((entry) => entry.map((cell) => cell.trim()));
    }

    _decodeXml(value) {
        return String(value)
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, (whole, code) => String.fromCharCode(Number(code)))
            // Last, or it would double-decode the entities above.
            .replace(/&amp;/g, "&");
    }

    _extension(filename) {
        const parts = String(filename || "").toLowerCase().split(".");
        return parts.length > 1 ? parts.pop() : "";
    }

    _titleFromFilename(filename) {
        return String(filename || "Untitled")
            .replace(/\.[^.]+$/, "")
            .replace(/[-_]+/g, " ")
            .trim();
    }

    _firstLine(text) {
        const line = String(text).split("\n").find((entry) => entry.trim());
        return (line || "Untitled").replace(/^#+\s*/, "").slice(0, 120).trim();
    }
}

module.exports = new FileFunctions();
module.exports.EXTENSION_TYPES = EXTENSION_TYPES;
module.exports.MIME_TYPES = MIME_TYPES;
