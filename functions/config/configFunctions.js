const { PublishState, ConfigObjectType, AuditAction, IdPrefix } = require("../../config/enums");
const ConfigVersion = require("../../models/config/configVersion");
const generalFunctions = require("../utilFunctions/generalFunctions");
const auditFunctions = require("../audit/auditFunctions");
const { getEntry, isProtected } = require("./configRegistry");

// Generic CRUD, draft/live and version history for every configuration object
// (§2.1–§2.5). Registry-driven: see configRegistry.js for what varies per type.
//
// The two properties worth stating outright, because everything else here
// follows from them:
//
//   1. A DRAFT object never reaches production traffic. Every read on the hot
//      path filters `publishState: LIVE, enabled: true`, and the only way into
//      that state is publish(), which is an explicit action.
//   2. Editing a LIVE object drops it back to DRAFT. Otherwise "Save" silently
//      ships to customers, which is the exact thing draft/live exists to stop.
//      An edit that should go live immediately is Save then Publish — two
//      clicks, and the second one is the one that means something.

const MAX_VERSIONS_RETURNED = 50;

class ConfigFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async list({ orgId, objectType, publishState }) {
        console.log("ConfigFunctions:list: orgId:", orgId, "type:", objectType);
        try {
            const entry = getEntry(objectType);
            if (!entry) return { status: 400, json: { success: false, error: "Unknown configuration type" } };

            const query = { orgId };
            if (publishState && Object.values(PublishState).includes(publishState)) {
                query.publishState = publishState;
            }
            const documents = await entry.Model.find(query).sort({ createdAt: 1 }).lean();
            return { status: 200, json: { success: true, data: documents.map(this._strip) } };
        } catch (error) {
            console.error("ConfigFunctions:list: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async get({ orgId, objectType, objectId }) {
        console.log("ConfigFunctions:get: orgId:", orgId, "objectId:", objectId);
        try {
            const entry = getEntry(objectType);
            if (!entry) return { status: 400, json: { success: false, error: "Unknown configuration type" } };

            const document = await entry.Model.findOne({ orgId, [entry.idField]: objectId }).lean();
            if (!document) return { status: 404, json: { success: false, error: `${entry.label} not found` } };

            return { status: 200, json: { success: true, data: this._strip(document) } };
        } catch (error) {
            console.error("ConfigFunctions:get: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Always created as a DRAFT. A new rule that took effect the moment it was
    // typed would mean there is no way to write one without shipping it.
    async create({ orgId, objectType, body, actorEmail }) {
        console.log("ConfigFunctions:create: orgId:", orgId, "type:", objectType);
        try {
            const entry = getEntry(objectType);
            if (!entry) return { status: 400, json: { success: false, error: "Unknown configuration type" } };

            const validation = entry.validate({ body: body || {} });
            if (!validation.success) return { status: 400, json: { success: false, error: validation.error } };

            const objectId = generalFunctions.generateId(entry.idPrefix);
            const document = await entry.Model.create({
                orgId,
                [entry.idField]: objectId,
                ...this._pick(body, entry.fields),
                ...this._pickShared(body),
                publishState: PublishState.DRAFT,
                version: 1,
                updatedBy: actorEmail || null,
            });

            return { status: 201, json: { success: true, data: this._strip(document.toJSON()) } };
        } catch (error) {
            console.error("ConfigFunctions:create: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async update({ orgId, objectType, objectId, body, actorEmail }) {
        console.log("ConfigFunctions:update: orgId:", orgId, "objectId:", objectId);
        try {
            const entry = getEntry(objectType);
            if (!entry) return { status: 400, json: { success: false, error: "Unknown configuration type" } };

            const existing = await entry.Model.findOne({ orgId, [entry.idField]: objectId });
            if (!existing) return { status: 404, json: { success: false, error: `${entry.label} not found` } };

            // Merge before validating, so a PATCH of one field is checked
            // against the whole resulting object rather than against itself.
            const merged = { ...existing.toObject(), ...this._pick(body, entry.fields) };
            const validation = entry.validate({ body: merged });
            if (!validation.success) return { status: 400, json: { success: false, error: validation.error } };

            await this._snapshot({ orgId, objectType, objectId, document: existing, actorEmail, note: "edited" });

            Object.assign(existing, this._pick(body, entry.fields), this._pickShared(body));
            existing.version += 1;
            existing.updatedBy = actorEmail || null;
            // See the header note: an edit to a live object un-publishes it.
            const wasLive = existing.publishState === PublishState.LIVE;
            if (wasLive) existing.publishState = PublishState.DRAFT;
            await existing.save();

            return {
                status: 200,
                json: {
                    success: true,
                    data: this._strip(existing.toJSON()),
                    // Said out loud rather than left for the customer to notice
                    // when the change does not appear in production.
                    unpublished: wasLive,
                },
            };
        } catch (error) {
            console.error("ConfigFunctions:update: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Publish and enable are separate on purpose (§2.4): publishing decides
    // whether production can see the object at all, enabling decides whether it
    // is currently switched on. Pausing a live rule for an afternoon should not
    // require re-publishing it afterwards.
    async publish({ orgId, objectType, objectId, enabled, actorEmail }) {
        console.log("ConfigFunctions:publish: orgId:", orgId, "objectId:", objectId);
        try {
            const entry = getEntry(objectType);
            if (!entry) return { status: 400, json: { success: false, error: "Unknown configuration type" } };

            const document = await entry.Model.findOne({ orgId, [entry.idField]: objectId });
            if (!document) return { status: 404, json: { success: false, error: `${entry.label} not found` } };

            await this._snapshot({ orgId, objectType, objectId, document, actorEmail, note: "published" });

            document.publishState = PublishState.LIVE;
            document.enabled = enabled === false ? false : true;
            document.updatedBy = actorEmail || null;
            await document.save();

            await auditFunctions.record({
                orgId,
                action: AuditAction.CONFIG_PUBLISHED,
                actorEmail,
                targetType: objectType,
                targetId: objectId,
                detail: { enabled: document.enabled },
            });

            return { status: 200, json: { success: true, data: this._strip(document.toJSON()) } };
        } catch (error) {
            console.error("ConfigFunctions:publish: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async unpublish({ orgId, objectType, objectId, actorEmail }) {
        console.log("ConfigFunctions:unpublish: orgId:", orgId, "objectId:", objectId);
        try {
            const entry = getEntry(objectType);
            if (!entry) return { status: 400, json: { success: false, error: "Unknown configuration type" } };

            const document = await entry.Model.findOne({ orgId, [entry.idField]: objectId });
            if (!document) return { status: 404, json: { success: false, error: `${entry.label} not found` } };

            await this._snapshot({ orgId, objectType, objectId, document, actorEmail, note: "unpublished" });
            document.publishState = PublishState.DRAFT;
            document.enabled = false;
            document.updatedBy = actorEmail || null;
            await document.save();

            return { status: 200, json: { success: true, data: this._strip(document.toJSON()) } };
        } catch (error) {
            console.error("ConfigFunctions:unpublish: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async remove({ orgId, objectType, objectId, actorEmail }) {
        console.log("ConfigFunctions:remove: orgId:", orgId, "objectId:", objectId);
        try {
            const entry = getEntry(objectType);
            if (!entry) return { status: 400, json: { success: false, error: "Unknown configuration type" } };

            const document = await entry.Model.findOne({ orgId, [entry.idField]: objectId });
            if (!document) return { status: 404, json: { success: false, error: `${entry.label} not found` } };

            if (isProtected({ objectType, document })) {
                return {
                    status: 400,
                    json: { success: false, error: "Built-in attributes can be disabled but not deleted" },
                };
            }

            // Snapshot before deleting: the version log is the only way back,
            // and a delete is exactly when someone wants one.
            await this._snapshot({ orgId, objectType, objectId, document, actorEmail, note: "deleted" });
            await entry.Model.deleteOne({ orgId, [entry.idField]: objectId });

            return { status: 200, json: { success: true, data: { deleted: objectId } } };
        } catch (error) {
            console.error("ConfigFunctions:remove: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async listVersions({ orgId, objectType, objectId }) {
        console.log("ConfigFunctions:listVersions: objectId:", objectId);
        try {
            const versions = await ConfigVersion.find({ orgId, objectType, objectId })
                .sort({ version: -1 })
                .limit(MAX_VERSIONS_RETURNED)
                .lean();
            return {
                status: 200,
                json: {
                    success: true,
                    data: versions.map((version) => ({
                        versionId: version.versionId,
                        version: version.version,
                        note: version.note,
                        changedBy: version.changedBy,
                        createdAt: version.createdAt,
                        snapshot: this._strip(version.snapshot),
                    })),
                },
            };
        } catch (error) {
            console.error("ConfigFunctions:listVersions: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Restore writes the old body onto the current document and bumps the
    // version forward — it never rewinds the counter. History stays append-only,
    // so "restored to v3" is itself v9 and the trail of what happened survives.
    //
    // The restored object lands in DRAFT for the same reason an edit does.
    async restore({ orgId, objectType, objectId, version, actorEmail }) {
        console.log("ConfigFunctions:restore: objectId:", objectId, "version:", version);
        try {
            const entry = getEntry(objectType);
            if (!entry) return { status: 400, json: { success: false, error: "Unknown configuration type" } };

            const target = await ConfigVersion.findOne({ orgId, objectType, objectId, version: Number(version) }).lean();
            if (!target) return { status: 404, json: { success: false, error: "Version not found" } };

            const document = await entry.Model.findOne({ orgId, [entry.idField]: objectId });
            if (!document) return { status: 404, json: { success: false, error: `${entry.label} not found` } };

            await this._snapshot({
                orgId,
                objectType,
                objectId,
                document,
                actorEmail,
                note: `replaced by restore of v${version}`,
            });

            Object.assign(document, this._pick(target.snapshot, entry.fields));
            document.version += 1;
            document.publishState = PublishState.DRAFT;
            document.enabled = false;
            document.updatedBy = actorEmail || null;
            await document.save();

            await auditFunctions.record({
                orgId,
                action: AuditAction.CONFIG_RESTORED,
                actorEmail,
                targetType: objectType,
                targetId: objectId,
                detail: { restoredFrom: Number(version) },
            });

            return { status: 200, json: { success: true, data: this._strip(document.toJSON()) } };
        } catch (error) {
            console.error("ConfigFunctions:restore: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // Best-effort. A version row that could not be written must not block the
    // edit the customer is trying to make — losing one line of history is a
    // smaller failure than a save that returns 500.
    async _snapshot({ orgId, objectType, objectId, document, actorEmail, note }) {
        try {
            const snapshot = typeof document.toObject === "function" ? document.toObject() : document;
            delete snapshot._id;
            delete snapshot.__v;
            await ConfigVersion.create({
                orgId,
                versionId: generalFunctions.generateId(IdPrefix.CONFIG_VERSION),
                objectType,
                objectId,
                version: snapshot.version || 1,
                snapshot,
                changedBy: actorEmail || null,
                note: note || "",
            });
            return { success: true };
        } catch (error) {
            console.error("ConfigFunctions:_snapshot: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }

    // Allowlist copy. See configRegistry.js for why this is not a denylist.
    _pick(source, fields) {
        const picked = {};
        if (!source) return picked;
        for (const field of fields) {
            if (source[field] !== undefined) picked[field] = source[field];
        }
        return picked;
    }

    // Fields every publishable object shares. `publishState`, `version` and
    // `stats` are deliberately absent: those are set by publish(), by save, and
    // by cron respectively, and a client that could write them could fake its
    // own attribution numbers.
    _pickShared(source) {
        const picked = {};
        if (!source) return picked;
        if (source.channels !== undefined) picked.channels = source.channels;
        if (source.audience !== undefined) picked.audience = source.audience;
        return picked;
    }

    _strip(document) {
        if (!document) return document;
        const copy = { ...document };
        delete copy._id;
        delete copy.__v;
        return copy;
    }
}

module.exports = new ConfigFunctions();
module.exports.MAX_VERSIONS_RETURNED = MAX_VERSIONS_RETURNED;
