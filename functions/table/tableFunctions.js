const Table = require("../../models/table/table");
const TableRow = require("../../models/table/tableRow");
const { ColumnType, IdPrefix } = require("../../config/enums");
const generalFunctions = require("../utilFunctions/generalFunctions");

const MAX_IMPORT_ROWS = 5000;

class TableFunctions {
    // GET /api/org/:orgId/tables
    async listTables({ orgId }) {
        console.log("TableFunctions:listTables: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const tables = await Table.find({ orgId }).sort({ createdAt: -1 });
            return { status: 200, json: { success: true, data: tables, total: tables.length } };
        } catch (error) {
            console.error("TableFunctions:listTables: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/org/:orgId/tables
    async createTable({ orgId, name, description, columns }) {
        console.log("TableFunctions:createTable: orgId:", orgId, "name:", name);
        try {
            if (!orgId || !name || !String(name).trim()) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and name" } };
            }
            const normalized = this._normalizeColumns(columns);
            if (!normalized.success) {
                return { status: 400, json: { success: false, error: normalized.error } };
            }

            const table = await Table.create({
                orgId,
                tableId: generalFunctions.generateId(IdPrefix.TABLE),
                name: String(name).trim(),
                description: String(description || "").trim(),
                columns: normalized.columns,
                rowCount: 0,
            });
            return { status: 201, json: { success: true, data: table } };
        } catch (error) {
            console.error("TableFunctions:createTable: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // GET /api/org/:orgId/tables/:tableId
    async getTable({ orgId, tableId }) {
        console.log("TableFunctions:getTable: orgId:", orgId, "tableId:", tableId);
        try {
            if (!orgId || !tableId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and tableId" } };
            }
            const table = await Table.findOne({ orgId, tableId });
            if (!table) {
                return { status: 404, json: { success: false, error: "Table not found" } };
            }
            return { status: 200, json: { success: true, data: table } };
        } catch (error) {
            console.error("TableFunctions:getTable: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // PATCH /api/org/:orgId/tables/:tableId — name and description only. Changing
    // columns after rows exist would orphan data, so it is a separate concern.
    async updateTable({ orgId, tableId, name, description }) {
        console.log("TableFunctions:updateTable: orgId:", orgId, "tableId:", tableId);
        try {
            if (!orgId || !tableId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and tableId" } };
            }
            if (name !== undefined && !String(name).trim()) {
                return { status: 400, json: { success: false, error: "Table name cannot be empty" } };
            }
            const table = await Table.findOneAndUpdate(
                { orgId, tableId },
                {
                    ...(name !== undefined && { name: String(name).trim() }),
                    ...(description !== undefined && { description: String(description).trim() }),
                },
                { new: true }
            );
            if (!table) {
                return { status: 404, json: { success: false, error: "Table not found" } };
            }
            return { status: 200, json: { success: true, data: table } };
        } catch (error) {
            console.error("TableFunctions:updateTable: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // DELETE /api/org/:orgId/tables/:tableId — rows go with it.
    async deleteTable({ orgId, tableId }) {
        console.log("TableFunctions:deleteTable: orgId:", orgId, "tableId:", tableId);
        try {
            if (!orgId || !tableId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and tableId" } };
            }
            const table = await Table.findOne({ orgId, tableId });
            if (!table) {
                return { status: 404, json: { success: false, error: "Table not found" } };
            }
            const removed = await TableRow.deleteMany({ orgId, tableId });
            await Table.deleteOne({ orgId, tableId });
            console.log("TableFunctions:deleteTable: removed rows:", removed.deletedCount);
            return { status: 200, json: { success: true, data: { tableId, removedRows: removed.deletedCount } } };
        } catch (error) {
            console.error("TableFunctions:deleteTable: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // GET /api/org/:orgId/tables/:tableId/rows
    async listRows({ orgId, tableId, search, page, limit }) {
        console.log("TableFunctions:listRows: orgId:", orgId, "tableId:", tableId);
        try {
            if (!orgId || !tableId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and tableId" } };
            }
            const table = await Table.findOne({ orgId, tableId });
            if (!table) {
                return { status: 404, json: { success: false, error: "Table not found" } };
            }
            const pageNum = Math.max(parseInt(page, 10) || 1, 1);
            const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

            const filter = { orgId, tableId };
            if (search) {
                const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                filter.$or = [
                    { identityValue: { $regex: escaped, $options: "i" } },
                    ...table.columns.map((column) => ({ [`data.${column.name}`]: { $regex: escaped, $options: "i" } })),
                ];
            }

            const [rows, total] = await Promise.all([
                TableRow.find(filter)
                    .sort({ createdAt: -1 })
                    .skip((pageNum - 1) * pageSize)
                    .limit(pageSize),
                TableRow.countDocuments(filter),
            ]);

            return {
                status: 200,
                json: { success: true, data: rows, total, table, page: pageNum, limit: pageSize },
            };
        } catch (error) {
            console.error("TableFunctions:listRows: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/org/:orgId/tables/:tableId/rows
    async createRow({ orgId, tableId, data }) {
        console.log("TableFunctions:createRow: orgId:", orgId, "tableId:", tableId);
        try {
            if (!orgId || !tableId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and tableId" } };
            }
            const table = await Table.findOne({ orgId, tableId });
            if (!table) {
                return { status: 404, json: { success: false, error: "Table not found" } };
            }
            const built = this._buildRow({ table, data });
            if (!built.success) {
                return { status: 400, json: { success: false, error: built.error } };
            }

            // The identity key is how a row is matched to a verified customer.
            // Two rows sharing one makes that lookup ambiguous, so it is rejected
            // rather than silently resolved to whichever sorted first.
            const clash = await TableRow.findOne({ orgId, tableId, identityValue: built.identityValue });
            if (clash) {
                const identityColumn = table.columns.find((column) => column.isIdentityKey);
                return {
                    status: 409,
                    json: {
                        success: false,
                        error: `A row with ${identityColumn.name} "${built.identityLabel}" already exists`,
                    },
                };
            }

            const row = await TableRow.create({
                orgId,
                rowId: generalFunctions.generateId(IdPrefix.TABLE_ROW),
                tableId,
                identityValue: built.identityValue,
                data: built.data,
            });
            await this._syncRowCount({ orgId, tableId });
            return { status: 201, json: { success: true, data: row } };
        } catch (error) {
            console.error("TableFunctions:createRow: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // PATCH /api/org/:orgId/tables/:tableId/rows/:rowId
    async updateRow({ orgId, tableId, rowId, data }) {
        console.log("TableFunctions:updateRow: orgId:", orgId, "rowId:", rowId);
        try {
            if (!orgId || !tableId || !rowId) {
                return {
                    status: 400,
                    json: { success: false, error: "Invalid request. Please pass orgId, tableId and rowId" },
                };
            }
            const table = await Table.findOne({ orgId, tableId });
            if (!table) {
                return { status: 404, json: { success: false, error: "Table not found" } };
            }
            const existing = await TableRow.findOne({ orgId, tableId, rowId });
            if (!existing) {
                return { status: 404, json: { success: false, error: "Row not found" } };
            }

            const merged = { ...existing.data, ...(data || {}) };
            const built = this._buildRow({ table, data: merged });
            if (!built.success) {
                return { status: 400, json: { success: false, error: built.error } };
            }

            // Editing a row into another row's identity would create the same
            // ambiguity a duplicate insert does.
            if (built.identityValue !== existing.identityValue) {
                const clash = await TableRow.findOne({ orgId, tableId, identityValue: built.identityValue });
                if (clash) {
                    const identityColumn = table.columns.find((column) => column.isIdentityKey);
                    return {
                        status: 409,
                        json: {
                            success: false,
                            error: `A row with ${identityColumn.name} "${built.identityLabel}" already exists`,
                        },
                    };
                }
            }

            const row = await TableRow.findOneAndUpdate(
                { orgId, tableId, rowId },
                { data: built.data, identityValue: built.identityValue },
                { new: true }
            );
            return { status: 200, json: { success: true, data: row } };
        } catch (error) {
            console.error("TableFunctions:updateRow: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // DELETE /api/org/:orgId/tables/:tableId/rows/:rowId
    async deleteRow({ orgId, tableId, rowId }) {
        console.log("TableFunctions:deleteRow: orgId:", orgId, "rowId:", rowId);
        try {
            if (!orgId || !tableId || !rowId) {
                return {
                    status: 400,
                    json: { success: false, error: "Invalid request. Please pass orgId, tableId and rowId" },
                };
            }
            const removed = await TableRow.deleteOne({ orgId, tableId, rowId });
            if (removed.deletedCount === 0) {
                return { status: 404, json: { success: false, error: "Row not found" } };
            }
            await this._syncRowCount({ orgId, tableId });
            return { status: 200, json: { success: true, data: { rowId } } };
        } catch (error) {
            console.error("TableFunctions:deleteRow: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/org/:orgId/tables/:tableId/import — CSV whose header row names
    // the columns. Rows that fail validation are reported, not silently dropped.
    async importRows({ orgId, tableId, csv }) {
        console.log("TableFunctions:importRows: orgId:", orgId, "tableId:", tableId);
        try {
            if (!orgId || !tableId || !csv) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId, tableId and csv" } };
            }
            const table = await Table.findOne({ orgId, tableId });
            if (!table) {
                return { status: 404, json: { success: false, error: "Table not found" } };
            }

            const parsed = this._parseCsv(csv);
            if (!parsed.success) {
                return { status: 400, json: { success: false, error: parsed.error } };
            }
            if (parsed.rows.length > MAX_IMPORT_ROWS) {
                return {
                    status: 400,
                    json: { success: false, error: `Import is limited to ${MAX_IMPORT_ROWS} rows per file` },
                };
            }

            // Re-importing a corrected export should fix rows, not duplicate
            // them, so the identity key drives an upsert.
            const existing = await TableRow.find({ orgId, tableId }).select("rowId identityValue").lean();
            const existingByIdentity = new Map(existing.map((row) => [row.identityValue, row.rowId]));

            const docs = [];
            const updates = [];
            const skipped = [];
            const seen = new Set();

            parsed.rows.forEach((record, index) => {
                const built = this._buildRow({ table, data: record });
                if (!built.success) {
                    skipped.push({ line: index + 2, reason: built.error });
                    return;
                }
                if (seen.has(built.identityValue)) {
                    skipped.push({ line: index + 2, reason: `duplicate identity "${built.identityLabel}" in this file` });
                    return;
                }
                seen.add(built.identityValue);

                const existingRowId = existingByIdentity.get(built.identityValue);
                if (existingRowId) {
                    updates.push({
                        updateOne: {
                            filter: { orgId, tableId, rowId: existingRowId },
                            update: { $set: { data: built.data } },
                        },
                    });
                    return;
                }
                docs.push({
                    orgId,
                    rowId: generalFunctions.generateId(IdPrefix.TABLE_ROW),
                    tableId,
                    identityValue: built.identityValue,
                    data: built.data,
                });
            });

            if (docs.length > 0) await TableRow.insertMany(docs);
            if (updates.length > 0) await TableRow.bulkWrite(updates);
            await this._syncRowCount({ orgId, tableId });
            console.log(
                "TableFunctions:importRows: imported:",
                docs.length,
                "updated:",
                updates.length,
                "skipped:",
                skipped.length
            );

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        imported: docs.length,
                        updated: updates.length,
                        skipped: skipped.slice(0, 20),
                        skippedCount: skipped.length,
                    },
                },
            };
        } catch (error) {
            console.error("TableFunctions:importRows: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Exactly one identity column — it is what matches a row to a verified end
    // user, so a table without one can never be read safely.
    _normalizeColumns(columns) {
        if (!Array.isArray(columns) || columns.length === 0) {
            return { success: false, error: "Add at least one column" };
        }
        const seen = new Set();
        const normalized = [];
        for (const column of columns) {
            const name = String(column?.name || "").trim();
            if (!name) return { success: false, error: "Every column needs a name" };
            const key = name.toLowerCase();
            if (seen.has(key)) return { success: false, error: `Duplicate column "${name}"` };
            seen.add(key);
            const type = Object.values(ColumnType).includes(column?.type) ? column.type : ColumnType.STRING;
            normalized.push({ name, type, isIdentityKey: Boolean(column?.isIdentityKey) });
        }
        const identityCount = normalized.filter((column) => column.isIdentityKey).length;
        if (identityCount === 0) {
            normalized[0].isIdentityKey = true;
        } else if (identityCount > 1) {
            return { success: false, error: "Exactly one column can be the identity key" };
        }
        return { success: true, columns: normalized };
    }

    // Coerces an incoming record to the table's declared shape and pulls out the
    // identity value. Unknown keys are dropped rather than stored.
    _buildRow({ table, data }) {
        if (!data || typeof data !== "object") {
            return { success: false, error: "Row data must be an object" };
        }
        const clean = {};
        for (const column of table.columns) {
            const raw = data[column.name];
            if (raw === undefined || raw === null || raw === "") {
                clean[column.name] = "";
                continue;
            }
            if (column.type === ColumnType.NUMBER) {
                const value = Number(raw);
                if (Number.isNaN(value)) {
                    return { success: false, error: `"${column.name}" must be a number` };
                }
                clean[column.name] = value;
            } else if (column.type === ColumnType.BOOLEAN) {
                clean[column.name] = ["true", "1", "yes", true].includes(
                    typeof raw === "string" ? raw.toLowerCase() : raw
                );
            } else if (column.type === ColumnType.DATE) {
                const value = new Date(raw);
                if (Number.isNaN(value.getTime())) {
                    return { success: false, error: `"${column.name}" must be a date` };
                }
                clean[column.name] = value.toISOString();
            } else {
                clean[column.name] = String(raw);
            }
        }

        const identityColumn = table.columns.find((column) => column.isIdentityKey);
        const identityValue = String(clean[identityColumn.name] ?? "").trim();
        if (!identityValue) {
            return { success: false, error: `"${identityColumn.name}" is the identity key and cannot be empty` };
        }
        // Matching is case-insensitive, but messages echo what the author typed
        // rather than the normalized form.
        return { success: true, data: clean, identityValue: identityValue.toLowerCase(), identityLabel: identityValue };
    }

    // rowCount is denormalized for the list view; recount rather than increment
    // so it can never drift from the collection.
    async _syncRowCount({ orgId, tableId }) {
        const rowCount = await TableRow.countDocuments({ orgId, tableId });
        await Table.updateOne({ orgId, tableId }, { rowCount });
        return { success: true, rowCount };
    }

    // Minimal RFC-4180 reader: quoted fields, escaped quotes, CRLF or LF.
    _parseCsv(text) {
        const rows = [];
        let field = "";
        let record = [];
        let inQuotes = false;
        const source = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

        for (let i = 0; i < source.length; i += 1) {
            const char = source[i];
            if (inQuotes) {
                if (char === '"') {
                    if (source[i + 1] === '"') {
                        field += '"';
                        i += 1;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += char;
                }
            } else if (char === '"') {
                inQuotes = true;
            } else if (char === ",") {
                record.push(field);
                field = "";
            } else if (char === "\n") {
                record.push(field);
                rows.push(record);
                record = [];
                field = "";
            } else {
                field += char;
            }
        }
        if (field !== "" || record.length > 0) {
            record.push(field);
            rows.push(record);
        }

        const nonEmpty = rows.filter((row) => row.some((cell) => String(cell).trim() !== ""));
        if (nonEmpty.length < 2) {
            return { success: false, error: "CSV needs a header row and at least one data row" };
        }

        const header = nonEmpty[0].map((cell) => String(cell).trim());
        const records = nonEmpty.slice(1).map((row) => {
            const record = {};
            header.forEach((name, index) => {
                record[name] = row[index] !== undefined ? String(row[index]).trim() : "";
            });
            return record;
        });
        return { success: true, rows: records, header };
    }
}

module.exports = new TableFunctions();
